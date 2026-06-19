# SetParent 缓存问题解决方案分析

## 问题根源

`reconciler.createInstance` 以 `rootContainer` 为父创建子控件窗口，然后 `appendInitialChild` / `appendChild` 调用 `SetParent` 把控件迁移到真正的父窗口。许多 Windows 控件（SysListView32、LISTBOX、EDIT、COMBOBOX）在 `WM_CREATE` 时缓存了父窗口 HWND，`SetParent` 后通知消息（`WM_NOTIFY`、`WM_COMMAND`）仍发给原父窗口。

---

## React Reconciler HostConfig 调用流程

以如下 JSX 为例：

```tsx
<w type="STATIC" ws={VISIBLE} style={{flexDirection:'column'}}>
  <w type="BUTTON">Click</w>
  <w type="EDIT" />
</w>
```

### completeWork 阶段（Render Phase，bottom-up）

```
① BUTTON:  createInstance('BUTTON', props, rootContainer)       → Instance { hwnd }
           finalizeInitialChildren(instance, ...)                 → applyProps

② EDIT:    createInstance('EDIT', props, rootContainer)          → Instance { hwnd }
           finalizeInitialChildren(instance, ...)                 → applyProps

③ STATIC:  createInstance('STATIC', props, rootContainer)        → Instance { hwnd }
           appendAllChildren(STATIC_instance, fiber)              → appendInitialChild(STATIC, BUTTON)
                                                                  → appendInitialChild(STATIC, EDIT)
           finalizeInitialChildren(instance, ...)                 → applyProps
```

每个节点的 `completeWork` 内部顺序：
```
createInstance → appendAllChildren(调用 appendInitialChild 处理子节点) → finalizeInitialChildren
```

**关键**：`appendInitialChild(P, C)` 在 P 自己的 `createInstance` 之后立即被调用（在 P 的 `appendAllChildren` 中）。而此时 P 上层的父节点尚未完成 `completeWork`。

---

## 延迟 CreateWindow 方案（最终实现，2026-06-13）

### 核心思路

`createInstance` 时不创建窗口（`hwnd: null`），在 `appendInitialChild` 知道真实父窗口后才创建，避免 `SetParent`。

### 实现的关键洞察

延迟 CreateWindow **只对叶子节点控件有效**——控件本身不包含 React 子节点，never called as `parent` in `appendInitialChild(parent, child)`.

SysListView32 和 SysTreeView32 的父节点总是 STATIC（container），STATIC 的 `createInstance` 正常创建窗口（非延迟）。所以：

```
createInstance(STATIC)           → hwnd 有效
appendAllChildren(STATIC)        → appendInitialChild(STATIC, SysListView32)
                                   ensureChildWindow(SysListView32, STATIC.hwnd) ✅
```

- `parent.hwnd`（STATIC）在 `appendInitialChild` 时已有有效 HWND
- SysListView32 创建时的父窗口就是 STATIC wrapper，**零次 SetParent**
- ListView 组件在 JSX 中是 `<w type="SysListView32">` 的宿主组件，没有 React children，所以不会成为 `parent`

### 安全性保证

| 条件 | 保证 |
|------|------|
| 延迟控件在 JSX 中作为父级 | 不为空——延迟控件不暴露 `children` prop |
| 延迟控件的父也是延迟控件 | 不可能——STATIC/BUTTON/TAB 等容器正常创建；只有 leaf node 延迟 |
| `hwnd!` 非空断言 | 仅在 `applyProps` / 子节点 `appendInitialChild` 中调用，此时必不为 null |

### 实现

**文件：** `lib/react-qw/reconciler.ts`

1. `Instance.hwnd` 类型改为 `gui.HWND | null`
2. `DELAYED_CONTROLS` 集合：`['SysListView32', 'SysTreeView32']`
3. `isDelayedControl(type)`：检查类型是否在 DELAYED_CONTROLS 中
4. `setupWindowProc(instance, hwnd, winClass)`：统一设置 `instance.hwnd` + 注册 `instancesByHwnd` + 安装子类窗口过程
5. `ensureChildWindow(child, parentHwnd)`：延迟控件首次创建窗口，调用 `setupWindowProc`
6. `createInstance`：对延迟控件返回 `{...hwnd: null}`；其他控件正常创建
7. `appendInitialChild(parent, child)` / `appendChild` / `insertBefore`：若 `child.hwnd === null` 则调用 `ensureChildWindow(child, parent.hwnd!)`，否则 `SetParent(child.hwnd, parent.hwnd)`
8. `removeChild` / `removeChildFromContainer` / `detachDeletedInstance`：null-check `instance.hwnd`
9. `createWidget`（`runFlexLayout` 回调）：null-check `inst.hwnd`

