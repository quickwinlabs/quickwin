# QuickJS GC 工作原理

## 概述

QuickJS 的垃圾回收采用 **引用计数 + 标记清除** 混合策略：

- **引用计数**：通过 `JS_DupValue` / `JS_FreeValue` 管理绝大多数生命周期，ref_count 降到 0 的对象立即进入 `gc_zero_ref_count_list` 并释放
- **标记清除**：专门处理**不可达的循环引用**（纯引用计数无法解决的场景），仅在必要时触发

## GC 对象

所有参与 GC 的对象头部：

```c
typedef struct JSGCObjectHeader {
    int ref_count;          // 引用计数
    uint8_t mark;           // GC 过程中的标记位
    uint8_t gc_obj_type;    // 对象类型枚举
    struct list_head link;  // 链接到某个链表
} JSGCObjectHeader;
```

`JSRuntime` 维护的关键链表：

| 链表 | 用途 |
|------|------|
| `gc_obj_list` | 所有存活 GC 对象的全局列表 |
| `gc_zero_ref_count_list` | 引用计数降为 0 的对象（待释放） |
| `tmp_obj_list` | GC 执行期间临时存放候选回收对象 |
| `weakref_list` | 弱引用对象列表 |

## 触发时机

GC 的触发点在 `__JS_FreeValueRT`（`quickjs.c:6071`）：

```c
void __JS_FreeValueRT(JSRuntime *rt, JSValue v)
{
    ...
    case JS_TAG_OBJECT:
    case JS_TAG_FUNCTION_BYTECODE:
    case JS_TAG_MODULE:
        {
            JSGCObjectHeader *p = JS_VALUE_GET_PTR(v);
            if (rt->gc_phase != JS_GC_PHASE_REMOVE_CYCLES) {
                // 从 gc_obj_list 摘下，挂入 gc_zero_ref_count_list
                list_del(&p->link);
                list_add(&p->link, &rt->gc_zero_ref_count_list);
                p->mark = 1;  // 标记为"即将释放"
                if (rt->gc_phase == JS_GC_PHASE_NONE) {
                    free_zero_refcount(rt);  // 非 GC 期间：立即释放
                }
                // GC 期间：等待 gc_free_cycles 统一处理
            }
        }
        break;
}
```

当对象的引用计数降为 0 时：
1. **不在 GC 执行期间**（`gc_phase == JS_GC_PHASE_NONE`）：直接入 `gc_zero_ref_count_list` 并调用 `free_zero_refcount` 立即释放
2. **在 GC 执行期间**（`gc_phase != JS_GC_PHASE_NONE`）：入 `gc_zero_ref_count_list` 等待 GC 完成后再处理

GC 的完整触发条件也在 `__JS_FreeValueRT` 附近的逻辑中（`quickjs.c:6071`）：

```c
// 在 free_zero_refcount 等路径中，会检查：
if (rt->gc_obj_count <= rt->gc_threshold) {
    JS_RunGC(rt);
}
```

- 每次释放对象时递减 `gc_obj_count`
- 当 `gc_obj_count <= gc_threshold` 时触发完整的 `JS_RunGC`
- `gc_phase` 状态机确保 GC 不会递归触发

## 核心算法：基于引用计数的循环检测

QuickJS 不用传统的三色标记法。它的算法巧妙地利用引用计数来检测循环：

### 基本原理

在非循环引用图中，如果递归地**减去子对象对父对象的引用**，所有外部可达对象的 ref_count 都会被减到 0，但实际上它们又会被外部引用恢复。但对于循环引用，从环上任意一点出发减去子引用后，环上所有节点的 ref_count 都为 0 —— 这样就找到了不可达的环。

具体地说：
1. **假设**所有对象都是垃圾，减去所有子引用
2. **恢复**外部可达对象的引用（从根对象出发重新递增）
3. 最终 ref_count 仍为 0 的 → 不可达的循环引用

## 三个执行阶段详解

`JS_RunGCInternal`（`quickjs.c:6410`）：

```c
static void JS_RunGCInternal(JSRuntime *rt, BOOL remove_weak_objects)
{
    if (remove_weak_objects)
        gc_remove_weak_objects(rt);  // 前置：清理弱引用

    gc_decref(rt);    // 阶段 1：全面递减
    gc_scan(rt);      // 阶段 2：恢复可达
    gc_free_cycles(rt); // 阶段 3：释放余下的环
}
```

