# FFI 类型推导：签名就是类型

调用一个 C 函数，通常要写两份东西——**签名**给运行时，**类型声明**给编译器。两份靠人保持同步，改了签名忘了改类型，或者写反了参数顺序，只能等运行期出错。

QuickWin 只写一份。签名字符串同时是 C 声明、ABI 布局和 TypeScript 类型的**唯一来源**：

```ts
const GetDeviceCaps = bind('gdi32.dll', 'GetDeviceCaps', '<HDC>ptr! i32@DeviceCap -> i32')
```

这个签名同时给出了：两个参数的 C 类型、`hdc` 位不能传空、`index` 必须是 `DeviceCap` 枚举值、返回 `number`——以及它们在寄存器与栈上的位置。

（`lib/windows/` 里写成 `b('GetDeviceCaps', '<HDC>ptr! i32@DeviceCap -> i32')`，那是每个 DLL 文件自己定义的简写，把 DLL 名固定下来，其余完全相同。）

---

## 两条推导链

```
     bind('gdi32.dll', 'GetDeviceCaps', '<HDC>ptr! i32@DeviceCap -> i32')
                                      │
                 ┌────────────────────┴────────────────────┐
                 ↓                                         ↓
        【运行时】                                      【编译期】
   normToken 归一 token                            BindFn<S, E, D>
        ↓                                              ↓
   callPlan：槽位 / 寄存器 / 栈                ParseArgStr 按空格切 token
        ↓                                              ↓
   ffiCall → .S 桩                               ArgJsTypeOfToken / RetJsTypeOfToken
                                                       ↓
                                                函数的参数与返回类型
```

两条链读同一串 token，互不干扰：编译期那条不会调用任何代码，运行期那条不参与类型。

## 运行时：推 ABI 布局

`callPlan` 从类型推出调用约定本身——第几个槽位、走寄存器还是栈、返回值是 `rax` 还是 `xmm0`。使用者不需要知道影子空间、栈对齐、同槽双读这些细节。

详见 [ffi-internals.md](ffi-internals.md)。

## 编译期：推 TS 类型

```ts
type BindFn<S extends string, E, D> =
    S extends `${infer ArgStr} -> ${infer RetStr}`
        ? ((...args: ParseArgStr<ArgStr, E>) => RetJsTypeOfToken<RetStr, D>)
        : never
```

`ParseArgStr` 按空格把参数串切成 token，逐个走 `ArgJsTypeOfToken`；返回串走 `RetJsTypeOfToken`。两个映射都带一张**布局表**（`E` 入参 / `D` 返回），值域从 codec 里提取出来，所以结构体、字符串、指针的 JS 形也是推出来的，不是用户声明的。

`bind()`、`bindLib()`、`closure()` 三者共用 `BindFn`，因此回调和被调函数拿到的是同一套类型推导。

## 规则表

| token | 参数位 | 返回位 |
|---|---|---|
| `u8` `u16` `u32` `i8` `i16` `i32` `f32` `f64` | `number` | `number` |
| `i64` `u64` | `bigint` | `bigint` |
| `void` | — | `void` |
| `<>ptr`（裸地址） | `number` | `number` |
| `<WCHAR>ptr` | `string \| MaybePtr<'WCHAR'>` | `string \| NULL` |
| `<BYTE>ptr` | `PtrArrayBuffer \| MaybePtr<'BYTE'>` | `MaybePtr<'BYTE'>` |
| `<RECT>ptr` | `MaybePtr<'RECT'> \| 布局入参形` | `布局 decode 形 \| NULL` |
| `<RECT>ptr!` | **去掉 `NULL` 分支** | **去掉 `NULL` 分支** |
| `<RECT>`（无 `ptr`） | 按值传参，布局入参形 | — |
| `u32@DeviceCap` | `EnumMap['DeviceCap']` | `EnumMap['DeviceCap']` |
| 拼错的 token | **`never`**（调用点全红） | **`unknown`**（逼显式收窄） |

`<WCHAR>` / `<BYTE>` 是内建 codec，它们的值域直接注入布局表，所以在类型层看起来和用户定义的结构体没有任何区别。

