# React Custom Renderer 实现方案

## 当前进度

**已完成：**
- ✅ 步骤 1：清理 preact
- ✅ 步骤 2：安装依赖 + esbuild bundle
- ✅ 步骤 3：JSX 类型声明
- ✅ 步骤 4：Reconciler Host Config（基础实现）
- ✅ 步骤 5：公开 API（render, createRoot）
- ⚠️ 步骤 6：组件移植（进行中）

**已解决的问题：**
1. **TypeScript 增量编译问题** - 关闭增量编译解决
2. **调度函数缺失** - 添加 `resolveEventType`, `resolveEventTimeStamp`, `trackSchedulerEvent`
3. **onEvent prop 更新问题** - `createInstance` 中始终设置 `SetWindowProc`，窗口过程通过 `instance.props.onEvent` 访问回调
4. **prepareUpdate 性能优化** - 比较关键 props，只在有差异时返回 true
5. **clearContainer 导致子窗口被销毁** - `clearContainer` 在首次渲染时被调用，会销毁刚创建的子窗口。修复：`clearContainer` 改为空实现，React reconciler 会通过 `removeChildFromContainer` 来移除子节点（与 Ink 的实现一致）
6. **DestroyWindow 后按钮视觉残留** -
   `removeChildFromContainer` 调用 `DestroyWindow` 销毁子窗口 HWND 后，
   由于父窗口类注册时未设 `hbrBackground`（`WNDCLASSEXW` 初始化为全零，
   默认为 `NULL`），`DefWindowProc` 处理 `WM_ERASEBKGND` 时不填充暴
   露区域，导致已销毁按钮的视觉像素残留在屏幕上（表现为"按钮还在但点不
   动"）。

   **可选方案：**
   - **方案 A（已实施）**：在 `quickjs-gui.c:js_registerClass` 中添加
     `wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);`，全局默认使用系
     统背景色，所有已注册窗口类均获得自动擦除能力
   - **方案 B**：在 WNDPROC 中手动处理 `WM_ERASEBKGND`，用特定画刷填充
     背景，适用于需要自定义背景色的场景
   - **方案 C**：在 `removeChildFromContainer` 中用
     `GetClientRect` + `FillRect` 绘制父窗口特定区域，精确清除但代码较
     侵入

**待改进：**
- `prepareUpdate` 可进一步优化为返回 payload 数组（类似 react-dom 的 diffProperties），让 `commitUpdate` 只处理变化的属性

---

## 目标

在 QuickWin 中实现 React Custom Renderer，使得可以用 React 19 的 API（useState、useEffect 等）编写 Win32 GUI 应用。**完全替换现有 preact 实现**（分支上删除 `lib/preact/`）。

```
vendor/
└── react/
    ├── entries/
    │   ├── react.js              # esbuild 入口：重新导出 react + react/jsx-runtime
    │   └── react-reconciler.js   # esbuild 入口：重新导出 react-reconciler
    ├── react.js                  # esbuild 产物（22kb）
    └── react-reconciler.js       # esbuild 产物（425kb）

lib/
├── react-qw/                 # React custom renderer
│   ├── jsx-runtime.ts         # 1行重导出 → vendor/react/react.js
│   ├── reconciler.ts
│   ├── index.ts
│   ├── react.d.ts
│   ├── reconciler.d.ts
│   ├── jsx.d.ts
│   ├── props.ts
│   └── components/
│       ├── Button.tsx
│       ├── EditBox.tsx
│       ├── ListBox.tsx
│       ├── ListView.tsx
│       └── Tab.tsx
└── polyfill.js               # 保留
```

---

## 计划步骤

### 步骤 1 — 清理 preact + 调整构建配置

1. 删除 `lib/preact/` 整个目录
2. 更新 `tsconfig.json`：将 `jsxImportSource` 从 `"../lib/preact"` 改为 `"../lib/react-qw"`（指向 lib/react-qw/jsx-runtime.ts，内有一行重导出到 vendor bundle）
3. 删除/清理 preact 的示例和测试：
   - `examples/preact_demo.tsx`、`test/test_preact_ref.ts`、`test/test_components.ts`