### 阶段 1 — `gc_decref`（全面递减）

```c
static void gc_decref(JSRuntime *rt)
{
    init_list_head(&rt->tmp_obj_list);

    list_for_each_safe(el, el1, &rt->gc_obj_list) {
        p = list_entry(el, JSGCObjectHeader, link);
        mark_children(rt, p, gc_decref_child);  // ← 递减每个子对象 ref_count
        p->mark = 1;  // 标记为"已递减"
        if (p->ref_count == 0) {
            list_del(&p->link);
            list_add_tail(&p->link, &rt->tmp_obj_list);
        }
    }
}

static void gc_decref_child(JSRuntime *rt, JSGCObjectHeader *p)
{
    assert(p->ref_count > 0);
    p->ref_count--;
    // 减到 0 时不立即处理，等待 gc_scan 恢复，或 gc_free_cycles 释放
}
```

**行为：**

| 对象 | 效果 |
|------|------|
| 普通：A → B（A 引用 B） | A.ref_count 不变，B.ref_count-- |
| 外部可达对象（被全局变量引用） | 外部引用不在 gc_obj_list 中，外部 ref_count 没被减 → ref_count > 0 |
| 循环引用：A ↔ B（无外部引用） | A.ref_count--, B.ref_count-- → 都变为 0 |
| 引用树根（global_obj） | 在 gc_obj_list 中，被 mark_children 处理，但其 ref_count 包含了外部引用 → > 0 |

**关键理解**：`mark_children` 遍历的是父→子的**有向引用边**。`gc_decref_child` 降低的是被引用者的 ref_count。如果一个对象被外部（不在 gc_obj_list 中的作用域/栈变量）引用，它的 ref_count 会比被 gc_obj_list 内的引用总和多 1。

阶段 1 结束后：
- `gc_obj_list` 中只剩 ref_count > 0 的对象（它们的外部引用未被抵消）
- `tmp_obj_list` 中存放 ref_count == 0 的对象

### 阶段 2 — `gc_scan`（恢复可达对象）

```c
static void gc_scan(JSRuntime *rt)
{
    // 第一遍——恢复外部可达的子引用
    list_for_each(el, &rt->gc_obj_list) {
        p = list_entry(el, JSGCObjectHeader, link);
        p->mark = 0;  // 重置 mark，以备后续使用
        mark_children(rt, p, gc_scan_incref_child);
    }

    // 第二遍——恢复 tmp_obj_list 中的子引用（只是为了正确的 gc 记账）
    list_for_each(el, &rt->tmp_obj_list) {
        p = list_entry(el, JSGCObjectHeader, link);
        mark_children(rt, p, gc_scan_incref_child2);
    }
}

static void gc_scan_incref_child(JSRuntime *rt, JSGCObjectHeader *p)
{
    p->ref_count++;             // 恢复 ref_count
    if (p->ref_count == 1) {    // 从 0 变为 1 → 之前的垃圾其实可达！
        list_del(&p->link);     // 从 tmp_obj_list 移出
        list_add_tail(&p->link, &rt->gc_obj_list);  // 放回 gc_obj_list
        p->mark = 0;            // 为下次 GC 重置标记
    }
}

static void gc_scan_incref_child2(JSRuntime *rt, JSGCObjectHeader *p)
{
    p->ref_count++;  // 只恢复 ref_count，不移动链表
}
```

**第一遍**：遍历 `gc_obj_list`（ref_count > 0 的可达对象），恢复它们的子对象引用。

例如：全局对象 `global` → `Instance` → `export_func`

```
gc_decref 后：
  global.ref_count > 0  (外部保留)
  Instance.ref_count == 0  (假设所有引用都在 gc_obj_list 中)
  export_func.ref_count == 0

gc_scan 第一遍：
  遍历 gc_obj_list → global.ref_count > 0
  mark_children(global, gc_scan_incref_child)
  → Instance.ref_count++  → 1 → 从 tmp_obj_list 移回 gc_obj_list
  遍历 gc_obj_list → Instance 也在（刚移回）
  mark_children(Instance, gc_scan_incref_child)
  → export_func.ref_count++ → 1 → 移回 gc_obj_list
```

**第二遍**：遍历 `tmp_obj_list` 中仍然为 0 的对象，递增它们的子引用计数。这是为了后续在 `gc_free_cycles` 中安全地释放，因为释放过程中 finalizer 可能会访问子对象。

