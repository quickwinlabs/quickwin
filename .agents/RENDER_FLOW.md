# QuickWin Preact 渲染流程

基于 `lib/preact/` 模块：`preact.ts`（VNode/options）、`hooks.ts`（hooks 引擎）、`render.ts`（Win32 渲染器）。

---

## 一、架构总览

```
┌─ 用户代码（如 preact_demo.tsx）─┐
│  gui.RegisterClass('DemoApp',   │
│    wndProc: handles COMMAND/    │
│    DESTROY/SIZE)                │
│  gui.CreateWindow('DemoApp',..) │
│  gui.ShowWindow(hwnd)          │
│  render(<App />, hwnd)          │
└──────────┬──────────────────────┘
           │
           ▼
┌─ preact.ts ──────────────────────┐
│  createElement → createVNode     │
│  options: 全局单例（桥梁对象）     │
└──────────┬──────────────────────┘
           │ hooks.ts 注册回调到 options
           ▼
┌─ hooks.ts ──────────────────────┐
│  options._diff                  │
│  options._render                │
│  options.diffed                 │
│  options._commit                │
│  options.unmount                │
└──────────┬──────────────────────┘
           │ render.ts 调用 options.*
           ▼
┌─ render.ts ───────────────────────┐
│  render(vnode, containerHwnd)     │
│  invokeComponent → options.*      │
│  renderToWin32 → Win32 控件创建     │
│  reconcile(old, new) → 增量 diff   │
│    ├ 同 ctrlType → 复用 HWND      │
│    ├ 同组件 → 复用 instance       │
│    └ type不匹配 → destroy+create  │
│  scheduleUpdate → setTimeout      │
│  doLayout → Flexbox 布局          │
└───────────────────────────────────┘
```

**核心原则：** 三个文件共享同一个 `options` 单例（`preact.ts` 导出）。hooks.ts 启动时把回调注册到 `options` 上，render.ts 在对应时机调用 `options.*`。不需要用户手动 `setPreactOptions`。

---

## 二、Options 钩子总表

| 钩子 | 注册者 | 调用者 | 时机 |
|---|---|---|---|
| `options._diff(vnode)` | hooks.ts: 清 `currentComponent` | render.ts: `invokeComponent` 开头 | render 前 |
| `options._render(vnode)` | hooks.ts: 提升值、重置索引、处理旧 effects | render.ts: `invokeComponent` | 组件 render 前 |
| `options.diffed(vnode)` | hooks.ts: 转移 `_pendingArgs→_args`、调度 afterPaint | render.ts: `invokeComponent` 末尾(在 finally 中) | 组件 render 后 |
| `options._commit(vnode, queue)` | hooks.ts: 执行 `_renderCallbacks`（useLayoutEffect） | render.ts: `render()` 和 `scheduleUpdate` 末尾 | 控件树创建/更新后 |
| `options.unmount(vnode)` | hooks.ts: 执行 hook cleanup | render.ts: `destroyVNode` | 卸载前 |

---

## 三、首次渲染完整流程