4. 检查 `Makefile` 中 `npm-pkg` target 的 preact 引用
5. 创建 `lib/react-qw/` 目录结构

---

### 步骤 2 — 安装依赖 + esbuild bundle

npm 安装 runtime 依赖，用 esbuild 打包为 ESM 格式，放入 `vendor/react/`。

```bash
npm install react@19 react-reconciler@0.33.0 --force
npm install --save-dev esbuild @types/react@19 @types/react-reconciler --force
```

**esbuild 打包：**

```bash
npx esbuild --bundle --format=esm \
  --define:process.env.NODE_ENV=\"production\" \
  --outfile=vendor/react/react.js \
  vendor/react/entries/react.js

npx esbuild --bundle --format=esm \
  --outfile=vendor/react/react-reconciler.js \
  vendor/react/entries/react-reconciler.js
```

**入口文件内容：**

```js
// vendor/react/entries/react.js
export {
  createElement, useState, useEffect, useRef, useMemo, useCallback,
  useLayoutEffect, useReducer, useContext, Fragment, createRef, memo,
  createContext, useImperativeHandle, useDebugValue,
} from "react"
export { jsx, jsxs } from "react/jsx-runtime"

// vendor/react/entries/react-reconciler.js
export { default as ReactReconciler } from "react-reconciler"
```

**jsx-runtime 桥接：** TypeScript 的 `jsxImportSource` 自动追加 `/jsx-runtime` 后缀，所以需要 `lib/react-qw/jsx-runtime.ts` 做一行重导出：

```ts
export { jsx, jsxs, jsxDEV } from '../../vendor/react/react.js'
```

**要点：**
- esbuild 会将 `react` + `scheduler` + `react/jsx-runtime` 打包到 `vendor/react/react.js`
- `--force` 绕过 package.json 的 `"os": ["win32"]` 限制（仅 Linux 开发环境需要）
- `process.env.NODE_ENV` 用 `--define` 替换为 `"production"`
- QuickJS 无需 DOM polyfill，react 核心不依赖 DOM
- `react-reconciler` 单独打包（425kb，仅 reconciler 需要它）

---

### 步骤 3 — JSX 类型声明

创建：
- `lib/react-qw/react.d.ts` — vendor bundle → `@types/react` 桥接
- `lib/react-qw/jsx.d.ts` — `<w>` 标签声明 + React.JSX 扩增

详见下方「类型方案」章节。这样 React 的 TSX 文件就能用 `<w type="BUTTON" ...>`，`useState` 等 hooks 也有完整类型。

---

### 步骤 4 — Reconciler Host Config

核心工作。实现 `react-reconciler` 所需的约 40+ 个 host config 方法。

**核心映射表：**

| 方法 | 操作 |
|------|------|
| `createInstance(type, props, rootContainer)` | `gui.CreateWindow(typeToClass(type), ...)` |
| `createTextInstance(text, rootContainer)` | `gui.CreateWindow('STATIC', text, ...)` |
| `appendInitialChild(parent, child)` | Win32 子控件在创建时就指定了 parent，通常无需额外操作 |
| `appendChild(parent, child)` | `gui.SetParent(child.hwnd, parent.hwnd)` |
| `removeChild(parent, child)` | `gui.DestroyWindow(child.hwnd)` |
| `commitUpdate(instance, payload, type, oldProps, newProps)` | 调用 `applyProps(instance.hwnd, newProps, instance)` |
| `prepareUpdate(instance, type, oldProps, newProps)` | 计算需要更新的属性集（按需优化） |
| `finalizeInitialChildren(instance, type, props)` | 调用 `applyProps`，返回 `false`（不需立即 commit） |
| `resetAfterCommit(containerInfo)` | NOP（暂时不触发布局） |
| `shouldSetTextContent(type, props)` | 返回 `false` |
| `getPublicInstance(instance)` | 返回 `instance.hwnd` |
| `scheduleTimeout(fn, delay)` | `os.setTimeout(fn, delay)` |
| `cancelTimeout(id)` | `os.clearTimeout?.(id)` 或 NOP |
| `getRootHostContext(rootContainer)` | 返回 `{}` |
| `getChildHostContext(parentContext, type)` | 返回 `{}` |
| `prepareForCommit(containerInfo)` | NOP |
| `supportsMutation` | `true` |
| `supportsPersistence` | `false` |
| `supportsHydration` | `false` |
| `isPrimaryRenderer` | `true` |
| `clearContainer(container)` | 递归销毁所有子 HWND |

