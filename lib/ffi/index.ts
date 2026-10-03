// FFI 公共入口：bind()/bindLib()/closure()（bind.ts）+ struct()/structFromPtr()（struct.ts）。
// 共享的标量 kind / C 别名表在 kind.ts（bind.ts 再透传其类型与函数）。
// 仓库内调用点按需深引用（./bind.js / ./struct.js / ./kind.js）以保留 tree-shaking；
// 此 barrel 主要供外部/package 使用。
export * from './bind.js'
export * from './struct.js'
