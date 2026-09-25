# FFI 参数/返回值位宽与符号语义

## 一句话原则

**ABI 只按字节数（宽度）分类参数/返回值；"符号"只是读回时如何解释同一组位。所有符号相关的差异只存在于返回值 read-back 方向。**

对应代码：`quickjs-ffi.c`（`ffi_types[]`、参数槽、read-back switch）、`lib/ffi-bind.ts`（KIND 表、`'ptr'` 归一、签名 DSL）、`test/test_ffi_bind.ts`（signedness 回归锚点）。

## 1. 传参方向：只关心宽度，符号无关

- 参数槽 = 8 字节内存块（`uint64_t args[]`），`ffi_args[i]` 指向槽，libffi 按 `arg_types[i].size` 从槽起始拷 N 字节到栈槽/寄存器低位。
- 栈槽/寄存器槽宽度最小 4/8 字节（x86 cdecl/stdcall 栈 4 字节对齐、x64 寄存器/栈 8 字节）；**被调函数只读低 size 字节**。
- 因此窄类型当宽类型传安全（C 的 integer promotion 同理）：
  - 例：`int8` 参数告诉 libffi 是 `i32`，只要低字节位模式正确即可；
  - 越界截断也一致：传 `300` 给 `i8` 槽或 `i32` 槽，低字节都是 `0x2C`(44)；
  - x64 Win64 ABI 要求 8/16 位整参按 signedness 扩展，但被调方 `MOVSX` 读低字节仍正确。
- 同宽 `sintN`/`uintN` 传参完全等价，参数侧映射表理论上可塌成 `{32, 64, f32, f64, ptr}` 五档。当前 `KIND_TO_FFI` 因与返回表共用而未精简。

**例外（必须区分）：** x64/ARM64 寄存器 ABI 上浮点走 XMM、整数走 GPR，`FFI_TYPE_DOUBLE` ≠ `FFI_TYPE_UINT64`；x86 cdecl/stdcall 纯栈只看宽度（"传参只需 32/64 位两档"的直觉在 32 位栈 ABI 成立）。

### f32/f64：宽度是常数，与架构无关

`float`(IEEE 754 binary32) 恒 4 字节、`double`(binary64) 恒 8 字节，32/64 位架构、MSVC/GCC 全平台统一——**f32/f64 槽宽是常数，`memcpy` 固定 4/8 字节，不需要 arch 分支**。与指针相反：

| 类型 | 宽度 | 是否随架构 |
|---|---|---|
| float / double | 4 / 8 | 否（IEEE 754 固定） |
| ptr / 句柄 / WPARAM | 指针宽 | 是（ia32=4、x64=8，必须 `'ptr'`/`FFI_TYPE_POINTER`） |

四个要记住的区别：

1. **宽度**：4 vs 8。参数槽写 4/8 字节、返回槽 memcpy 4/8 字节，分开处理。
2. **寄存器类别**：64 位 ABI 浮点走 XMM、整数走 GPR，float 占 XMM 低 32 位、double 占满（vs §上方"例外"）。
3. **变参 promotion（最隐蔽的坑）**：C 的 default argument promotion——variadic 函数里 float 一律提升为 double（4→8 字节）。绑定 `printf/wsprintfW/wvsprintf` 等变参时 float 参数必须声明成 `f64`，否则字节数不一致 → 栈/寄存器错位（与 §1 历史教训同病根）。
4. **精度**：float 尾数 ~7 位十进制、double ~15-17 位；JS（QuickJS `double`）写进 `f32` 时精度已损失，值落地即定格。

**`long double` 是唯一例外**：gcc/x86 是 80 位扩展（12/16 字节），MSVC 不支持（=double 8 字节）。KIND 表不含它，正好避开。

### ffi-struct 字段顺序 = object 字面量顺序（ES [[OwnPropertyKeys]]）

`lib/ffi-struct.ts` 的 `layout()` 用 `Object.keys(def)` 迭代字段并按该顺序算 offset，所以**布局顺序 = 字面量写法顺序**。这不是约定俗成，而是 ECMA-262 `[[OwnPropertyKeys]]`（`OrdinaryOwnPropertyKeys`）的确定顺序：整数索引键先按数值升序，其余字符串键按插入顺序，最后 Symbol。`Object.keys`/`for-in` 均遵循。

**唯一陷阱**：字段名若是数字类字符串（如 `'0'`、`'1'`），会被规范按数值升序排到最前，破坏写法顺序。struct 字段名避免用数字键即可；布局可加校验拒绝。

### 历史教训：x86 栈错位

把句柄（HWND/HDC/WPARAM…）在 ia32 上绑成 `FFI_TYPE_UINT64` → libffi 每参数压 8 字节、被调函数（stcall 读 4 字节）栈消费 4 字节 → **后续所有参数栈偏移错位** → DrawTextW 参数错乱、text-measure 测宽为 0。

修复：句柄统一走 `FFI_TYPE_POINTER`（`size = sizeof(void*)`，由 libffi 编译目标架构决定，ia32=4/x64=8），`ffi-bind` 把 `*PTR/HANDLE/HWND/WPARAM/LPARAM...` 全部归 `'ptr'`。**指针宽由 libffi 决定，勿手选 `UINT32/UINT64`。**

