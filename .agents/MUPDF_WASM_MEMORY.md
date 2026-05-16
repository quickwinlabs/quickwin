# mupdf-wasm 内存分析（已解决）

## 原问题

`page.toPixmap(mupdf.Matrix.scale(6, 6), ...)` 在 scale 6 时曾失败，报 `Heap is corrupted` / `app heap is corrupted` / `unreachable` 错误。

## 当前状态（2026-05-14）

**scale 6 可正常工作。** 测试输出：
```
pixmap: 3570 x 5052    ← 595×6=3570, 842×6=5052
png size: 133654
saved to output.png
done
```

## 问题原因（历史分析）

### WASM 模块信息（mupdf-wasm.wasm）

| 属性 | 值 | 说明 |
|------|-----|------|
| 初始内存 | 351 页 = ~22.5MB | 初始内存 |
| 最大内存 | **32768 页 = 2GB** | **上限充足，不是限制因素** |
| `malloc`/`free` 导出 | **无** | WAMR 无法自动检测并接管内存 |
| `__heap_base` 导出 | **无** | WAMR 无法通过该全局变量定位堆 |
| Memory 导出 | `cb` | 线性内存 |

### 内存需求计算（A4 页面，595×842 pt）

| Scale | 像素 (W×H) | RGBA (4 通道) | 说明 |
|-------|------------|---------------|------|
| 1× | 595×842 | ~2.0MB | 初始 22.5MB 内 |
| 2× | 1190×1684 | ~8.0MB | 初始 22.5MB 内 |
| 4× | 2380×3368 | ~32.0MB | 需 memory.grow |
| 6× | 3570×5052 | ~72.1MB | 需 memory.grow（当前可工作） |

## 可能的修复点

该问题在以下改动后解决，原因未完全确定：

1. **WAMR 重建 (`WAMR_BUILD_EXCE_HANDLING=1`)** — 修正了 `WASMModule` 结构体偏移
2. **Import global 链接实现** — 修正了 Instance 构造逻辑
3. **App heap 参数 `heap_size=40960`** — 当前值可使 scale 6 正常工作

当前 `wasm_runtime_instantiate` 参数：
| 参数 | 当前值 | 说明 |
|------|--------|------|
| stack_size | 65536 (64KB) | WASM 栈大小 |
| heap_size | 40960 (40KB) | WAMR app heap 大小 |

## 结论

scale 限制问题已不存在。请定期运行 `test/mupdf.js` 验证回归。

## 相关文件

- `mupdf-wasm/mupdf-wasm.wasm` — MuPDF WASM 二进制（~10MB, 6876 函数）
- `quickjs-wamr.c` — WAMR + QuickJS 集成（`wasm_runtime_instantiate` 调用位置）
- `test/mupdf.ts` — 测试入口（当前使用 scale 2）
- `.agents/MUPDF_PROGRESS.md` — 移植进度总览
