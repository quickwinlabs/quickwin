# WASM Module/Instance 引用计数问题分析

## 问题现象

运行 MuPDF WASM 模块测试时，程序崩溃，退出码 2816。调试发现：
- 崩溃发生在调用 WASM 导出函数时
- `wasm_inst->module` 是悬空指针（指向已释放的内存）
- 根本原因：`js_wasm_module_finalizer` 释放了 `QJWasmModule`，但导出函数仍持有指向它的指针

## 引用链分析

### 数据结构

```c
typedef struct QJWasmModule {
    uint8_t *buf;
    wasm_module_t module;
    int32_t export_count;
    wasm_export_t *exports;
    // ...
} QJWasmModule;

typedef struct QJWasmInstance {
    JSContext *ctx;
    QJWasmModule *module;      // ← C 指针，GC 不知道！
    JSValue module_obj;        // ← JSValue，GC 知道
    JSValue import_obj;
    wasm_module_inst_t inst;
} QJWasmInstance;
```

### 引用链（修复前）

```
exports_obj
    │
    │ JS_SetPropertyStr("db", fn)
    ▼
fn (JSFunction)
    │
    │ func_data[0] = inst_obj  ← 只持有 instance
    ▼
inst_obj (Instance JSObject)
    │
    │ JS_GetOpaque → wasm_inst
    │ wasm_inst->module_obj (JSValue)  ← GC 知道
    │ wasm_inst->module (C 指针)       ← GC 不知道！
    ▼
module_obj (Module JSObject)
    │
    │ JS_GetOpaque → wasm_module
    ▼
QJWasmModule (C 结构体)
```

## 问题根源

### 关键区别

- `wasm_inst->module_obj` 是 `JSValue`，GC 知道这个引用
- `wasm_inst->module` 是 C 指针，**GC 不知道它的存在**

### 用户代码场景

当用户代码没有保存 `result` 对象时：

```javascript
const { db } = (await WebAssembly.instantiate(buffer)).instance.exports;
// result 没有被保存
// result.instance 没有被保存
// 但 db 函数仍然被持有
```

### GC 行为

1. `result` 没有外部引用 → 可回收
2. `result.module` 没有外部引用 → 可回收
3. `result.instance` 没有外部引用 → 可回收
4. 但 `db.func_data[0]` 持有 `inst_obj` 的引用

## 核心问题：为什么 `inst_obj` 持有 `module_obj`，但 `module_obj` 仍被提前回收？

### 理论分析

理论上，引用链是：

```
fn.func_data[0] → inst_obj → wasm_inst->module_obj → module_obj
```

而且 `js_wasm_instance_mark` 会标记 `module_obj`：

```c
static void js_wasm_instance_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    QJWasmInstance *inst = JS_GetOpaque(val, js_webassembly_instance_class_id);
    if (!inst)
        return;
    JS_MarkValue(rt, inst->import_obj, mark_func);
    JS_MarkValue(rt, inst->module_obj, mark_func);  // ← 标记了 module_obj
}
```

**按理说 `module_obj` 不应该被回收！**

### QuickJS GC 三阶段分析

QuickJS GC 分三个阶段：

1. **gc_decref**：遍历所有对象，递减子对象的引用计数
2. **gc_scan**：从可达对象出发，恢复子对象的引用计数
3. **gc_free_cycles**：释放引用计数仍为 0 的对象

#### 阶段 1：gc_decref

```
遍历 gc_obj_list 中的所有对象：
    对每个对象 p：
        mark_children(p, gc_decref_child)  // 递减子对象的 ref_count
        if (p->ref_count == 0):
            移动到 tmp_obj_list
```

**关键**：`mark_children` 会调用对象的 `gc_mark` 函数。

对于 `fn` 函数（`JS_CLASS_C_FUNCTION_DATA`）：

```c
static void js_c_function_data_mark(JSRuntime *rt, JSValueConst val, JS_MarkFunc *mark_func)
{
    JSCFunctionDataRecord *s = JS_GetOpaque(val, JS_CLASS_C_FUNCTION_DATA);
    if (s) {
        for(i = 0; i < s->data_len; i++) {
            JS_MarkValue(rt, s->data[i], mark_func);  // 标记 func_data[i]
        }
    }
}
```

所以 `fn` 的 `func_data[0]`（即 `inst_obj`）会被正确标记。