## 2. 返回值 read-back：必须知道宽度 + 符号

返回槽 `uint64_t ret`（**必须显式初始化为 0**）。libffi 只写前 N 字节（N = 返回类型 size），其余字节保持初始值 0，这是"无符号/指针读回安全"的不变式（见 §4）。

- **x86**：窄整数返回只写低 N 字节。`sint32` 返回 `-1` → `ret = 0x00000000FFFFFFFF` → 直接 `(int64_t)ret` = 4294967295（**错**）。
- **x64**：Win64 ABI 要求被调方把 RAX 按返回类型扩展（sint32 符号扩、uint32 零扩）→ 直接读"碰巧正确" → **掩盖 bug**。实测：win7 x64 直读正确、xp x86 直读错误，bug 必须 x86 才暴露。

### 正确读回

| 返回类型 | 写法 | 说明 |
|---|---|---|
| i8/i16/i32 | `JS_NewInt64(ctx, (int64_t)(int32_t)ret)` | 两级必须显式：先 `(int32_t)` 截低 4 字节并作有符号解释，再按有符号源符号扩展补 1 |
| u8/u16/u32 | `JS_NewInt64(ctx, (uint32_t)ret)` | 依赖 `ret=0` 高位恒 0，`(uint32_t)` 截断是防御性（建议保留，成本为零）；零扩展由 C 隐式转换完成 |
| u64/i64 | `JS_NewInt64(ctx, (int64_t)ret)` | 全宽写满无垃圾，同宽转换位保持 |
| f32/f64 | `memcpy` 位拷贝 | 按浮点槽位取回 |
| ptr | 走 default（`(int64_t)ret` 同宽） | 零扩展读回正数 = 正确地址（Win 用户态地址按无符号解释即对，`/3GB` 下 bit31=1 也不变负）；正确性依赖 `ret=0` 清零，**非 bug** |

### 为什么要带符号（i32 vs u32）

同一组位数（如 `0xFFFFFFFF`），按 `int32` 解释 = −1、按 `uint32` 解释 = 4294967295。**唯一解释权在声明类型**——这就是 ffibind DSL 必须保留 `i/u` 前缀的实操落点。

编译器按强转链路的**中间类型**决定补位：有符号源合成符号扩展、无符号源零扩展；同宽 `i64↔u64` 位保持（补码平台，Windows 全平台满足）。C 标准：`unsigned→signed` 值不可表示为 implementation-defined（补码位保持），`signed→unsigned` 为明确 `mod 2^N`。

### 测试锚点（`test/test_ffi_bind.ts` §signedness read-back）

- `lstrcmpW("a","b")`：i32 = −1，u32 = 4294967295
- `SetLastError(0x80000000)` → `GetLastError`：u32 = 2147483648，i32 = −2147483648

QEMU 回归：`docker/http_test.sh <win7|xp> ffi` 应全过（win7 = x64、xp = x86，两架构都测；xp 的 `EnumPrintersW pcbNeeded=0` 为 VM 无打印机环境的既有失败，≤1 视为通过）。

## 3. int128？不需要

- C 标准（至 C23）无 `int128_t`；只是 GCC/Clang 的 `__int128` 扩展。
- **MSVC 不支持** `__int128` 标量整数（仅 `__m128i` SSE 向量/`_umul128` 辅助）。
- libffi 无 128 位整数类型；Win64/SystemV 的 128 位值非常规 ABI 传参（打包 struct 规则）。
- JS（QuickJS `double`）安全整数只到 2^53，承载不了。
- 结论：KIND 表停在 64 位是 Windows/ABI/MSVC 的真实边界。

## 4. 不变式 checklist（防止回归）

- [ ] `uint64_t ret = 0` 不得去掉初始化——无符号/ptr 读回正确性依赖零初始化（去掉即引入高位垃圾）
- [ ] 窄/无符号参数按宽传安全，但**指针宽必须用 `'ptr'`/`FFI_TYPE_POINTER`**，勿手选 `UINT32/UINT64`
- [ ] 有符号返回读回必须 `(int64_t)(sintN_t)ret` 两级显式
- [ ] f32/f64 在 64 位寄存器 ABI 必须区分（不能并入整数宽度）
- [ ] 变参函数的 float 参数必须按 `f64` 声明（default argument promotion）
- [ ] `float` 返回值 read-back 必须 memcpy 4 字节（x86/Win64 只写低 4 字节，高位未定义）
- [ ] 改过 `qwin*.exe` 后 QEMU 测试前 `./run.sh <vm> --restart`（Windows SMB 按路径缓存 exe）
- [ ] 传参表与返回表共用 `KIND_TO_FFI`；若要合并参数表须拆成两套映射（建议不合并）

## 5. 相关提交

- `d701efe` fix(ffi): 返回值 read-back 按声明类型符号/零扩展（§2 主修复）
- `7553ded` refactor(ffi): 参数槽 `union{i64,double}` → 纯 `uint64_t` 位宽槽（§1 传参模型）
- `d25f0fb` fix(ffi): `FFI_TYPE_POINTER` 收 number 句柄、修复 x86 栈错位（§1 教训）