```
用户程序入口：
  hwnd = gui.CreateWindow("DemoApp", ...)
  gui.ShowWindow(hwnd)
  render(<App />, hwnd)
        │
        ▼
┌─ render.ts: render(vnode=<App/>, containerHwnd=hwnd)
│
│  1. rootHwnd = containerHwnd
│     rootVNode = vnode
│
│  2. renderToWin32(vnode, hwnd, {})
│     │
│     │  vnode.type === 'function' → 函数组件
│     │  (App 是用 function 定义的组件)
│     │
│     └─ renderComponent(vnode, hwnd, {})
│          │
│          │  a) newComponent(vnode, hwnd, context)
│          │     创建 QWComponent 对象:
│          │       __hooks: { _list:[], _pendingEffects:[] }
│          │       _renderCallbacks: []
│          │       _dirty: false
│          │       _forceUpdate() → scheduleUpdate(this)
│          │     vnode._component = component
│          │
│          └─ b) invokeComponent(component, vnode)
│                │
│     ┌──────────┼──────────────────────────────┐
│     │ STEP 1   │  options._diff?.(vnode)       │
│     │          │    → hooks.ts:               │
│     │          │      currentComponent = null   │
│     │          └──────────────────────────────┤
│     │                                          │
│     │ STEP 2   │  options._render?.(vnode)     │
│     │          │    → hooks.ts:               │
│     │          │  a) currentComponent = component│
│     │          │  b) currentIndex = 0           │
│     │          │  c) hooks._list.some():        │
│     │          │      首次: _list 为空 → 跳过    │
│     │          │  d) _pendingEffects 为空 → 跳过  │
│     │          │  e) previousComponent = component│
│     │          └──────────────────────────────┤
│     │                                          │
│     │ STEP 3   │  fn.call(component, props, ctx)│
│     │          │    ← 组件 render 函数执行      │
│     │          │                               │
│     │          │  ├─ useState(0)               │
│     │          │  │   getHookState(0,1):       │
│     │          │  │     _list[0] 不存在 → push  │
│     │          │  │     !_component → 首次:     │
│     │          │  │       _value=[0, dispatch]  │
│     │          │  │       _component=component  │
│     │          │  │     currentIndex→1          │
│     │          │  │     return [0, dispatchFn]  │
│     │          │  │                             │
│     │          │  ├─ useEffect(fn, [])          │
│     │          │  │   getHookState(1,3):        │
│     │          │  │     _list[1] 不存在 → push  │
│     │          │  │     argsChanged(undefined,[])│
│     │          │  │       → true:               │
│     │          │  │         _value = fn          │
│     │          │  │         _pendingArgs = []   │
│     │          │  │         _pendingEffects.push │
│     │          │  │     currentIndex→2          │
│     │          │  │                             │
│     │          │  └─ return JSX(<w type="div">  │
│     │          │        <w type="button".../>   │
│     │          │      </w>)                     │
│     │          └──────────────────────────────┤
│     │                                          │
│     │ STEP 4   │  options.diffed?.(vnode)       │
│     │          │    → hooks.ts:               │
│     │          │  a) c.__hooks._pendingEffects  │
│     │          │      长度>0 → afterPaint(...)  │
│     │          │      → setTimeout(35ms) 调度  │
│     │          │  b) _pendingArgs→_args 复制    │
│     │          │  c) previousComponent=null     │
│     │          │     currentComponent=null      │
│     │          └──────────────────────────────┤
│     │                                          │
│     └──────────┼──────────────────────────────┘
│                │  返回 rendered = JSX 树
│                ▼
│          c) renderToWin32(rendered, hwnd, {})
│             递归将 JSX 转为 Win32 控件:
│             │
│             ├─ type='w', ctrlType='div'
│             │  → gui.CreateWindow('STATIC',...,hwnd,...)
│             │  → gui.SetWindowProc(divHwnd, forwardCOMMND)
│             │    转发 WM_COMMAND → rootHwnd
│             │  → 递归处理子节点:
│             │    ├─ ctrlType='button'
│             │    │  → gui.CreateWindow('BUTTON',...,divHwnd,...)
│             │    │  → applyProps: onEvent→registerEventHandler
│             │    └─ ...
│
│  3. options._commit?.(vnode, [component])
│     → hooks.ts:
│        component._renderCallbacks.some(invokeCleanup)
│        component._renderCallbacks.filter(cb => cb._value ? invokeEffect(cb) : true)
│        → useLayoutEffect 在这里同步执行
│
│  4. doLayout(containerHwnd, vnode)
│     → Flexbox 布局计算，设置每个控件的位置和大小
│
│  返回 containerHwnd
│
└─ 渲染完成，窗口已显示（由用户在 render 前 ShowWindow）
   └─ [异步] ~35ms 后 flushAfterPaintEffects
        → 执行 useEffect 回调
```

---

## 四、Re-render 完整流程（增量 reconcile）