#### 阶段 2：gc_scan

```
遍历 gc_obj_list（ref_count > 0 的对象）：
    对每个对象 p：
        mark_children(p, gc_scan_incref_child)  // 恢复子对象的 ref_count
```

**问题场景**：

假设初始状态：
- `fn.ref_count = 1`（被用户变量持有）
- `inst_obj.ref_count = 2`（被 `fn.func_data[0]` + `result.instance` 持有）
- `module_obj.ref_count = 2`（被 `inst->module_obj` + `result.module` 持有）

用户代码执行后：
- `result` 被释放 → `result.instance.ref_count--` → `inst_obj.ref_count = 1`
- `result.module.ref_count--` → `module_obj.ref_count = 1`

**gc_decref 阶段**：

```
遍历 fn：
    mark_children(fn, gc_decref_child)
    → js_c_function_data_mark 被调用
    → JS_MarkValue(func_data[0], gc_decref_child)
    → inst_obj.ref_count-- = 0
    → inst_obj 移动到 tmp_obj_list

遍历 inst_obj（已在 tmp_obj_list，不处理）

遍历 module_obj：
    mark_children(module_obj, gc_decref_child)
    → 没有子对象（Module 的 gc_mark 为空）
    → module_obj.ref_count 不变 = 1
    → module_obj 仍在 gc_obj_list
```

**gc_scan 阶段**：

```
遍历 gc_obj_list：
    fn.ref_count = 1 > 0
        mark_children(fn, gc_scan_incref_child)
        → inst_obj.ref_count++ = 1
        → inst_obj 从 tmp_obj_list 移回 gc_obj_list

    module_obj.ref_count = 1 > 0
        mark_children(module_obj, gc_scan_incref_child)
        → 没有子对象

继续遍历 gc_obj_list（现在包含 inst_obj）：
    inst_obj.ref_count = 1 > 0
        mark_children(inst_obj, gc_scan_incref_child)
        → js_wasm_instance_mark 被调用
        → JS_MarkValue(inst->module_obj, gc_scan_incref_child)
        → module_obj.ref_count++ = 2
```

**按这个分析，`module_obj` 应该不会被回收！**

### 真正的问题：时序问题

问题可能出在 **GC 的执行时机**。让我们考虑另一种场景：

**场景：在 `js_wasm_instance_ctor` 执行期间触发 GC**

```c
static JSValue js_wasm_instance_ctor(JSContext *ctx, ...)
{
    // Step 1: 创建 inst_obj
    JSValue inst_obj = JS_NewObjectClass(ctx, js_webassembly_instance_class_id);
    // inst_obj.ref_count = 1

    // Step 2: 创建导出函数
    for (int i = 0; i < wasm_module->export_count; i++) {
        JSValue func_data[1];
        func_data[0] = JS_DupValue(ctx, inst_obj);
        // inst_obj.ref_count = 2
        JSValue fn = JS_NewCFunctionData(ctx, js_call_wasm_bridge, 0, i, 1, func_data);
        // inst_obj.ref_count = 3（JS_NewCFunctionData 内部 DupValue）
        JS_FreeValue(ctx, func_data[0]);
        // inst_obj.ref_count = 2
        JS_SetPropertyStr(ctx, exports_obj, export.name, fn);
        // exports_obj 持有 fn
    }

    // Step 3: 设置 exports 属性
    JS_SetPropertyStr(ctx, inst_obj, "exports", exports_obj);
    // inst_obj 持有 exports_obj

    return inst_obj;
    // inst_obj.ref_count = 1（只被返回值持有）
}
```

**关键问题**：在 `js_wasm_instance_ctor` 返回后，`inst_obj` 的引用计数是多少？

### 回到 `js_webassembly_instantiate`