**数据结构：**
```ts
type Container = gui.HWND

interface Instance {
  hwnd: gui.HWND
  type: string           // 'BUTTON' | 'EDIT' | 'STATIC' | ...
  props: Record<string, any>
  children: Instance[]
  _oldProc?: any         // 保存旧的 WNDPROC
}

type TextInstance = gui.HWND  // 文本节点用 STATIC 控件表示
```

---

### 步骤 5 — 公开 API

```ts
// lib/react-qw/index.ts
import ReactReconciler from '../../vendor/react/react-reconciler.js'

export function render(
  element: React.ReactElement,
  containerHwnd: gui.HWND,
  callback?: () => void
): void

// 可选 React 19 createRoot API
export function createRoot(containerHwnd: gui.HWND): {
  render(element: React.ReactElement): void
  unmount(): void
}
```

**内部流程：**
1. `import ReactReconciler from '../../vendor/react/react-reconciler.js'` → 创建 host config
2. `createContainer(containerHwnd, ...)` → 创建 fiber 树
3. `updateContainer(element, container, ...)` → 触发首屏渲染

---

### 步骤 6 — 组件移植

将现有 preact 组件改写为 React 组件。使用 react 自身的 hooks。

```tsx
import { useRef, useEffect } from '../../vendor/react/react.js'

export function Button(props: ButtonProps) {
  return (
    <w type="BUTTON"
      text={props.text || ''}
      ws={/* ... */}
      onEvent={(e: any) => {
        if (e.msg === gui.WmMsg.LBUTTONDOWN) props.onClick?.()
      }} />
  )
}
```
---

## 用户代码示例
```tsx
import { useState } from '../vendor/react/react.js'
import { render } from '../lib/react-qw/index.js'
import { Button } from '../lib/react-qw/components/Button.js'

function App() {
  const [count, setCount] = useState(0)
  return <Button text={`Count: ${count}`} onClick={() => setCount(c+1)} />
}

render(<App />, mainHwnd)
```

---

## 依赖清单

| 依赖 | 来源 | 用途 |
|------|------|------|
| `react@19` | npm install | React API (useState, useEffect,等) + jsx-runtime |
| `react-reconciler@0.33.0` | npm install | Custom renderer host config |
| `@types/react` (dev) | npm `--save-dev` | React 类型定义（JSX, hooks） |
| `esbuild` (dev) | npm `--save-dev` | 将 react 打包为 ESM 单文件 |

---

## 类型方案（方案 B — `@types/react`）

### 基本思路

1. `npm install --save-dev @types/react`
2. 创建 `.d.ts` 声明 vendor bundle 路径模块，委托给 `@types/react`
3. TypeScript 的 `node_modules/@types` 自动参与模块解析（不受 `types` 字段影响），`import` 语句能正确匹配

### 关键文件

```
lib/react-qw/
├── react.d.ts        # 桥接：vendor/react.js → @types/react
├── jsx.d.ts          # JSX 类型 + 扩增 React.JSX.IntrinsicElements
└── reconciler.d.ts   # 桥接：vendor/react-reconciler.js → 类型（手写最小桩）
```

### react.d.ts — vendor bundle 类型桥接

```typescript
// lib/react-qw/react.d.ts
// 将 vendor/react/react.js 的类型指向 @types/react
declare module '../../vendor/react/react.js' {
  export * from 'react'
}
```