**文件：** `lib/react-qw/props.ts`
10. `applyProps`：`const hwnd = instance.hwnd!` — 调用时窗口必已创建

**文件：** `lib/react-qw/components/ListView.tsx`
11. 从 manual `CreateWindow('SysListView32', ...)` + `DestroyWindow` in `useEffect` 改为 `<w type="SysListView32">` JSX，由 reconciler 创建和管理窗口生命周期

**文件：** `lib/dumpRects.ts`
12. 独立出调试工具函数 `startDumpRects(hwnd, intervalMs?)`，定时打印窗口树

### 非延迟控件

BUTTON、EDIT、STATIC、SysTabControl32 等不缓存父窗口，仍然使用 `SetParent` 方案。仅 SysListView32、SysTreeView32 需要延迟创建。

---

## 所有可行方案对比

### A：root container 子类拦截转发 WM_NOTIFY ✅ 推荐

在 `prepareForCommit` 中对 `containerInfo`（root HWND）设 `SetWindowProc`，拦截 `WM_NOTIFY`，读 `NMHDR.hwndFrom`，通过 `GetParent` 查到当前实际父窗口，若不是 rootContainer 则转发。

```typescript
prepareForCommit(containerInfo: Container) {
  if (!subclassed.has(containerInfo)) {
    subclassed.add(containerInfo)
    const oldProc = gui.GetWindowLongPtr(containerInfo, gui.Gwlp.WNDPROC) as number
    procs.set(containerInfo, oldProc)
    gui.SetWindowProc(containerInfo, (hwnd, msg, wParam, lParam) => {
      if (msg === gui.WmMsg.NOTIFY) {
        const srcHwnd = readHwndFromPtr(lParam, 0)
        if (srcHwnd) {
          const realParent = gui.GetParent(srcHwnd)
          if (realParent && realParent !== hwnd)
            return gui.SendMessage(realParent, msg, wParam, lParam)
        }
      }
      const old = procs.get(hwnd)
      return old ? gui.CallWindowProc(old, hwnd, msg, wParam, lParam) : 0
    })
  }
  return null
}
```

| 维度 | 评价 |
|------|------|
| 复杂度 | 低（~20 行） |
| 影响范围 | 仅 WM_NOTIFY |
| 是否需要改 ListView/ListBox | 是—manual CreateWindow 可改回标准 `<w>` |
| 风险 | 低—子类只读 lParam 转发，不修改消息 |
| 是否经过验证 | Raymond Chen 文章 + StackOverflow 社区公认方案 |

### A2：WM_NOTIFY + WM_COMMAND 同时转发

Edit/ListBox/ComboBox 的 `WM_COMMAND`（`EN_CHANGE`、`LBN_SELCHANGE`、`CBN_SELCHANGE`）同样有缓存问题。

在 root container 子类中也拦截 `WM_COMMAND`，通过 `lParam` 中的控件 HWND 查 `GetParent` 转发。

| 维度 | 评价 |
|------|------|
| 复杂度 | 低（~30 行） |
| 影响范围 | WM_NOTIFY + WM_COMMAND |
| 是否需要改 ListView/ListBox | 是 |

### B：用 `SetWindowPos` 强制控件刷新父窗口

`SetParent` 后，发 `WM_WINDOWPOSCHANGED` 或 `WM_STYLECHANGED` 尝试让控件重新调用 `GetParent` 更新缓存。

```typescript
gui.SetParent(childHwnd, parent.hwnd)
// 尝试强制刷新
gui.SetWindowPos(childHwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)
```

| 维度 | 评价 |
|------|------|
| 效果 | **未经证实**—依赖控件内部实现，可能无效 |
| 风险 | 低，但不可靠 |
| 验证结果 | 已有实验未解决 SysListView32 问题 |

### C：创建为 POPUP + 后加 WS_CHILD

`createInstance` 时不加 `WS_CHILD`，以 `null` 为父创建（overlapped/popup 窗口不需要父窗口）：

```typescript
const ws = props.ws ?? 0  // 不加 WS_CHILD
const hwnd = gui.CreateWindow(winClass, text, ws, x, y, w, h, null, null)
```

`appendInitialChild` 时加 `WS_CHILD` + `SetParent`：

```typescript
const style = gui.GetWindowLongPtr(hwnd, Gwl.STYLE) | WS_CHILD
gui.SetWindowLongPtr(hwnd, Gwl.STYLE, style)
gui.SetParent(hwnd, parent.hwnd)
```

如果控件在 `WM_CREATE` 时没有父窗口，可能不会缓存——但这是推测，因控件而异。

| 维度 | 评价 |
|------|------|
| 复杂度 | 低 |
| 效果 | **推测性**—取决于控件是否在无父时也缓存 null |
| 风险 | 窗口创建瞬间可能闪现为 popup；某些控件（如 SysListView32）可能要求 WS_CHILD |

