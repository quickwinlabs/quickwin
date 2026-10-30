// 运行时实现：复用 react 的 JSX 工厂（React 元素本体不变，reconciler 照常工作）。
// 类型面见 jsx-runtime.d.ts（namespace JSX 只有 w，无 HTML 元素）。
// 注意：不要用 `export *`——会连带导出 react 的 JSX 命名空间，与 .d.ts 的合并后
// HTML 元素又回来了；具名导出只带工厂函数。
export { Fragment, jsx, jsxs } from 'react/jsx-runtime'
export { jsxDEV } from 'react/jsx-dev-runtime'
