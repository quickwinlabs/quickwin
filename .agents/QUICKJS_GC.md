# QuickJS GC 工作原理

## 概述

QuickJS 的垃圾回收采用 **引用计数 + 标记清除** 混合策略：

- **引用计数**：通过 `JS_DupValue` / `JS_FreeValue` 管理绝大多数生命周期，ref_count 降到 0 的对象立即进入 `gc_zero_ref_count_list` 并释放
- **标记清除**：专门处理**不可达的循环引用**（纯引用计数无法解决的场景），仅在必要时触发

## GC 对象

所有参与 GC 的对象头部（**注意随 quickjs 版本演进**；当前版本 `JSGCObjectHeader` 只剩链表指针，
`ref_count` / `mark` 等字段已移入 malloc 块头，经 `quickjs.c` 的 `js_rc()` 内联宏访问——
阅读代码时按符号名定位，勿假设字段布局）：

```c
typedef struct JSGCObjectHeader {
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

**引用计数归零的即时路径**在 `__JS_FreeValueRT`：GC 对象 ref_count 降为 0 时，从 `gc_obj_list`
摘下挂入 `gc_zero_ref_count_list`——非 GC 期间（`gc_phase == JS_GC_PHASE_NONE`）经
`free_zero_refcount` 立即释放；GC 执行期间则挂起等待 `gc_free_cycles` 统一处理。

**标记清除的触发**是**按 malloc 内存压力**（`js_trigger_gc`）：关键分配路径（如 `JS_NewObject`）
调用 `js_trigger_gc`，当 `malloc_size + size > malloc_gc_threshold` 时跑一次 `JS_RunGC`，
GC 后阈值上调为当前 `malloc_size × 1.5`；初始阈值 `256KB`，`JS_SetGCThreshold` 可改。
旧版的 `gc_obj_count` / `gc_threshold` 对象计数机制已不存在。

## 核心算法：基于引用计数的循环检测

QuickJS 不用传统的三色标记法。它的算法巧妙地利用引用计数来检测循环：

### 基本原理

在非循环引用图中，如果递归地**减去子对象对父对象的引用**，所有外部可达对象的 ref_count 都会被减到 0，但实际上它们又会被外部引用恢复。但对于循环引用，从环上任意一点出发减去子引用后，环上所有节点的 ref_count 都为 0 —— 这样就找到了不可达的环。

具体地说：
1. **假设**所有对象都是垃圾，减去所有子引用
2. **恢复**外部可达对象的引用（从根对象出发重新递增）
3. 最终 ref_count 仍为 0 的 → 不可达的循环引用

## 三个执行阶段详解

`JS_RunGCInternal`：

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

在 `mark_children` 遍历 **JS_GC_OBJ_TYPE_JS_OBJECT** 时（遍历完标准属性之后）：

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

### 本项目中的使用情况（`src/quickjs-wamr.c`）

| 类 | `gc_mark` | 持有的 JSValue |
|---|-----------|----------------|
| WebAssembly.Module | 无（只持 native `wasm_module_t`） | 无 |
| Global / Memory / Table | `js_wasm_global_mark` / `js_wasm_memory_mark` / `js_wasm_table_mark` | `inst_ref`（引用 Instance） |
| Instance | `js_wasm_instance_mark` | `module_obj` + `import_obj`（互持保活，见 WASM_MODULE_INSTANCE_GC.md） |

自定义 class 注册 `gc_mark` 走 `JS_NewClass`（`JSClassDef.gc_mark` 字段）。

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

（沿用旧版 WASM Instance 的 `import_funcs` 语境作讲解；机制与具体自定义类无关）

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

## 符号定位（`deps/quickjs/quickjs.c`，按符号名 grep——行号随版本漂移，不记）

`JSGCObjectHeader`、`js_rc`（malloc 块头 ref_count/mark 访问）、`js_trigger_gc`、
`__JS_FreeValueRT`、`free_zero_refcount`、`free_object`、`gc_remove_weak_objects`、
`JS_MarkValue`、`mark_children`、`gc_decref_child`、`gc_decref`、`gc_scan_incref_child(_2)`、
`gc_scan`、`gc_free_cycles`、`JS_RunGCInternal`、`JS_FreeRuntime`（DUMP_LEAKS 泄漏报告在此开启）。

## 附录：finalizer 里要不要 `JS_FreeValueRT`？（结论）

旧版 WASM 实现（`WASMInstance`/`import_funcs` 数组时代）曾专门研究过这个问题，结论是：
**若类定义了正确的 `gc_mark`、且所有外部引用已正常释放，GC 三阶段足以回收 finalizer 未
手动释放的 JSValue**——纯引用计数路径会留下 +1 幽灵引用，但下次 GC 必然清理。

⚠️ 该结论**绑定当时的数据结构**；现行 `QJWasmInstance` 持有的是 `module_obj`/`import_obj`
两个 JS 对象互引用（防 Module 提前释放），finalizer 里**显式调用** `JS_FreeValueRT` 释放它们。
现状与推演详见 `./WASM_MODULE_INSTANCE_GC.md`；Worker 的引用差异见 `./WORKER_GC_BUG.md`。

## 参考

- [Bellard 原版 QuickJS 文档](https://bellard.org/quickjs/quickjs.html)

## 相关文档

- [WASM Module/Instance 引用计数问题分析](./WASM_MODULE_INSTANCE_GC.md) - 详细分析了 WASM Module/Instance 的引用计数问题和修复方案
- [Worker 生命周期管理](./WORKER_GC_BUG.md) - Worker 引用管理：QuickJS 与浏览器的设计差异
