// React 19 的 JSX 命名空间已从全局挪进 react 模块（React.JSX）。本文件给 quickwin
// 提供一个「只有 w 一个 host 元素」的全新 JSX 命名空间：消费方把 tsconfig 的
// jsxImportSource 设成 'quickwin/lib/react-qw'，<div>/<span> 等 HTML 标签就在类型层
// 报错（它们不是 quickwin 渲染器支持的宿主元素，运行时 CreateWindow 会失败），只留 <w>。
//
// 注意：
// - 必须是 .d.ts（不能是 .ts）：实测 .ts 里的 `namespace JSX` 不被 jsxImportSource
//   机制识别（TS7026）。
// - 用具名导出/直接声明，不要 `export * from 'react/jsx-runtime'`——那会把 react 的
//   JSX 命名空间一起带进来，与这里的 namespace JSX 合并，HTML 元素又回来了。
// - 运行时实现在 jsx-runtime.js（re-export react 的 jsx/jsxs/Fragment），由 Makefile
//   在 npm-pkg 时拷进构建产物。
import type * as React from 'react'
import type { WIntrinsicProps } from './jsx.js'

export const Fragment: React.ExoticComponent<{ children?: React.ReactNode }>
export function jsx(type: any, props: any, key?: any): React.ReactElement
export function jsxs(type: any, props: any, key?: any): React.ReactElement
export function jsxDEV(
  type: any, props: any, key?: any, isStaticChildren?: any,
  source?: any, self?: any,
): React.ReactElement

export namespace JSX {
  // ElementType 必须定义：TS 靠它判断函数组件（forwardRef/FC 返回 ReactNode）是否合法；
  // 不定义的话回落成「组件必须返回 JSX.Element」，ReactNode 会报 TS2786。
  // 注意：这只是组件检查，不影响 intrinsic 元素——intrinsic 只查 IntrinsicElements（只有 w）。
  type ElementType = string | React.JSXElementConstructor<any>
  interface Element extends React.ReactElement<any, any> {}
  interface ElementClass extends React.Component<any> {
    render(): React.ReactNode
  }
  interface ElementAttributesProperty {
    props: {}
  }
  interface ElementChildrenAttribute {
    children: {}
  }
  interface IntrinsicElements {
    w: WIntrinsicProps
  }
}