`node_modules/@types/react/index.d.ts` 中已有 `declare module 'react' { ... }`。TypeScript 的模块解析器会找到它，`export * from 'react'` 将全部类型转发给 vendor bundle。

对应的 `jsx-runtime.ts` 重导出路径相同，因此 JSX 编译产生的 `import { jsx, jsxs } from '../lib/react-qw/jsx-runtime'` 也能获得正确的类型。

### jsx.d.ts — JSX 类型扩增

React 19 的 JSX 命名空间在 `React.JSX` 中，不在全局 `JSX`。需要用模块扩增来添加 `<w>` 标签：

```typescript
// lib/react-qw/jsx.d.ts
interface WEvent {
  hwnd: number
  msg: number
  wParam: number
  lParam: number
}

interface WIntrinsicProps {
  type?: string
  text?: string
  ws?: number
  disabled?: boolean
  visible?: boolean
  x?: number
  y?: number
  width?: number
  height?: number
  onEvent?: (e: WEvent) => void
  children?: any
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      w: WIntrinsicProps
    }
  }
}

export type { WEvent, WIntrinsicProps }
```

### reconciler.d.ts — react-reconciler 类型

`@types/react-reconciler` 已安装。桥接 vendor 路径：

```typescript
// lib/react-qw/reconciler.d.ts
declare module '../../vendor/react/react-reconciler.js' {
  import ReactReconciler from 'react-reconciler'
  export = ReactReconciler
}
```

或者直接暴露 `@types/react-reconciler` 的声明：

### tsconfig.json 调整

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "../lib/react-qw",
    "types": ["./quickwin.d.ts"]
  }
}
```

> **注意：** `types` 字段限制的是**全局自动包含**的包。`@types/react` 不需要全局自动包含，它只为 `import` 语句提供模块类型。所以 `types` 字段无需改，只要它在 `node_modules/@types/` 中即可。

### 类型覆盖度

| 场景 | 覆盖方式 | 效果 |
|------|---------|------|
| `<w type="BUTTON" text="Hi" />` | `jsx.d.ts` 扩增 `React.JSX.IntrinsicElements` | ✅ JSX 编译检查 |
| `useState(0)` | `@types/react` | ✅ 完整 hooks 类型 |
| `useEffect(() => {}, [])` | `@types/react` | ✅ 完整 hooks 类型 |
| `<Button onClick={fn} />` | 组件自身 props 类型 | ✅ 组件级别 |
| react-reconciler host config | 手写最小桩 | ⚠️ 部分类型安全 |

---

| 步骤 | 预估 |
|------|------|
| 1. 清理 preact | ~15 min |
| 2. 安装依赖 + esbuild bundle | ~15 min |
| 3. JSX 类型声明 | ~10 min |
| 4. Reconciler host config | ~1-2 h |
| 5. 公开 API + 首屏渲染 | ~30 min |
| 6. 组件移植 (5 个) | ~30 min |
| 7. 测试 + 调试 | ~1 h |
| **总计** | **~4 h** |

---

## 主要风险

1. **react-reconciler 在 QuickJS 兼容性** — scheduler 使用 `setTimeout`（QuickJS 支持）、`postMessage`（需 esbuild `--define` 或 polyfill）
2. **esbuild 产物兼容性** — 确保产出的 ESM 格式能被 QuickJS 模块加载器正确解析
3. **HWND 生命周期** — React 的 fiber 树卸载时需要正确释放所有 Win32 资源（HWND、WNDPROC）

---

# Flex Layout 实现计划

## 目标

在 `<w>` 元素上通过 `style` prop 支持简单的 flex 布局，覆盖 ~80% 的 UI 布局场景，消除手动绝对坐标计算。

## 类型设计

```typescript
interface WStyle {
  x?: number; y?: number
  width?: number; height?: number
  flexDirection?: 'row' | 'column'
  justifyContent?: 'flex-start' | 'flex-end' | 'center'
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap?: number
}

