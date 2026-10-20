// COM 约定层：HRESULT 判定 + GUID 字符串转字段。ole32.ts 只放绑定，语义在这里。
//
// HRESULT 的 bit 31 是严重性位：0 = 成功。S_OK 和 S_FALSE **都是**成功，故别写
// hr === 0——CoInitializeEx 在同线程同模型下重复初始化就返回 S_FALSE。
// FAILED 是 SUCCEEDED 的反义，两个都留是照 SDK 宏的原样（SDK 里也是这两个）。
//
// 这两个 helper 只属于 COM 语义：Win32 的返回值约定相反（0 = 成功，非 0 = 失败），
// 故不进通用层。
//
// guidFields 只做「字符串 → C 字段」，不建缓冲、不碰品牌：布局位注册了 CLSID/IID 的
// encoder（见 ole32.ts），对象形直接喂 <N>ptr 位，由 mkPtrWriter 编码后取 .ptr。
// 数值来源仍是 constants.ts 的 Guid enum（gen_const.c 从 SDK 头生成），不在此手写。
// 代价：对象形不带品牌，rclsid/riid 互换编译期拦不住（指针形 CLSID.encode().ptr 才拦）。
//
// COM 方法没有导出名，用 ffi.readPtr + bindAt 按 vtable 槽派发，例：
//   const release = bindAt(ffi.readPtr(ffi.readPtr(pUnk) + 2 * PTR_SIZE), '<>ptr -> u32')

export function SUCCEEDED(hr: number): boolean {
    return (hr & 0x80000000) === 0
}

export function FAILED(hr: number): boolean {
    return !SUCCEEDED(hr)
}

// GUID 的 C 字段形（与 GUID_DECL 同名字段）。Data4 必须是 8 元组——普通 number[]
// 过不了 encode 的类型；且无返回类型标注时函数会把数组推成 number[]。
type GuidFields = {
    Data1: number
    Data2: number
    Data3: number
    Data4: [number, number, number, number, number, number, number, number]
}

// GUID 显示形 '{000214F9-0000-0000-C000-000000000046}' → C 字段。花括号与连字符
// 一律剥掉，只剩 32 个 hex 位才算合法（8+4+4+4+12）——容花括号可省，校验只是一次长度判断。
// 字节序约定（Data1/2/3 按主机序小端落内存、Data4 逐字节原样）由 struct.encode 承担，
// 此处只切分，不解释。
export function guidFields(s: string): GuidFields {
    const h = s.replace(/[^0-9A-Fa-f]/g, '')
    if (h.length !== 32)
        throw new Error(`com: not a GUID string (32 hex digits expected): ${s}`)
    const b = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return {
        Data1: parseInt(h.slice(0, 8), 16),
        Data2: parseInt(h.slice(8, 12), 16),
        Data3: parseInt(h.slice(12, 16), 16),
        // Data4 八字节 = 第 4 组 2 个 + 第 5 组 6 个
        Data4: [b(16), b(18), b(20), b(22), b(24), b(26), b(28), b(30)],
    }
}