```c
static JSValue js_webassembly_instantiate(JSContext *ctx, ...)
{
    // Step 1: 创建 module_obj
    JSValue module_obj = create_wasm_module_object(ctx, buf, module);
    // module_obj.ref_count = 1

    // Step 2: 创建 inst_obj
    JSValue inst_obj = js_wasm_instance_ctor(ctx, ...);
    // inst_obj.ref_count = 1
    // module_obj.ref_count = ? （在 ctor 内部被增加）

    // Step 3: 创建 result
    JSValue result = JS_NewObject(ctx);
    // result.ref_count = 1

    JS_SetPropertyStr(ctx, result, "module", module_obj);
    // module_obj.ref_count += 1

    JS_SetPropertyStr(ctx, result, "instance", inst_obj);
    // inst_obj.ref_count += 1

    JS_FreeValue(ctx, module_obj);
    // module_obj.ref_count -= 1

    JS_FreeValue(ctx, inst_obj);
    // inst_obj.ref_count -= 1

    // Step 4: resolve Promise
    JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, &result);
    // Promise 持有 result

    JS_FreeValue(ctx, result);
    // result.ref_count -= 1

    return promise;
}
```

### 可能的问题场景

**场景：用户代码在 Promise resolve 后立即解构**

```javascript
const { db } = (await WebAssembly.instantiate(buffer)).instance.exports;
```

执行过程：

1. `await` 返回 `result`
2. 访问 `result.instance.exports.db`
3. 将 `db` 赋值给变量
4. `result` 表达式结束，没有其他引用

**此时引用计数**：
- `result.ref_count = 0`（临时对象）
- `result.instance.ref_count = ?`（被 `exports_obj` 持有，但 `exports_obj` 是临时对象）
- `result.module.ref_count = ?`

**问题**：当 `result` 被释放时，会触发 `result.instance` 和 `result.module` 的引用计数递减。

如果 `result.module.ref_count` 变成 0，`module_obj` 会被放入 `gc_zero_ref_count_list`，然后被释放！

**但是**，`fn.func_data[0]` 持有 `inst_obj`，`inst_obj` 持有 `module_obj`，为什么 `module_obj` 会被释放？

### 深入分析：`JS_FreeValue` 的行为

```c
void __JS_FreeValueRT(JSRuntime *rt, JSValue v)
{
    ...
    case JS_TAG_OBJECT:
        {
            JSGCObjectHeader *p = JS_VALUE_GET_PTR(v);
            p->ref_count--;
            if (p->ref_count == 0) {
                list_del(&p->link);
                list_add(&p->link, &rt->gc_zero_ref_count_list);
                p->mark = 1;  // 标记为"即将释放"
                if (rt->gc_phase == JS_GC_PHASE_NONE) {
                    free_zero_refcount(rt);  // 立即释放！
                }
            }
        }
        break;
}
```

**关键**：当 `p->ref_count == 0` 且 `gc_phase == JS_GC_PHASE_NONE` 时，会**立即释放**对象！

这意味着：如果 `module_obj.ref_count` 变成 0，`js_wasm_module_finalizer` 会立即被调用，释放 `QJWasmModule` 结构体！

### 问题根源总结

**问题不在于 GC，而在于引用计数！**

当用户代码：
```javascript
const { db } = (await WebAssembly.instantiate(buffer)).instance.exports;
```

执行过程：
1. `result` 被创建，`result.module` 和 `result.instance` 被设置
2. `result.instance.exports.db` 被访问，`db` 函数被赋值给变量
3. 表达式结束，`result` 被释放
4. `result.module.ref_count--`，如果变成 0，**立即释放**！
5. `result.instance.ref_count--`，如果变成 0，**立即释放**！

**关键**：`fn.func_data[0]` 持有 `inst_obj`，但这个引用是在 `js_wasm_instance_ctor` 中创建的。

如果 `result.instance` 的引用计数在 `ctor` 返回后是 1（只被 `result` 持有），那么 `result` 释放后，`inst_obj.ref_count` 变成 0，会被立即释放！

**但是**，`fn.func_data[0]` 也持有 `inst_obj`，所以 `inst_obj.ref_count` 应该至少是 2（`result.instance` + `fn.func_data[0]`）。

### 验证引用计数

让我验证一下 `inst_obj` 的引用计数：

1. `js_wasm_instance_ctor` 创建 `inst_obj`，`ref_count = 1`
2. 创建 `fn`，`func_data[0] = JS_DupValue(inst_obj)`，`ref_count = 2`
3. `JS_NewCFunctionData` 内部 `DupValue`，`ref_count = 3`
4. `JS_freeValue(func_data[0])`，`ref_count = 2`
5. `JS_SetPropertyStr(exports_obj, fn)`，`exports_obj` 持有 `fn`
6. `JS_SetPropertyStr(inst_obj, exports_obj)`，`inst_obj` 持有 `exports_obj`
7. 返回 `inst_obj`，`ref_count = 2`（`fn.func_data[0]` + 返回值）