阶段 2 结束后：
- `gc_obj_list` 包含了所有可达对象 + 被可达对象间接引用的对象
- `tmp_obj_list` 中只留下真正不可达的循环引用（ref_count == 0）

### 阶段 3 — `gc_free_cycles`（释放循环）

```c
static void gc_free_cycles(JSRuntime *rt)
{
    rt->gc_phase = JS_GC_PHASE_REMOVE_CYCLES;  // 设置阶段锁

    for(;;) {
        el = rt->tmp_obj_list.next;
        if (el == &rt->tmp_obj_list)
            break;
        p = list_entry(el, JSGCObjectHeader, link);
        switch(p->gc_obj_type) {
        case JS_GC_OBJ_TYPE_JS_OBJECT:
        case JS_GC_OBJ_TYPE_FUNCTION_BYTECODE:
        case JS_GC_OBJ_TYPE_ASYNC_FUNCTION:
        case JS_GC_OBJ_TYPE_MODULE:
            free_gc_object(rt, p);  // → 调用 finalizer
            break;
        default:
            // Shape 等非顶层对象，移到 gc_zero_ref_count_list
            list_del(&p->link);
            list_add_tail(&p->link, &rt->gc_zero_ref_count_list);
        }
    }

    rt->gc_phase = JS_GC_PHASE_NONE;  // 解锁

    // 清理 gc_zero_ref_count_list（有弱引用的保留，其余释放）
    list_for_each_safe(el, el1, &rt->gc_zero_ref_count_list) {
        p = list_entry(el, JSGCObjectHeader, link);
        if (p->gc_obj_type == JS_GC_OBJ_TYPE_JS_OBJECT &&
            ((JSObject *)p)->weakref_count != 0) {
            p->mark = 0;  // 有弱引用，保留结构体
        } else {
            js_free_rt(rt, p);  // 真·释放
        }
    }
    init_list_head(&rt->gc_zero_ref_count_list);
}
```

**`free_gc_object` 内部**会调用各类型的释放函数。对于 `JS_GC_OBJ_TYPE_JS_OBJECT`，调用 `free_object`：

```c
static void free_object(JSRuntime *rt, JSObject *p)
{
    JSClassFinalizer *finalizer;
    // ...释放属性数组...
    finalizer = rt->class_array[p->class_id].finalizer;
    if (finalizer)
        (*finalizer)(rt, JS_MKPTR(JS_TAG_OBJECT, p));  // 调用 C finalizer

    p->class_id = 0;
    p->u.opaque = NULL;

    remove_gc_object(&p->header);

    if (rt->gc_phase == JS_GC_PHASE_REMOVE_CYCLES) {
        if (p->header.ref_count == 0 && p->weakref_count == 0) {
            js_free_rt(rt, p);  // 循环检测中：无引用则直接释放
        } else {
            list_add_tail(&p->header.link, &rt->gc_zero_ref_count_list);
        }
    }
    // ...
}
```

**注意**：finalizer 在 `gc_phase == JS_GC_PHASE_REMOVE_CYCLES` 状态下执行。此时如果 finalizer 中又调用了 `JS_FreeValueRT`，`__JS_FreeValueRT` 会检查 `gc_phase`：

```c
if (rt->gc_phase != JS_GC_PHASE_REMOVE_CYCLES) {
    // 正常释放逻辑
} else {
    // 跳过——因为 gc_free_cycles 正在处理
}
```

这防止了在释放循环时的递归重入。

## `mark_children`：统一的子对象遍历入口

三个阶段的核心是 `mark_children`，它接受不同的回调函数来执行不同操作：

```c
gc_decref → mark_children(rt, p, gc_decref_child)      // 减引用
gc_scan   → mark_children(rt, p, gc_scan_incref_child)  // 加引用
```

`mark_children` 根据 `gc_obj_type` 遍历对象的所有子引用：

| gc_obj_type | 遍历的子引用 |
|-------------|-------------|
| `JS_GC_OBJ_TYPE_JS_OBJECT` | shape（原型链）、所有属性值、getter/setter、**自定义类的 gc_mark** |
| `JS_GC_OBJ_TYPE_FUNCTION_BYTECODE` | 常量池中的值、realm |
| `JS_GC_OBJ_TYPE_VAR_REF` | 闭包变量引用、stack frame |
| `JS_GC_OBJ_TYPE_ASYNC_FUNCTION` | cur_func、this_val、栈上变量、resolving_funcs |
| `JS_GC_OBJ_TYPE_SHAPE` | prototype 对象 |
| `JS_GC_OBJ_TYPE_JS_CONTEXT` | 全局对象、所有内置原型、错误类型等 |
| `JS_GC_OBJ_TYPE_MODULE` | 模块的导入/导出 |

