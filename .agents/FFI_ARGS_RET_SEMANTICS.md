# FFI 参数/返回值位宽与符号语义

## 一句话原则

**ABI 只按字节数（宽度）分类参数/返回值；"符号"只是读回时如何解释同一组位。所有符号相关的差异只存在于返回值 read-back 方向。**

对应代码：`lib/ffi/bind.ts`（`ARG_SIZE` 槽宽表、`writeSlot` 打包、`readRet` 读回、kind 与 `'ptr'` 归一、签名 DSL）、`quickjs-ffi.c`（`ffiCall` 只做「搬运 + call + 取原始返回」）、`test/test_ffi_bind.ts` + `test/test_ffi_abi.ts`（signedness/边界回归锚点）。

## 1. 传参方向：只关心宽度，符号无关

- 每个参数在 `argFrame` 里占一个槽；JS `writeSlot` 按 `ARG_SIZE[kind]` 写 N 字节（ia32：≤4B 类型进 4 字节、8B 类型进 8 字节；x64：恒 8 字节）。汇编桩再把槽搬进栈槽/寄存器低位。
- 栈槽/寄存器槽宽度最小 4/8 字节（x86 cdecl/stdcall 栈 4 字节对齐、x64 寄存器/栈 8 字节）；**被调函数只读低 size 字节**。
- 因此窄类型当宽类型传安全（C 的 integer promotion 同理）：
  - 例：`i8` 参数绑定层写进 4 字节槽，只要低字节位模式正确即可；
  - 越界截断也一致：传 `300` 给 `i8` 槽或 `i32` 槽，低字节都是 `0x2C`(44)；
  - x64 Win64 ABI 要求 8/16 位整参按 signedness 扩展，但被调方 `MOVSX` 读低字节仍正确。
- 同宽 `iN`/`uN` 传参完全等价，参数侧槽宽理论上可塌成 `{4, 8, ptr}` 档。当前 `ARG_SIZE` 与返回解码 `readRet` 共用同一 kind 表。

**例外（必须区分）：** x64 寄存器 ABI 上浮点走 XMM、整数走 GPR，`f64` ≠ `u64`；x86 cdecl/stdcall 纯栈只看宽度（"传参只需 32/64 位两档"的直觉在 32 位栈 ABI 成立）。

### f32/f64：宽度是常数，与架构无关

`float`(IEEE 754 binary32) 恒 4 字节、`double`(binary64) 恒 8 字节，32/64 位架构、MSVC/GCC 全平台统一——**f32/f64 槽宽是常数，`setFloat32`/`setFloat64` 固定 4/8 字节，不需要 arch 分支**。与指针相反：

| 类型 | 宽度 | 是否随架构 |
|---|---|---|
| float / double | 4 / 8 | 否（IEEE 754 固定） |
| ptr / 句柄 / WPARAM | 指针宽 | 是（ia32=4、x64=8，签名里必须写 `'<>ptr'`） |

四个要记住的区别：

1. **宽度**：4 vs 8。参数槽写 4/8 字节、返回槽读 4/8 字节，分开处理。
2. **寄存器类别**：64 位 ABI 浮点走 XMM、整数走 GPR，float 占 XMM 低 32 位、double 占满（vs §上方"例外"）。
3. **变参 promotion（最隐蔽的坑）**：C 的 default argument promotion——variadic 函数里 float 一律提升为 double（4→8 字节）。绑定 `printf/wsprintfW/wvsprintf` 等变参时 float 参数必须声明成 `f64`，否则字节数不一致 → 栈/寄存器错位。**当前实现不支持 varargs**（`AL` 恒 0），此条仅作未来扩展的提醒。
4. **精度**：float 尾数 ~7 位十进制、double ~15-17 位；JS（QuickJS `double`）写进 `f32` 时精度已损失，值落地即定格。

**`long double` 是唯一例外**：gcc/x86 是 80 位扩展（12/16 字节），MSVC 不支持（=double 8 字节）。kind 表不含它，正好避开。

### ffi-struct 字段顺序 = object 字面量顺序（ES [[OwnPropertyKeys]]）

`lib/ffi/struct.ts` 的 `layout()` 用 `Object.keys(def)` 迭代字段并按该顺序算 offset，所以**布局顺序 = 字面量写法顺序**。这不是约定俗成，而是 ECMA-262 `[[OwnPropertyKeys]]`（`OrdinaryOwnPropertyKeys`）的确定顺序：整数索引键先按数值升序，其余字符串键按插入顺序，最后 Symbol。`Object.keys`/`for-in` 均遵循。

**唯一陷阱**：字段名若是数字类字符串（如 `'0'`、`'1'`），会被规范按数值升序排到最前，破坏写法顺序。struct 字段名避免用数字键即可；布局可加校验拒绝。

### 历史教训：x86 栈错位

把句柄（HWND/HDC/WPARAM…）在 ia32 上按 8 字节宽传 → 被调函数（stdcall 读 4 字节）只消费 4 字节 → **后续所有参数栈偏移错位** → DrawTextW 参数错乱、text-measure 测宽为 0。