回到 `js_webassembly_instantiate`：
8. `JS_SetPropertyStr(result, instance, inst_obj)`，`ref_count = 3`
9. `JS_FreeValue(inst_obj)`，`ref_count = 2`（`fn.func_data[0]` + `result.instance`）

用户代码执行后：
10. `result` 被释放，`result.instance.ref_count--`，`inst_obj.ref_count = 1`（只有 `fn.func_data[0]`）

**此时 `inst_obj.ref_count = 1`，不会被释放！**

那为什么 `module_obj` 会被释放？

### 最终分析：`module_obj` 的引用计数

让我验证 `module_obj` 的引用计数：

1. `create_wasm_module_object` 创建 `module_obj`，`ref_count = 1`
2. `js_wasm_instance_ctor` 中：
   - `wasm_inst->module_obj = JS_DupValue(module_obj)`，`ref_count = 2`
3. 返回 `inst_obj`
4. `JS_SetPropertyStr(result, module, module_obj)`，`ref_count = 3`
5. `JS_FreeValue(module_obj)`，`ref_count = 2`（`wasm_inst->module_obj` + `result.module`）

用户代码执行后：
6. `result` 被释放，`result.module.ref_count--`，`module_obj.ref_count = 1`（只有 `wasm_inst->module_obj`）

**此时 `module_obj.ref_count = 1`，也不会被释放！**

### 真正的问题：`wasm_inst->module_obj` 的生命周期

**问题**：`wasm_inst->module_obj` 是存储在 `QJWasmInstance` 结构体中的 `JSValue`。

当 `inst_obj` 被释放时（`inst_obj.ref_count == 0`），`js_wasm_instance_finalizer` 会被调用：

```c
static void js_wasm_instance_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmInstance *inst = JS_GetOpaque(val, js_webassembly_instance_class_id);
    if (inst) {
        wasm_runtime_deinstantiate(inst->inst);
        JS_FreeValueRT(rt, inst->module_obj);  // ← 这里释放了 module_obj！
        JS_FreeValueRT(rt, inst->import_obj);
        js_free_rt(rt, inst);
    }
}
```

**关键**：`JS_FreeValueRT(rt, inst->module_obj)` 会递减 `module_obj` 的引用计数！

如果 `module_obj.ref_count == 1`（只有 `wasm_inst->module_obj` 持有），那么：
- `JS_FreeValueRT` 后，`module_obj.ref_count = 0`
- `module_obj` 被立即释放！
- `js_wasm_module_finalizer` 被调用，释放 `QJWasmModule`

**但是**，此时 `fn.func_data[0]` 仍然持有 `inst_obj`，`inst_obj.ref_count >= 1`，所以 `inst_obj` 不应该被释放！

### 回到原点：为什么 `inst_obj` 会被释放？

**可能的场景**：在某个时刻，`inst_obj.ref_count` 变成了 0。

让我检查是否有地方错误地释放了 `inst_obj`...

### 另一种可能：`func_data` 的生命周期

`func_data` 是在 `js_wasm_instance_ctor` 中创建的：

```c
JSValue func_data[1];  // 局部变量！
func_data[0] = JS_DupValue(ctx, inst_obj);
JSValue fn = JS_NewCFunctionData(ctx, js_call_wasm_bridge, 0, i, 1, func_data);
JS_FreeValue(ctx, func_data[0]);  // 释放局部变量
```

`JS_NewCFunctionData` 会复制 `func_data` 到 `JSCFunctionDataRecord` 结构体中：

```c
JSValue JS_NewCFunctionData(JSContext *ctx, JSCFunctionData *func,
                            int length, int data_len, int magic,
                            JSValueConst *data)
{
    JSCFunctionDataRecord *s;
    s = js_malloc(ctx, sizeof(*s) + data_len * sizeof(JSValue));
    s->data_len = data_len;
    for(i = 0; i < data_len; i++) {
        s->data[i] = JS_DupValue(ctx, data[i]);  // 复制并增加引用计数
    }
    ...
}
```

所以 `fn` 持有的 `func_data[0]` 是一个**新的引用**，不是原来的局部变量。

**引用计数应该是正确的！**

### 结论：问题可能不在引用计数