## `gc_mark` 的作用

### 调用位置

在 `mark_children` 遍历 **JS_GC_OBJ_TYPE_JS_OBJECT** 时（`quickjs.c:6200-6204`）：

```c
// 遍历完所有标准属性之后...
if (p->class_id != JS_CLASS_OBJECT) {
    JSClassGCMark *gc_mark;
    gc_mark = rt->class_array[p->class_id].gc_mark;
    if (gc_mark)
        gc_mark(rt, JS_MKPTR(JS_TAG_OBJECT, p), mark_func);
}
```

- `mark_func` 是当前阶段传入的回调（`gc_decref_child` 或 `gc_scan_incref_child`）
- 自定义类的 `gc_mark` 内部调用 `JS_MarkValue(rt, value, mark_func)`，这会把 `mark_func` 间接传给子对象的 `mark_children`

### 为什么必须实现

自定义类的 opaque data 中可能直接持有 `JSValue` 字段，这些字段**不是 JS 对象的属性**，GC 无法通过标准属性遍历看到它们。

没有 `gc_mark` 的后果：

```
gc_decref 时：
  mark_children(Instance, gc_decref_child)
    → 遍历标准属性 (exports.add_via_import 等)
    → 递减 add_via_import 的 ref_count  ✓
    → class_id != JS_CLASS_OBJECT → gc_mark 为 NULL → 跳过！
    → import_funcs[0].func 的 ref_count 没有被减 ✗

gc_scan 时：
  mark_children(Instance, gc_scan_incref_child)
    → 遍历标准属性
    → class_id != JS_CLASS_OBJECT → gc_mark 为 NULL → 跳过！
    → import_funcs[0].func 的 ref_count 没有被恢复 ✗
```

结果：import_func 的 ref_count 比实际应有多 1（因为 importObject 变量也引用了它）。这个"假增量"导致它永远无法被回收。

### 正确实现模式

```c
static void my_class_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    MyClass *s = JS_GetOpaque(val, my_class_id);
    if (s) {
        JS_MarkValue(rt, s->js_ref1, mark_func);
        JS_MarkValue(rt, s->js_ref2, mark_func);
    }
}

static JSClassDef my_class_def = {
    .class_name = "MyClass",
    .finalizer = my_class_finalizer,
    .gc_mark = my_class_mark,
};
```

`JS_MarkValue` 内部会调用 `mark_func(rt, JS_VALUE_GET_PTR(val))`，从而将 `mark_func`（`gc_decref_child` 或 `gc_scan_incref_child`）应用到子对象上。

### `gc_mark` 是必须的——不只是优化

不定义 `gc_mark` 时：
- **引用计数仍然正常**：`JS_DupValue` / `JS_FreeValue` 配对正确的前提下，对象不会被提前释放
- **泄漏只在两种情况下显现**：
  1. 涉及循环引用时，GC 无法检测到环
  2. `JS_FreeRuntime` 最终检查时，atom/string 残留

所以在大部分简单场景下不定义 `gc_mark` 也不会立即崩溃。但只要自定义类持有 `JSValue`，就应该始终定义 `gc_mark`。

### 本项目中的使用情况

| 类 | `gc_mark` | 持有的 JSValue |
|---|-----------|----------------|
| Module | `js_wasm_module_mark`（空） | 无 |
| Global | `js_wasm_global_mark` | `inst_ref`（引用 Instance） |
| Memory | `js_wasm_memory_mark` | `inst_ref`（引用 Instance） |
| Instance | 原缺失 → 已修复 | `import_funcs[i].func` |

## `JS_MarkValue` 的执行路径

```c
void JS_MarkValue(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    if (JS_VALUE_HAS_REF_COUNT(val)) {
        switch(JS_VALUE_GET_TAG(val)) {
        case JS_TAG_OBJECT:
        case JS_TAG_FUNCTION_BYTECODE:
        case JS_TAG_MODULE:
            mark_func(rt, JS_VALUE_GET_PTR(val));  // → gc_decref_child / gc_scan_incref_child
            break;
        default:
            break;  // 字符串、数字等没有 GC 头部，不处理
        }
    }
}
```