修复：句柄统一走指针宽（签名里写 `'<>ptr'` → 内部 kind `'ptr'`，槽宽 `PTR_SIZE = os.arch === 'x64' ? 8 : 4`），`ffi-bind` 把 `*PTR/HANDLE/HWND/WPARAM/LPARAM...` 全部归一为 `'<>ptr'`。**指针宽由目标架构决定，勿手选 `u32/u64`。**

## 2. 返回值 read-back：必须知道宽度 + 符号

`retBuf` 是 JS `new ArrayBuffer(8)`，**天然零初始化**；汇编桩把返回写进它（ia32 固定写满 8 字节，32 位及更窄返回的高 4 字节可能为残留；x64 写 RAX+XMM0）。`readRet(kind, retBuf)` 按声明宽度取字节并解释符号。

- **x86**：窄整数返回只有 EAX 有效、EDX 是残留垃圾。`readRet` 只取需要的低 N 字节，故不受高字节垃圾影响；64 位返回则用满 8 字节。
- **x64**：Win64 ABI 要求被调方扩展 RAX；`readRet` 仍按声明类型显式截断，不依赖被调方扩展。

### 正确读回（`lib/ffi/bind.ts` `readRet`）

| 返回类型 | 写法 | 说明 |
|---|---|---|
| i8 | `getUint8(0)`，`>0x7F` 减 `0x100` | 低字节有符号 |
| i16 | `getUint16(0,true)`，`>0x7FFF` 减 `0x10000` | 低字有符号 |
| i32 | `getInt32(0, true)` | 低 4 字节有符号 |
| u8/u16/u32 | `getUint32(0,true)` 后按位掩码 / 直接 | 零扩展 |
| u64/i64 | `getBigUint64`/`getBigInt64` → `bigint` | 全宽精确，JS 侧保持 bigint，不降级 Number |
| f32/f64 | `getFloat32`/`getFloat64` | 按浮点槽位取回 |
| ptr | 读指针宽，0 → `null` | 地址按无符号解释 |

### 为什么要带符号（i32 vs u32）

同一组位数（如 `0xFFFFFFFF`），按 `int32` 解释 = −1、按 `uint32` 解释 = 4294967295。**唯一解释权在声明类型**——这就是 ffi-bind DSL 必须保留 `i/u` 前缀的实操落点。

### 测试锚点（`test/test_ffi_bind.ts` §signedness read-back + `test/test_ffi_abi.ts`）

- `lstrcmpW("a","b")`：i32 = −1，u32 = 4294967295
- `SetLastError(0x80000000)` → `GetLastError`：u32 = 2147483648，i32 = −2147483648
- 窄宽度负数返回 `lstrcmpW -> i8/i16/i32` 均 < 0；`InterlockedIncrement64(-2) -> i64 = -1`

QEMU 回归：`docker/http_test.sh <xp|win11> ffi` 应全过（win11 = x64、xp = x86，两架构都测；本仓库测试环境无 win7）。

## 3. int128？不需要

- C 标准（至 C23）无 `int128_t`；只是 GCC/Clang 的 `__int128` 扩展。
- **MSVC 不支持** `__int128` 标量整数（仅 `__m128i` SSE 向量/`_umul128` 辅助）。
- 手写桩沿用「标量 ≤64 位」的 ABI 前提；Win64/SystemV 的 128 位值非常规 ABI 传参（打包 struct 规则）。
- JS（QuickJS `double`）安全整数只到 2^53，承载不了。
- 结论：kind 表停在 64 位是 Windows/ABI/MSVC 的真实边界。

## 4. 不变式 checklist（防止回归）

- [ ] `retBuf` 恒 8 字节且 `new ArrayBuffer(8)` 零初始化——无符号/ptr 读回正确性依赖零初始化
- [ ] 窄/无符号参数按宽传安全，但**指针宽必须用 `'<>ptr'`**（内部 kind `'ptr'`），勿手选 `u32/u64`
- [ ] 有符号返回 `readRet` 必须按声明宽度符号扩展
- [ ] f32/f64 在 64 位寄存器 ABI 必须区分（不能并入整数宽度）
- [ ] varargs 暂不支持；若将来支持，float 参数必须按 `f64` 声明（default argument promotion）
- [ ] f32 返回 read-back 读 4 字节（x86/Win64 只写低 4 字节，高位未定义）
- [ ] 改过 `qwin*.exe` 后 QEMU 测试前 `./run.sh <vm> --restart`（Windows SMB 按路径缓存 exe）
- [ ] 参数槽宽 `ARG_SIZE` 与 `quickjs-ffi-type.h` 的 `qwin_ffi_arg_size[]` 保持一致

## 5. 相关提交

- `5ea5fb0` test(ffi): migrate test_ffi to bind(), port examples off ffiCall
- `3deec20` refactor(ffi): drop legacy ffiCall, rename ffiCallRaw to ffiCall
- `62ddfee` refactor(ffi): drop redundant byte-count args from ffiCallRaw
- `211944c` refactor(ffi): drop libffi from the build, keep submodule as ABI reference
- `d701efe` fix(ffi): 返回值 read-back 按声明类型符号/零扩展（§2 主修复）
- `7553ded` refactor(ffi): 参数槽 `union{i64,double}` → 纯 `uint64_t` 位宽槽（§1 传参模型）
- `d25f0fb` fix(ffi): `FFI_TYPE_POINTER` 收 number 句柄、修复 x86 栈错位（§1 教训）