既然引用计数分析显示 `inst_obj` 和 `module_obj` 都不应该被释放，那问题可能在于：

1. **某个地方错误地释放了对象**
2. **或者 GC 的标记阶段有问题**

需要进一步调试来确认具体原因。

## 修复方案

### 方案 1：在 `func_data` 中直接持有 `module_obj`

```c
// js_wasm_instance_ctor 中创建导出函数
for (int i = 0; i < wasm_module->export_count; i++) {
    if (export.kind == WASM_IMPORT_EXPORT_KIND_FUNC) {
        JSValue func_data[2];
        func_data[0] = JS_DupValue(ctx, inst_obj);            // 持有 instance
        func_data[1] = JS_DupValue(ctx, wasm_inst->module_obj); // 持有 module！
        JSValue fn = JS_NewCFunctionData(ctx, js_call_wasm_bridge, 0, i, 2, func_data);
        JS_FreeValue(ctx, func_data[0]);
        JS_FreeValue(ctx, func_data[1]);
        JS_SetPropertyStr(ctx, exports_obj, export.name, fn);
    }
}
```

```c
// js_call_wasm_bridge 中使用 func_data[1] 获取 module
JSValue js_call_wasm_bridge(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic,
                            JSValue *func_data)
{
    QJWasmInstance *wasm_inst = JS_GetOpaque(func_data[0], js_webassembly_instance_class_id);
    QJWasmModule *wasm_module = JS_GetOpaque2(ctx, func_data[1], js_webassembly_module_class_id);
    // ...
}
```

**修复后的引用链**：

```
fn (JSFunction)
    │
    │ func_data[0] = inst_obj
    │ func_data[1] = module_obj  ← 直接持有 module！
    ▼
module_obj 可达 → QJWasmModule 不会被释放
```

### 为什么这个修复有效？

即使 `inst_obj` 被释放，`fn.func_data[1]` 仍然直接持有 `module_obj`，所以 `module_obj.ref_count >= 1`，不会被释放。

## 为什么注释掉 finalizer 能 work？

```c
static void js_wasm_module_finalizer(JSRuntime *rt, JSValue val)
{
    QJWasmModule *m = JS_GetOpaque(val, js_webassembly_module_class_id);
    if (m) {
        // 注释掉这些释放操作
        // wasm_runtime_unload(m->module);
        // js_free_rt(rt, m->buf);
        // js_free_rt(rt, m);
    }
}
```

这能 work 是因为：
- **不释放 `QJWasmModule` 结构体**：内存仍然有效
- **但这是内存泄漏**：每次创建/销毁模块都会泄漏内存
- **治标不治本**：正确的做法是正确管理引用计数

## 所有权规则：JS_SetPropertyStr 不会 dup

`JS_SetPropertyStr(ctx, obj, prop, val)` 内部调用 `set_value()`（`quickjs.c:2247`）：

```c
static inline void set_value(JSContext *ctx, JSValue *pval, JSValue new_val)
{
    JSValue old_val;
    old_val = *pval;
    *pval = new_val;              // 位拷贝 struct，ref_count 不变
    JS_FreeValue(ctx, old_val);   // 只释放旧值
}
```

**关键语义：** `JS_SetPropertyStr` **消费**了 `val` 的所有权。调用者之后不应再 `JS_FreeValue(val)`。

### 实际 bug：js_webassembly_instantiate 中的 double-free

```c
// 旧代码（有 bug）：
JSValue module_obj = create_wasm_module_object(ctx, buf, module);
// module_obj.ref = 1

// ctor 内部：wasm_inst->module_obj = JS_DupValue(ctx, module_obj);
// module_obj.ref = 2

JS_SetPropertyStr(ctx, result, "module", module_obj);
// module_obj.ref = 2 (wasm_inst->module_obj + result.module)
// 局部变量 module_obj 的所有权已转移

JS_FreeValue(ctx, module_obj);    // ← BUG! ref=1，但 result.module 仍在持有
// module_obj.ref = 1，但多个持有者中已扣除了一份不属于自己的引用

JS_FreeValue(ctx, inst_obj);      // ← 同理 BUG
```

释放 result 时：`result.module` 释放 → ref=0 → 对象被 finalizer 释放。
但 `wasm_inst->module_obj` 的位仍是野指针 → GC 时 `gc_decref_child` 断言 `p->ref_count > 0` 崩溃。