## 担保与值域：`!` 和 `@`

两个后缀，语义在**类型层收紧，运行时执法**。

### `!` — 非空担保

```
<HDC>ptr    →  MaybePtr<'HDC'>        可以是 0
<HDC>ptr!   →  Ptr<'HDC'> + 运行时检查  不能是 0
```

- **类型层**：返回类型去掉 `NULL` 分支，参数位不再接受 `0`
- **运行时**：实参为 0 时直接抛
  `(null pointer forbidden here; the token marks this position non-null)`
- **回调里方向相反**：C 传了 0 进来，跳过回调而不是当成用户错误

### `@` — 枚举值域

```
u32@DeviceCap  →  EnumMap['DeviceCap']
```

- **类型层**：收紧成枚举类型，拦异种枚举、拦域外字面量
- **表的来源**：`EnumMap` 是全局 interface，由 `tools/gen_const.c` 生成时预填（`constants.ts` 末尾的 `declare global` 段），用户可以在自己的 `.d.ts` 里直接扩展
- **`codec` 位刻意不标 `@`**：codec 入参会编码成地址，地址必然落在枚举域外，标了等于留一个绕过值域承诺的无检查后门

## 失败也是类型

| 出错方式 | 参数位 | 返回位 |
|---|---|---|
| token 拼错、用了 typedef 别名（`DWORD`/`HANDLE`） | `never` | `unknown` |
| 按值位引用了未注册的布局（`<RECT>`） | `never` | `unknown` |
| 未知枚举名（`u32@Nope`） | `never` | `unknown` |

**指针位不受这条约束**：`<RECT>ptr` 即使没注册布局也照样能传地址（`MaybePtr<'RECT'>`），返回位是 `MaybePtr<'RECT'> | NULL`。只有按值位必须有布局，才会塌成 `never`。

这里有个**刻意的不对称**：`never` 是 bottom，会被任意类型使用处放行——用在返回位上等于什么都不检查。所以参数位用 `never` 拦死调用点，返回位用 `unknown` 逼调用方显式收窄。

```ts
// 参数位 token 拼错（'u33' 不在词表）→ 塌 never，调用点整行变红
type P = ArgJsTypeOfToken<'u33', {}>          // never

// 返回位 token 拼错（'i3z'）→ 塌 unknown，拿到手不能直接用
type R = RetJsTypeOfToken<'i3z', {}>          // unknown
```

两种错落在不同位置：参数位让函数**调不动**，返回位让结果**用不了**。同样的错运行时也会在 bind 阶段由 `normToken` 抛出来，见下面的「双层防线」。

## 双层防线

同一处出错，编译期和运行时各有一道：

| 出错方式 | 编译期 | 运行时 |
|---|---|---|
| token 拼错 | `never`，调用点全红 | `normToken` throw `Unknown token: ...` |
| 传 NULL 给 `!` 位 | 类型里没有 `NULL` 分支 | 0 检查 throw |
| 传异种枚举 / 域外字面量 | 枚举类型的 nominal 拦 | — |
| 按值位布局未注册 | `never` | `unknown` |
| 泛型体内动态传入 | — | `normToken` 兜底 throw |

运行时那一层不是冗余：泛型代码、`bindLib` 的动态键、JSON 来的签名都能绕过类型层，`normToken` 是最后一道 fail-loud。

## 类型层自己也会出错的地方

泛型未解析时（`closure` / `bindLib` 的函数体内，token 还只是 `string`），映射会索引不到任何键。代码里给这一位加了 `string & keyof map` 兜底成非 `never`，否则 `BindFn` 会塌成 `(never) => never`，让内部的类型断言失去可比性。

这是纯类型层的工程细节，不写在文档里也可以不理解，但它是这套推导能长期不塌的前提。

## 单一来源的意义

类型从签名推出来，意味着**类型不可能与签名不一致**——因为只有一个来源。

改签名的那一刻，参数数量、顺序、值域、可空性全部自动跟着变，没有任何地方需要人工同步。上面的规则表、两道防线、以及参数位与返回位的不对称，都是在服务这一件事。