被调用的 `mark_func`（`gc_decref_child` 或 `gc_scan_incref_child`）会修改引用计数，而 `mark_children` 会递归地遍历子对象的子对象。

## 完整的例子

假设有：

```
   importObject ──→ func ──→ closure_var
       ↑                    (函数字节码)
       │
   Instance.import_funcs ──→ func (同对象)
```

初始 ref_count:
- func: 2（importObject + Instance.import_funcs）
- closure_var: 1（func 的字节码常量池引用）

**gc_decref 阶段：**
1. 遍历 gc_obj_list
2. `mark_children(importObject, gc_decref_child)` → func.ref_count-- → 1
3. `mark_children(Instance, gc_decref_child)` → 遍历标准属性，但不遍历 import_funcs（没有 gc_mark）
4. func.ref_count 仍然为 1 → 不进 tmp_obj_list

如果 Instance **有 gc_mark**：
3'. `mark_children(Instance, gc_decref_child)` → 遍历标准属性 → 调用 gc_mark → `JS_MarkValue(func)` → func.ref_count-- → 0 → func 进 tmp_obj_list
4'. `mark_children(func_bytecode, gc_decref_child)` → closure_var.ref_count-- → 0 → 进 tmp_obj_list

**gc_scan 阶段（有 gc_mark 的版本）：**
1. 遍历 gc_obj_list（ref_count > 0 的对象）
2. importObject.ref_count > 0 → `mark_children(importObject, gc_scan_incref_child)` → func.ref_count++ → 1 → func 移回 gc_obj_list
3. func.ref_count > 0 → `mark_children(func, gc_scan_incref_child)` → closure_var.ref_count++ → 1 → closure_var 移回 gc_obj_list

**gc_free_cycles 阶段：** tmp_obj_list 为空，无事可做，所有对象都可达。

如果用户释放了 importObject：
- func.ref_count-- → func.ref_count 降到 1（仅剩 Instance.import_funcs 的引用）
- 下次 GC 时 gc_decref 会把它降到 0（如果有 gc_mark）→ gc_scan 无法恢复 → 释放

## 关键代码位置

| 函数/数据 | 文件:行 |
|-----------|---------|
| `JSGCObjectHeader` 定义 | `quickjs.c:254-267` |
| `JSClassDef.gc_mark` 字段 | `quickjs.h:318` |
| `js_malloc_rt` / `js_free_rt` | `quickjs.c:1380-1388` |
| `JS_NewClass`（注册 gc_mark）| `quickjs.c:3483` |
| `__JS_FreeValueRT`（触发 GC）| `quickjs.c:6027` |
| `free_zero_refcount` | `quickjs.c:6009` |
| `free_object`（调用 finalizer）| `quickjs.c:5949` |
| `gc_remove_weak_objects` | `quickjs.c:6105` |
| `JS_MarkValue` | `quickjs.c:6148` |
| `mark_children`（统一遍历入口）| `quickjs.c:6163` |
| `gc_decref_child` | `quickjs.c:6282` |
| `gc_decref`（阶段 1）| `quickjs.c:6292` |
| `gc_scan_incref_child` / `gc_scan_incref_child2` | `quickjs.c:6314-6328` |
| `gc_scan`（阶段 2）| `quickjs.c:6331` |
| `gc_free_cycles`（阶段 3）| `quickjs.c:6351` |
| `JS_RunGCInternal`（入口）| `quickjs.c:6410` |
| DUMP_LEAKS 泄漏报告 | `quickjs.c:2158-2166` |

## 附录：`JS_FreeValueRT` 在 Finalizer 中的必要性研究

### 问题

WASM Instance 打开数据中通过 `import_funcs` 数组持有 import function 的 `JSValue`：

```c
typedef struct {
    JSContext *ctx;
    JSValue func;              // JS_DupValue 过的 import function
    wasm_valkind_t *result_kinds;
    int result_count;
} WasmImportFunc;
```

在 Instance finalizer 中，是否需要对 `import_funcs[i].func` 调用 `JS_FreeValueRT`？

### 理论分析

**支持需要的理由：**
- `import_funcs[i].func = JS_DupValue(ctx, func_val)` 增加了 ref_count
- 不调用 `JS_FreeValueRT` 则 ref_count 永不恢复 → "幽灵引用"泄漏
- 在只靠引用计数的路径中（函数返回导致局部变量释放），duck 的引用不会被清理

**生命周期追踪（假设没有 `JS_FreeValueRT`）：**