**修复：** 删除两个 `JS_FreeValue` 调用后 GC assertion 消失。

### 总结

| 函数 | 所有权行为 | 调用者是否需要 JS_FreeValue |
|------|-----------|---------------------------|
| `JS_SetPropertyStr` / `JS_SetPropertyUint32` | 消费 val | 不需要 |
| `JS_DefinePropertyValue` | 消费 val | 不需要 |
| `JS_NewCFunctionData` | dup 每个 data[i] | 需要（如果局部还要继续持有则 dup，否则 free） |
| `JS_DefineProperty` (with getter/setter) | dup getter/setter | 需要（原始值要自己 free） |

## 所有权规则速查

### 核心概念
`JSValue` 是 8 字节 struct（tag + union），传参时**位拷贝**。引用计数在堆上的 `JSGCObjectHeader` 中。
"所有权" = 你是否欠这个对象一个 `JS_FreeValue`。

### 经验法则
| 情况 | 所有权 | 示例 |
|------|--------|------|
| 函数返回 `JSValue` | 调用者获得所有权 | `JS_NewObject()` → 调用者持有 ref=1 |
| `argv[i]` 参数 | **借用，不拥有** | `argv[0]` 是调用栈的引用，不要 free |
| `JS_DupValue(v)` | 获得新所有权 | ref_count++，欠一个 `JS_FreeValue` |
| `JS_FreeValue(v)` | 归还所有权 | ref_count--，到 0 就释放 |

### 关键函数速查表
| 函数 | 对 val 的处理 | 调用者 |
|------|--------------|--------|
| `JS_SetPropertyStr(ctx, obj, p, val)` | **消费** val | 不需要 free |
| `JS_DefinePropertyValue(ctx, obj, atom, val, flags)` | **消费** val | 不需要 free |
| `JS_NewCFunctionData(ctx, ..., data)` | **dup** 每个 data[i] | 需要 free 原始 data[i] |
| `JS_DefineProperty(ctx, obj, atom, val, getter, setter, flags)` | **dup** getter/setter | 需要 free 原始值 |
| `JS_GetPropertyStr(ctx, obj, p)` | 返回新引用 | 调用者获得所有权，需要 free |

### 为什么 SetProperty 消费、GetProperty 返回新引用？
- `SetProperty`：如果你还要用，自己 `JS_DupValue`。避免内部不必要的 dup，性能设计。
- `GetProperty`：属性随时可能被删，必须 dup 后给你独立引用。

### 常见错误模式
```c
// ❌ double-free：SetProperty 已消费所有权
JSValue v = JS_NewObject(ctx);
JS_SetPropertyStr(ctx, obj, "p", v);
JS_FreeValue(ctx, v);  // ref 归零 → obj.p 变野指针

// ✓ 正确：所有权已转移
JSValue v = JS_NewObject(ctx);
JS_SetPropertyStr(ctx, obj, "p", v);

// ✓ 还要继续用：先 dup
JSValue v = JS_NewObject(ctx);
JSValue v2 = JS_DupValue(ctx, v);
JS_SetPropertyStr(ctx, obj, "p", v);  // 消费 v
// 用 v2 ...
JS_FreeValue(ctx, v2);
```

## 待解决的问题

1. **~~为什么 `inst_obj` 会被提前释放？~~** **已找到：** 是 `JS_FreeValue` double-free 导致引用计数提前归零。
2. **~~是否有其他地方错误地释放了对象？~~** **已找到：** `js_webassembly_instantiate` 中两个 `JS_FreeValue` 在 `JS_SetPropertyStr` 消费后又被调用。

## 相关文件

| 文件 | 说明 |
|------|------|
| `quickjs-wamr.c` | WASM Module/Instance 实现 |
| `quickjs-wamr.c:js_wasm_module_finalizer` | Module 释放函数 |
| `quickjs-wamr.c:js_wasm_instance_finalizer` | Instance 释放函数 |
| `quickjs-wamr.c:js_wasm_instance_mark` | Instance GC 标记函数 |
| `quickjs-wamr.c:js_wasm_instance_ctor` | Instance 构造函数（创建导出函数） |
| `quickjs-wamr.c:js_call_wasm_bridge` | 导出函数调用桥接 |
| `quickjs.c:js_c_function_data_mark` | C Function Data GC 标记函数 |