```
用户点击按钮 → onEvent → setCount(count + 1)
    │
    └─ useReducer dispatch(action):
         1. reducer(currentValue, action) → nextValue
         2. Object.is 比较，如果不同:
             hookState._nextValue = [nextValue, dispatch]
             hookState._component._forceUpdate()
    │
    └─ render.ts: component._forceUpdate()
         component._dirty = true
         scheduleUpdate(component)
    │
    └─ scheduleUpdate(component)
         │
         ├─ if (!component._dirty) return   ← 防重入
         │
         └─ os.setTimeout(() => {
              │
              ├─ if (!component._dirty) return ← 二次检测
              ├─ component._dirty = false
              │
              ├─ oldRendered = vnode[RENDERED_VNODE_PROP]
              │
              └─ invokeComponent(component, vnode)  ← 重跑组件
                   │
      ┌──────────────┼─────────────────────────────────┐
      │ STEP 1       │  options._diff?.(vnode)          │
      │              │    → hooks.ts:                  │
      │              │      currentComponent = null      │
      │              └─────────────────────────────────┤
      │                                                 │
      │ STEP 2       │  options._render?.(vnode)        │
      │              │    → hooks.ts:                  │
      │              │  a) currentComponent = component  │
      │              │  b) currentIndex = 0              │
      │              │  c) hooks._list.some():           │
      │              │      检查 _nextValue:             │
      │              │        useState: _nextValue=[42,d]│
      │              │          → _value=[42,d] 🎯 值提升│
      │              │        _pendingArgs = undefined   │
      │              │  d) _pendingEffects 处理:          │
      │              │       invokeCleanup → 旧 cleanup  │
      │              │       invokeEffect  → 执行 effect │
      │              │       _pendingEffects = []        │
      │              │  e) currentIndex = 0              │
      │              │  f) previousComponent = component │
      │              └─────────────────────────────────┤
      │                                                 │
      │ STEP 3       │  fn.call(component, props, ctx)   │
      │              │  ├─ useState() → getHookState(0,1)│
      │              │  │    _list[0] 已存在 → 直接返回   │
      │              │  │    return [42, dispatchFn] ← 新值│
      │              │  │                                │
      │              │  ├─ useEffect(fn, [])             │
      │              │  │    argsChanged(_, []) → false  │
      │              │  │    (依赖未变，不注册 effect)    │
      │              │  │                                │
      │              │  └─ return 新 JSX 树              │
      │              └─────────────────────────────────┤
      │                                                 │
      │ STEP 4       │  options.diffed?.(vnode)          │
      │              │    → _pendingEffects 为空，不调度 │
      │              │    → previousComponent = null     │
      │              │       currentComponent = null     │
      │              └─────────────────────────────────┤
      │                                                 │
      └──────────────┼─────────────────────────────────┘
                     │  返回新树 rendered
                     │
               ┌─ reconcile(oldRendered, rendered, parentHwnd, ctx)
               │  逐层比较，按策略处理:
               │
               │  ├─ 同 ctrlType 的元素 VNode → 复用 HWND, applyProps, 递归 children
               │  ├─ 同函数组件 → 复用 component 实例, 递归 reconcile 结果
               │  ├─ 文本相同 → 复用 STATIC HWND（仅更新文本）
               │  ├─ 旧有 + 新增 → renderToWin32 创建
               │  ├─ 旧有 + 新 null → destroyVNode / destroyHwnd
               │  └─ type 不匹配 → destroyVNode + renderToWin32 重建
               │
               ├─ commitQueue = [component]
               ├─ options._commit?.(vnode, commitQueue)
               │     → 执行新注册的 useLayoutEffect
               │
               └─ doLayout(rootHwnd, rootVNode)
                     → Flexbox 重新布局
          }, 0)
```

---

## 五、关键数据流

### 5.1 useState 值传递链（dispatch → re-render）

```
dispatch(42)
    │
    ├─ reducer(prev, 42) → 42
    ├─ Object.is(prev, 42) → false
    ├─ _nextValue = [42, dispatchFn]       ← dispatch 写入
    └─ component._forceUpdate()
         component._dirty = true
         └─ scheduleUpdate → setTimeout
              │
              ├─ options._render:            ← render.ts 调用
              │    _list.some:               ← hooks.ts 处理
              │      _nextValue=[42,d] 存在
              │      → _value = _nextValue  🎯 值提升
              │      → _nextValue = undefined
              │
              └─ fn.call() → useState:
                     return _value           ← render 函数读到 42
```

### 5.2 Effect 生命周期

```
┌──────────────────────────────────────────────────────────┐
│                     useEffect(fn, [x])                   │
│                             │                            │
│            argsChanged(_args, [x])?                      │
│                   /          \                           │
│                是            否                           │
│                │             │                           │
│          _pendingEffects    跳过                          │
│          .push(state)                                    │
│                │                                          │
│          options.diffed:                                  │
│          afterPaintEffects.push(component)                │
│          setTimeout(flushAfterPaintEffects, 35)           │
│                │                                          │
│  ┌─ flushAfterPaintEffects ──────────────────────────┐   │
│  │  invokeCleanup(state)   ← 执行上一次 cleanup      │   │
│  │  invokeEffect(state)    ← state._cleanup = fn()   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│                     useLayoutEffect(fn, [x])             │
│                             │                            │
│               _renderCallbacks.push(state)               │
│                             │                            │
│          options._commit:                                │
│          invokeCleanup → invokeEffect                    │
└──────────────────────────────────────────────────────────┘
```