### D：窗口包装器（wrapper container）

每个控件用一个包装器 STATIC 包裹，包装器才是 reconciler 管理的子节点。真正的控件作为包装器的子节点。`SetParent` 只发生在包装器上，真正控件的父窗口不变。

```typescript
createInstance(type, props, rootContainer) {
  // 创建包装器窗口
  const wrapper = gui.CreateWindow('STATIC', '', WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
    sty.x ?? 0, sty.y ?? 0, sty.width ?? 100, sty.height ?? 30, rootContainer, null)!
  // 创建真正的控件窗口（以包装器为父）
  const hwnd = gui.CreateWindow(winClass, ..., wrapper)!
  // 返回包装器 Instance（hwnd = wrapper）
  // 把真正控件存到 instance._childHwnd
}

appendInitialChild(parent, child) {
  // SetParent 移动的是包装器，不是真正控件
  gui.SetParent(child.hwnd, parent.hwnd)
}
```

| 维度 | 评价 |
|------|------|
| 复杂度 | **高**—每个节点多一层窗口，需要同步包装器尺寸、转发消息 |
| 窗口数 | 翻倍 |
| 效果 | 治本—真正控件父窗口永远不变 |
| 风险 | 性能开销，flex layout 需要两层 |

### E：C 层 SetParent 后发自定义消息

在 `quickjs-win.c` 的 `gui.SetParent` 实现中，调 Windows `SetParent` 后再额外发消息：

```c
JSValue js_gui_SetParent(JSContext *ctx, ...) {
  HWND child = GetHwnd(argv[0]);
  HWND newParent = GetHwnd(argv[1]);
  SetParent(child, newParent);
  // 发送 WM_WINDOWPOSCHANGED 尝试让控件刷新
  SetWindowPos(child, NULL, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  // 或发送 WM_THEMECHANGED
  // PostMessage(child, WM_THEMECHANGED, 0, 0);
}
```

| 维度 | 评价 |
|------|------|
| 效果 | **推测性**—C 层能做的不比 JS 层多 |
| 风险 | 低，但 `SetWindowPos` 已测试无效 |
| 复杂度 | 低 |

### F：MFC 风格的消息反射（message reflection）

拦截所有 `WM_NOTIFY`/`WM_COMMAND`，反射回子控件自身处理。MFC 通过 `ON_NOTIFY_REFLECT` 宏实现。

在我们的场景中不需要——我们没有 child control class 的概念，所有逻辑在父组件的 `onEvent` 中。

| 维度 | 评价 |
|------|------|
| 适用性 | **不适用**—我们的架构不需要反射 |

---

## 最终采用方案：延迟 CreateWindow（针对 SysListView32 / SysTreeView32）

### 理由

1. **零 SetParent** — 缓存控件在创建时就以正确父窗口为父，彻底避免缓存问题
2. **不改消息流** — 不需要拦截/转发 WM_NOTIFY，不需要 ffi 读 lParam
3. **复杂度适中** — reconciler 加 ~50 行，ListView 组件简化
4. **已验证** — ListView 正确显示、flex 布局、WM_NOTIFY 到 wrapper `onEvent`

### 需要改的文件

| 文件 | 改动 |
|------|------|
| `lib/react-qw/reconciler.ts` | `Instance.hwnd` 改 `HWND | null`；加 `isDelayedControl`、`setupWindowProc`、`ensureChildWindow`；分支处理 append/remove |
| `lib/react-qw/props.ts` | `applyProps` 用局部 `hwnd = instance.hwnd!` |
| `lib/react-qw/components/ListView.tsx` | 简化为 `<w type="SysListView32">` |

### 局限

- 仅适用于**叶子节点控件**（无 React children）。SysTreeView32 同理。
- EDIT/LISTBOX/COMBOBOX 仍通过 `SetParent` 创建——但这些控件发送的是 `WM_COMMAND`（通过 `lParam` 传 HWND，不被缓存影响），故无缓存问题。
- 如果未来遇到更多受缓存影响的控件且它们也是叶子节点，加入 `DELAYED_CONTROLS` 即可。

### 抛弃方案

- **A/A2 (WM_NOTIFY/WM_COMMAND 转发)**：尝试后出现多个控件不显示的问题，怀疑子类链在 repeated prepareForCommit → clearContainer 中退化
- **B (SetWindowPos 刷新)**：已验证无效
- **C (POPUP + WS_CHILD)**：推测性，未测试
- **D (wrapper container)**：窗口数翻倍，性能开销大
- **E (C 层 SetParent 增强)**：效果不优于 JS 层
- **F (MFC 消息反射)**：不适用
