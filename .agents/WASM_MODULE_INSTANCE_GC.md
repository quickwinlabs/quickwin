# WASM Module/Instance 引用计数问题分析（已结案）

> 结论先行：崩溃根因是 **`JS_SetPropertyStr` 已消费所有权后又手动 `JS_FreeValue`（double-free）**，
> 导致 `module_obj` 引用计数提前归零、`QJWasmModule` 悬空。修复 = 删掉多余 free + Instance 经
> `gc_mark` 持有 `module_obj`/`import_obj` 互保活。本文保留排错过程的核心推演与所有权规则速查。

## 问题现象

运行 MuPDF WASM 模块测试崩溃（退出码 2816）：调用 WASM 导出函数时
`wasm_inst->module` 是悬空指针——`js_wasm_module_finalizer` 已把 `QJWasmModule` 释放，
但导出函数仍持有指向它的指针。

## 数据结构（现行）

```c
typedef struct QJWasmModule {
    uint8_t *buf;
    wasm_module_t module;
    NativeSymbol *import_funcs;     // 宿主 import 的 native 符号表
    int32_t import_func_count;
} QJWasmModule;

typedef struct QJWasmInstance {
    JSContext *ctx;
    JSValue module_obj;             // JS 对象引用，GC 可见
    JSValue import_obj;
    wasm_module_inst_t inst;
} QJWasmInstance;
```

引用链（修复前，用户代码只解构 exports）：

```
exports_obj → fn(JSFunction) → func_data[0] = inst_obj
                                   └─ wasm_inst->module_obj (JSValue, GC 可见)
                                   └─ inst → wasm_module_inst_t → module（C 指针，GC 不可见）
```

用户代码 `const { db } = (await WebAssembly.instantiate(buf)).instance.exports;`
不保存 `result` → `result.module` / `result.instance` 的外部引用消失。

## 排错推演（压缩版）

1. **先怀疑 GC 误回收**：`js_wasm_instance_mark` 明明标记了 `inst->module_obj`，三阶段
   （gc_decref → gc_scan → gc_free_cycles，见 `QUICKJS_GC.md`）按理不会回收可达对象。
   引用计数推演显示 `module_obj` 恒 ≥1——**GC 标记没问题**。
2. **再查引用计数本身**：逐行核对 `js_wasm_instance_ctor` / `js_webassembly_instantiate`
   的 ref_count 账目，发现矛盾点不在 GC，而在**所有权**：

### 根因：`JS_SetPropertyStr` 消费所有权后的 double-free

```c
// 旧代码（有 bug）：
JSValue module_obj = create_wasm_module_object(ctx, buf, module);
// ctor 内部：wasm_inst->module_obj = JS_DupValue(ctx, module_obj);   // ref=2

JS_SetPropertyStr(ctx, result, "module", module_obj);  // 所有权已转移（ref 仍 = 2）

JS_FreeValue(ctx, module_obj);   // ← BUG：多扣一份不属于自己的引用 → ref=1
JS_FreeValue(ctx, inst_obj);     // ← 同理
```

`result` 释放 → `result.module` 释放 → ref=0 → `QJWasmModule` 被 finalizer 释放；
而 `wasm_inst->module_obj` 的位仍是野引用 → 下次 GC `gc_decref_child` 断言
`ref_count > 0` 崩溃（或 `js_call_wasm_bridge` 取到悬空 `module`）。

**修复 = 删除这两个 `JS_FreeValue`**，GC assertion 立即消失。

> ⚠️ 调试期间曾注释掉 `js_wasm_module_finalizer` 的释放体来"止血"——能 work 纯粹是
> 不再释放结构体（内存泄漏换稳定），治标不治本，勿模仿。

## 现行保活设计（不是当年的 func_data 方案）

当年推演过"导出函数 `func_data[1]` 直接持有 module_obj"的方案；**现行实现采用了更一般的
做法**：Instance 的 `gc_mark`（`js_wasm_instance_mark`）标记 `import_obj` + `module_obj`，
两个 JS 对象互相经 Instance 保活——Module 不会被先于 Instance 回收，
`js_call_wasm_bridge` 从 `func_data[0]`（instance）经 `wasm_inst->module_obj` 取 module。
Instance finalizer（`js_wasm_instance_finalizer`）显式 `JS_FreeValueRT` 释放两者。

## 所有权规则：JS_SetPropertyStr 不会 dup

`JS_SetPropertyStr(ctx, obj, prop, val)` 内部走 `set_value()`（quickjs.c）：位拷贝新值、
释放旧值——**`val` 的所有权被消费**，调用者之后不得再 `JS_FreeValue(val)`。

### 经验法则

| 情况 | 所有权 | 示例 |
|------|--------|------|
| 函数返回 `JSValue` | 调用者获得所有权 | `JS_NewObject()` → 调用者持有 ref=1 |
| `argv[i]` 参数 | **借用，不拥有** | 不要 free |
| `JS_DupValue(v)` | 获得新所有权 | 欠一个 `JS_FreeValue` |
| `JS_FreeValue(v)` | 归还所有权 | ref_count--，到 0 就释放 |

### 关键函数速查表

| 函数 | 对 val 的处理 | 调用者 |
|------|--------------|--------|
| `JS_SetPropertyStr` / `JS_SetPropertyUint32` | **消费** val | 不需要 free |
| `JS_DefinePropertyValue` | **消费** val | 不需要 free |
| `JS_NewCFunctionData(ctx, ..., data)` | **dup** 每个 data[i] | 需要 free 原始 data[i] |
| `JS_DefineProperty`（带 getter/setter） | **dup** getter/setter | 需要 free 原始值 |
| `JS_GetPropertyStr` | 返回新引用 | 调用者获得所有权，需要 free |

为什么 SetProperty 消费、GetProperty 返回新引用：Set 场景"还要用自己 dup"可省内部
多余 dup（性能设计）；Get 场景属性随时可能被删，必须 dup 后给独立引用。

### 常见错误模式

```c
// ❌ double-free：SetProperty 已消费所有权
JSValue v = JS_NewObject(ctx);
JS_SetPropertyStr(ctx, obj, "p", v);
JS_FreeValue(ctx, v);  // ref 归零 → obj.p 变野指针

// ✓ 所有权已转移，不再 free
JSValue v = JS_NewObject(ctx);
JS_SetPropertyStr(ctx, obj, "p", v);

// ✓ 还要继续用：先 dup
JSValue v = JS_NewObject(ctx);
JSValue v2 = JS_DupValue(ctx, v);
JS_SetPropertyStr(ctx, obj, "p", v);  // 消费 v
// 用 v2 ...
JS_FreeValue(ctx, v2);
```

## 相关文件

| 符号 | 位置 |
|------|------|
| `QJWasmModule` / `QJWasmInstance` 定义、`js_wasm_module_finalizer`、`js_wasm_instance_finalizer`、`js_wasm_instance_mark`、`js_wasm_instance_ctor`、`js_call_wasm_bridge` | `src/quickjs-wamr.c` |
| `js_c_function_data_mark`、`set_value` | `deps/quickjs/quickjs.c` |
| GC 三阶段算法讲解 | `.agents/QUICKJS_GC.md` |