### 5.3 options 单例共享

```
preact.ts → export const options: Options = {}
                │
                ├─ hooks.ts 启动时：                    (模块加载时)
                │     options._diff = (vnode) => { ... }
                │     options._render = (vnode) => { ... }
                │     options.diffed = (vnode) => { ... }
                │     options._commit = (vnode, q) => { ... }
                │     options.unmount = (vnode) => { ... }
                │
                └─ render.ts 中使用：                   (运行时)
                      import { options } from './preact.js'
                      options._diff?.(vnode)
                      options._render?.(vnode)
                      options.diffed?.(vnode)
                      options._commit?.(vnode, queue)
                      options.unmount?.(vnode)

  无需用户手动 setPreactOptions，hooks.ts 和 render.ts
  通过同一个 options 对象自动连接。
```

---

## 六、Win32 控件树 vs VNode 树

### VNode 树（首次 render）

```
<App />                     ← 函数组件 vnode
  └─ <w type="div">         ← 容器 vnode (props.style.flexDirection='column')
       ├─ <w type="static"> ← 文本 vnode (Counter: 0)
       ├─ <w type="div">    ← 容器 vnode (flexDirection='row')
       │   ├─ <w type="button" text="+1">
       │   └─ <w type="button" text="-1">
       └─ <w type="edit">   ← 输入框 vnode
```

### 对应的 Win32 控件树

```
mainWnd ('DemoApp' 类)
  └─ hwnd_div (STATIC 类, SetWindowProc 转发 COMMAND)
       ├─ hwnd_static ('Counter: 0')
       ├─ hwnd_div_row (STATIC 类, SetWindowProc 转发 COMMAND)
       │   ├─ hwnd_btn_1 (BUTTON 类, 'btn_1', onEvent→eventMap)
       │   └─ hwnd_btn_2 (BUTTON 类, 'btn_2', onEvent→eventMap)
       └─ hwnd_edit (EDIT 类, 'test input')
```

### 事件传递路径

```
用户点击按钮 "+1"
    ↓
Win32: 按钮（child） → WM_COMMAND → parent（div_row）
    ↓
div_row 的 SetWindowProc:
    if msg == COMMAND → SendMessage(rootHwnd, ...)
    ↓
rootHwnd（DemoApp）的 wndProc:
    dispatchEvent(ctrlHwnd, commandCodeToEventType(code))
    → eventMap 中查找 handler → onEvent 回调
    → setCount(count + 1) → useState dispatch → _forceUpdate → scheduleUpdate
```

---

## 七、首次渲染 vs Re-render 对比

| 步骤 | 首次渲染 | re-render |
|---|---|---|
| 入口 | `render(vnode, hwnd)` 同步调用 | `scheduleUpdate` → `setTimeout(0)` 异步 |
| `newComponent` | 创建全新 QWComponent | 不复用（已在 `vnode._component` 上） |
| 旧树处理 | 无 | `reconcile(old, new)` 逐层比较 |
| `options._render` 中 `_list.some` | 无 `_nextValue`，无 `_pendingEffects` | 有 `_nextValue` → 值提升；有旧 effects → cleanup + 重执行 |
| `useState()` 返回 | `init` 计算的初始值 | 提升后的 `_value` |
| `useEffect` 注册 | 首次总是注册 | 仅 `argsChanged` 时注册 |
| `options.diffed` | `_pendingEffects` 非空 → 调度 afterPaint | `_pendingEffects` 已被消费 → 空 → 不调度 |
| 控件创建 | 全部 `gui.CreateWindow` | 匹配 ctrlType → 复用 HWND + `applyProps`；不匹配 → 重建 |
| `doLayout` | 全新布局计算 | 重新布局 |

---

## 八、关键文件职责

| 文件 | 职责 |
|---|---|
| `preact.ts` | VNode 创建（`createElement`），`options` 单例，类型定义 |
| `hooks.ts` | 注册 options 回调（`_diff`/`_render`/`diffed`/`_commit`/`unmount`），管理 hooks 状态，调度 effects |
| `render.ts` | Win32 渲染树创建/销毁/增量更新，`reconcile` diff 驱动 updater，`scheduleUpdate` 调度  |
| `props.ts` | 属性应用到 Win32 控件，事件注册/派发（`eventMap`） |
| `layout.ts` | Flexbox 布局递归计算，`doLayout` |