interface WIntrinsicProps {
  type?: string; text?: string; ws?: number
  disabled?: boolean; visible?: boolean
  style?: WStyle
  onEvent?: (e: WEvent) => void
  children?: React.ReactNode
  ref?: React.Ref<gui.HWND>
}
```

所有布局属性（`x`, `y`, `width`, `height` 及 flex 属性）都在 `style` 中。Flat props 只保留非视觉属性（`type`, `text`, `ws`, `disabled`, `visible`, `onEvent`, `children`, `ref`）。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `lib/react-qw/jsx.d.ts` | 加 `WStyle` 类型，更新 `WIntrinsicProps`，children/ref 不再用 any |
| `lib/react-qw/layout.ts` | **新建** — `calculateFlexLayout()` |
| `lib/react-qw/reconciler.ts` | `appendChild`/`insertBefore`/`removeChild` 维护 `children` 数组；`resetAfterCommit` 触发布局；`createInstance`/`applyProps` 读 `style.width/height` 替代 `props.width/height` |
| `lib/react-qw/props.ts` | 从 `style` 中提取 `width/height/x/y` 应用到 `SetWindowPos` |

## 实现步骤

### 步骤 1 — 更新类型定义 (`jsx.d.ts`)

- 新增 `WStyle` 接口
- `WIntrinsicProps` 中替换 `children?: any` → `children?: React.ReactNode`，`ref?: any` → `ref?: React.Ref<gui.HWND>`
- 移除 flat 的 `width`, `height` 属性
- 引入 `React` 类型（通过 `react.d.ts` 桥接）

### 步骤 2 — 创建 layout.ts

纯函数布局引擎：

```typescript
export interface FlexProps {
  flexDirection: 'row' | 'column'
  justifyContent: 'flex-start' | 'flex-end' | 'center'
  alignItems: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap: number
}

export function calculateFlexLayout(
  style: FlexProps,
  parentWidth: number,
  parentHeight: number,
  children: Array<{ style: Record<string, any> }>
): Array<{ x: number, y: number, width: number, height: number }>
```

算法：
1. 收集子元素尺寸（`style.width` / `style.height`，无则默认 `100x30`）
2. 主轴方向：`column` 垂直排列（默认），`row` 水平排列
3. 子元素间距 `gap`
4. `justifyContent`: `flex-start` 从头排，`flex-end` 从尾排，`center` 居中
5. `alignItems`: `flex-start`/`flex-end`/`center` 交叉轴对齐，`stretch` 拉伸到容器尺寸

### 步骤 3 — reconciler.ts 修改

- `appendChild` / `appendInitialChild` / `insertBefore` / `removeChild` 中正确维护 `parent.children` 数组
- `resetAfterCommit` 中遍历 Instance 树，对有 `style.flexDirection` 的容器运行布局 + 调用 `gui.SetWindowPos`
- `createInstance` 中 `props.width` → `props.style?.width`（fallback 处理）

### 步骤 4 — props.ts 修改

- `applyProps` 中从 `newProps.style` 读取 `x`, `y`, `width`, `height` 传递给 `SetWindowPos`
- 需要处理 `style` 对象引用变化触发重新布局

### 步骤 5 — 验证

编写测试代码验证基本场景：

- `flexDirection: 'column'`（默认）垂直堆叠 + gap
- `flexDirection: 'row'` 水平排列 + gap
- `justifyContent: 'center'` 居中
- `alignItems: 'stretch'` 拉伸填充

## 不做（后续可扩展）

- `flexWrap` — 多行布局，复杂
- `flexGrow` / `flexShrink` — 弹性比例，需要更复杂的测量通道
- `alignSelf` — 单子元素覆盖
- `order` — 重排序

## 实现顺序

1. `jsx.d.ts` 类型
2. `layout.ts` 布局引擎
3. `reconciler.ts` children 追踪 + layout trigger
4. `props.ts` style 读取
5. 测试验证