```
构造函数内部：
  func = JS_GetPropertyStr(env, "imported_add")  → ref_count=2
  import_funcs[i].func = JS_DupValue(func_val)   → ref_count=3
  JS_FreeValue(func_val)                          → ref_count=2
  净效果：env.imported_add 持有 1，import_funcs 持有 1

testImport() 返回时：
  inst 释放 → Instance finalizer 运行 → import_funcs 数组 free() 释放
  → 但 JS_DupValue 的 ref_count+1 没有恢复 → func.ref_count 仍为 2
  
  importObject 释放 → env.imported_add 释放 → func.ref_count-- = 1
  → func.ref_count = 1，但无人再引用 func
```

### 实证验证

用带 `DUMP_LEAKS` 的 QuickJS 构建验证：

**验证步骤：**
1. 在 `quickjs.c` 中启用 `#define DUMP_LEAKS 1`（行 99）
2. 在 `JS_FreeRuntime` 的 DUMP_LEAKS 块前添加 `gc_obj_list` 计数
3. 在 `JS_RunGCInternal` 中添加 `gc_decref` / `gc_scan` 各阶段的 tmp_obj_list 计数
4. 编译并运行含 import 的测试（100 次迭代创建/释放 Instance）

**关键发现：**

```
BEFORE GC:        gc_obj_list has 454 objects  ← 包括所有运行时对象 + 100 个泄漏的 func
gc_decref:        454 objects moved to tmp_obj_list
gc_scan:          454 objects remain in tmp_obj_list, 0 in gc_obj_list
AFTER GC:         gc_obj_list has 0 objects
```

无论有没有 `JS_FreeValueRT`，`gc_obj_list` 最终都为 **0**——GC 正确清理了所有对象。

### 结论

**`JS_FreeValueRT` 在 finalizer 中不是必需的。** GC 的 `gc_mark` 钩子和三阶段算法足以处理：

**原因：** `gc_mark` 让 `gc_decref` 阶段能正确识别 `import_funcs[i].func` 的子引用关系。当 Instance 被释放后，GC 在 `gc_decref` 中发现：
- func 唯一的外部引用来自于已释放的 Instance
- gc_decref 的 `mark_children`（经 `gc_mark`）递减 func 的 ref_count
- func.ref_count 降至 0 → 进入 `tmp_obj_list` → gc_free_cycles 释放

**无需 `JS_FreeValueRT`** 的完整条件链：
1. ✅ 类定义了 `gc_mark`，能正确标记持有的所有 JSValue
2. ✅ 所有外部引用（importObject、全局变量等）已经被正常释放
3. ✅ 没有其他 GC 对象引用 func

**实际影响：** 纯引用计数路径（`free_zero_refcount`）中确实会留下 +1 的幽灵引用，但 QuickJS 的下次 GC 运行（`JS_RunGCInternal`）总是能清理它。对于短生命周期脚本，在 `JS_FreeRuntime` 时 GC 会最终清理所有残留。

### 对代码的影响

当前代码（无 `JS_FreeValueRT`）是正确且更简洁的：

```c
static void js_wasm_instance_finalizer(JSRuntime *rt, JSValue val)
{
    WASMInstance *inst = JS_GetOpaque(val, js_webassembly_instance_class_id);
    if (inst) {
        if (inst->funcs)
            js_free_rt(rt, inst->funcs);
        if (inst->import_funcs) {
            for (int i = 0; i < inst->import_func_count; i++) {
                // 不需要 JS_FreeValueRT — GC 会处理
                if (inst->import_funcs[i].result_kinds)
                    free(inst->import_funcs[i].result_kinds);
            }
            js_free_rt(rt, inst->import_funcs);
        }
        wasm_extern_vec_delete(&inst->externs);
        js_free_rt(rt, inst);
    }
}
```

移除 `JS_FreeValueRT` 不仅有性能优势（减少不必要的 `__JS_FreeValueRT` 调用），还避免了潜在的 re-entrancy 问题（在 `JS_GC_PHASE_REMOVE_CYCLES` 阶段调用 `JS_FreeValueRT` 会被跳过）。

## 参考

- [Bellard 原版 QuickJS 文档](https://bellard.org/quickjs/quickjs.html)

## 相关文档

- [WASM Module/Instance 引用计数问题分析](./WASM_MODULE_INSTANCE_GC.md) - 详细分析了 WASM Module/Instance 的引用计数问题和修复方案
