import ReactReconciler from 'react-reconciler'
import { createContext } from 'react'
import { DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants'
import * as gui from 'gui'
import * as os from 'os'
import { applyProps } from './props.js'
import { calculateFlexLayout, type FlexStyle } from './layout.js'

// DEBUG 由 esbuild --define 在 bundle 时替换（见 build.ts），生产环境为 false
declare const DEBUG: boolean

const dpiFont = gui.CreateSystemDpiFont()
export const scaleFactor = gui.GetScaleFactor()

type Container = gui.HWND
type Props = Record<string, any>

export interface Instance {
  hwnd: gui.HWND | null
  type: string
  props: Props
  children: Instance[]
  lastRect?: { x: number; y: number; w: number; h: number }
}

const DELAYED_CONTROLS = new Set(['SysListView32', 'SysTreeView32', 'LISTBOX', 'COMBOBOX', 'msctls_trackbar32', 'SysDateTimePick32', 'SysLink'])

function isDelayedControl(winClass: string): boolean {
  return DELAYED_CONTROLS.has(winClass)
}

function setupWindowProc(instance: Instance, hwnd: gui.HWND) {
  instance.hwnd = hwnd
  const oldProc = gui.GetWindowLongPtr(hwnd, gui.Gwlp.WNDPROC) as unknown as gui.WNDPROC
  instancesByHwnd.set(hwnd, instance)
  gui.SetWindowProc(hwnd, (hwnd: gui.HWND, msg: number, wParam: number, lParam: number) => {
    const ev = instance.props.onEvent
    if (!ev) return gui.CallWindowProc(oldProc, hwnd, msg, wParam, lParam)
    if (typeof ev === 'object') {
      return ev.fn({ hwnd, msg, wParam, lParam, callOldWndProc: () => gui.CallWindowProc(oldProc, hwnd, msg, wParam, lParam) })
    }
    const result = gui.CallWindowProc(oldProc, hwnd, msg, wParam, lParam)
    const override = ev({ hwnd, msg, wParam, lParam })
    return Number.isInteger(override) ? override : result
  })
}

function ensureChildWindow(child: Instance, parentHwnd: gui.HWND): gui.HWND {
  if (child.hwnd !== null) return child.hwnd
  const sty = child.props.style || {}
  const ws = (child.props.ws ?? 0) | gui.WindowStyle.CHILD
  const hwnd = gui.CreateWindow(
    child.type, child.props.text || '', ws,
    (sty.x ?? 0) * scaleFactor, (sty.y ?? 0) * scaleFactor,
    (sty.width ?? 100) * scaleFactor, (sty.height ?? 30) * scaleFactor,
    parentHwnd, null
  )!
  if (dpiFont) gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont, 1)
  setupWindowProc(child, hwnd)
  return hwnd
}

type HostContext = Record<string, never>

const instancesByHwnd = new Map<gui.HWND, Instance>()

function runFlexLayout(inst: Instance) {
  const children = inst.children.filter(c => typeof c === 'object') as Instance[]
  if (children.length === 0) return
  const s = inst.props.style
  const flex: FlexStyle = s || {}
  if (flex.flexDirection === undefined && flex.gap === undefined && flex.justifyContent === undefined && flex.alignItems === undefined) {
    for (const c of children) runFlexLayout(c)
    return
  }
  const visible = children.filter(c => !c.props.hidden)
  if (visible.length === 0) return
  const rect = gui.GetClientRect(inst.hwnd!)
  if (!rect) { console.log('flex: no rect for', inst.hwnd, inst.type); return }
  const pw = (rect.right - rect.left) / scaleFactor
  const ph = (rect.bottom - rect.top) / scaleFactor
  if (pw <= 0 || ph <= 0) { console.log('flex: zero size for', inst.hwnd, inst.type, pw, ph); return }
  const results = calculateFlexLayout(flex, pw, ph, visible.map(c => ({ style: c.props.style || {} })))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const child = visible[i]
    const lr = child.lastRect
    if (lr && lr.x === r.x && lr.y === r.y && lr.w === r.width && lr.h === r.height) continue
    console.log('flex: set', child.type, child.hwnd, 'to', r.x, r.y, r.width, r.height)
    gui.SetWindowPos(child.hwnd!, 0, r.x * scaleFactor, r.y * scaleFactor, r.width * scaleFactor, r.height * scaleFactor, 0)
    child.lastRect = { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  for (const c of children) runFlexLayout(c)
}

export function forceFlexLayout(hwnd: gui.HWND): void {
  const inst = instancesByHwnd.get(hwnd)
  if (inst) runFlexLayout(inst)
}

/**
 * 扩展 HostConfig 类型定义
 * 
 * @types/react-reconciler 的 HostConfig 存在以下问题：
 * 1. 缺少 rendererPackageName/rendererVersion 属性
 * 
 * 解决方案：扩展补充缺失定义
 */
type QuickWinHostConfig = ReactReconciler.HostConfig<
  string, Props, Container, Instance, Instance,
  never, never, never, gui.HWND,
  HostContext, never, any, -1, null
> & {
  // rendererPackageName/rendererVersion（原类型定义中缺失）
  rendererPackageName: string
  rendererVersion: string
}

let currentUpdatePriority = NoEventPriority

const hostConfig: QuickWinHostConfig = {
  // Core methods
  createInstance(type: string, props: Record<string, any>, rootContainer: Container) {
    if (DEBUG) console.log('[reconciler] createInstance called:', type, 'class=' + props.type)
    const winClass = props.type
    if (isDelayedControl(winClass)) {
      if (DEBUG) console.log('[reconciler] delayed control, skipping CreateWindow:', winClass)
      return { hwnd: null, type: winClass, props, children: [] } as Instance
    }
    const sty = props.style || {}
    // reconciler 创建的都是子窗口，确保 WS_CHILD 避免定位异常
    const ws = (props.ws ?? 0) | gui.WindowStyle.CHILD
    if (DEBUG) console.log('[reconciler] CreateWindow args:', winClass, props.text || '', ws, sty.x ?? 0, sty.y ?? 0, sty.width ?? 100, sty.height ?? 30, rootContainer)
    const hwnd = gui.CreateWindow(
      winClass, props.text || '', ws,
      (sty.x ?? 0) * scaleFactor, (sty.y ?? 0) * scaleFactor,
      (sty.width ?? 100) * scaleFactor, (sty.height ?? 30) * scaleFactor,
      rootContainer, null
    )!
    if (dpiFont) gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont, 1)
    if (DEBUG) console.log('[reconciler] createInstance hwnd result:', hwnd, 'null?', hwnd === null)
    const instance: Instance = { hwnd, type: winClass, props, children: [] }
    setupWindowProc(instance, hwnd)
    return instance
  },

  createTextInstance(_text: string, _rootContainer: Container) {
    throw new Error('should never be called (shouldSetTextContent=true)')
  },

  appendInitialChild(parent: Instance, child: Instance) {
    if (child.hwnd === null) {
      ensureChildWindow(child, parent.hwnd!)
    } else {
      gui.SetParent(child.hwnd, parent.hwnd)
    }
    if (DEBUG) console.log('[reconciler] appendInitialChild parent:', parent.hwnd, 'child:', child.hwnd)
    parent.children.push(child)
  },

  appendChild(parent: Instance, child: Instance) {
    if (child.hwnd === null) {
      ensureChildWindow(child, parent.hwnd!)
    } else {
      gui.SetParent(child.hwnd, parent.hwnd)
    }
    if (DEBUG) console.log('[reconciler] appendChild parent:', parent.hwnd, 'child:', child.hwnd)
    parent.children.push(child)
  },

  appendChildToContainer(container: Container, child: Instance) {
    if (child.hwnd === null) {
      ensureChildWindow(child, container)
    } else {
      gui.SetParent(child.hwnd, container)
    }
    if (DEBUG) console.log('[reconciler] appendChildToContainer container:', container, 'child hwnd:', child.hwnd)
  },

  insertBefore(parent: Instance, child: Instance, beforeChild: Instance) {
    if (child.hwnd === null) {
      ensureChildWindow(child, parent.hwnd!)
    } else {
      gui.SetParent(child.hwnd, parent.hwnd)
    }
    if (DEBUG) console.log('[reconciler] insertBefore parent:', parent.hwnd, 'child:', child.hwnd, 'before:', beforeChild.hwnd)
    const idx = parent.children.indexOf(beforeChild)
    if (idx >= 0) parent.children.splice(idx, 0, child)
  },

  insertInContainerBefore(container: Container, child: Instance, _before: any) {
    if (child.hwnd === null) {
      ensureChildWindow(child, container)
    } else {
      gui.SetParent(child.hwnd, container)
    }
    if (DEBUG) console.log('[reconciler] insertInContainerBefore container:', container, 'child hwnd:', child.hwnd)
  },

  removeChild(parent: Instance, child: Instance) {
    if (DEBUG) console.log('[reconciler] removeChild parent:', parent.hwnd, 'child:', child.hwnd, 'type:', child.type)
    if (child.hwnd !== null) gui.DestroyWindow(child.hwnd)
    const idx = parent.children.indexOf(child)
    if (idx >= 0) parent.children.splice(idx, 1)
  },

  removeChildFromContainer(container: Container, child: Instance) {
    if (child.hwnd === null) return
    if (DEBUG) console.log('[reconciler] removeChildFromContainer container:', container, 'child hwnd:', child.hwnd)
    gui.DestroyWindow(child.hwnd)
  },

  commitUpdate(instance: Instance, _type: string, oldProps: Record<string, any>, newProps: Record<string, any>, _internalHandle: any) {
    applyProps(instance, newProps, oldProps)
  },

  commitMount(_instance: Instance, _type: string, _props: Record<string, any>, _internal: any) { },

  finalizeInitialChildren(instance: Instance, _type: string, props: Record<string, any>) {
    if (DEBUG) console.log('[reconciler] finalizeInitialChildren instance:', instance.hwnd, 'props:', JSON.stringify(props))
    applyProps(instance, props, {})
    return false
  },

  resetAfterCommit(containerInfo: Container) {
    if (DEBUG) console.log('[reconciler] resetAfterCommit')
    let count = 0
    let child = gui.GetWindow(containerInfo, gui.GetWindowCmd.CHILD)
    while (child) {
      count++
      if (DEBUG) console.log('[reconciler] resetAfterCommit child:', child)
      const inst = instancesByHwnd.get(child)
      if (inst) runFlexLayout(inst)
      child = gui.GetWindow(child, gui.GetWindowCmd.NEXT)
    }
    if (DEBUG) console.log('[reconciler] resetAfterCommit child count:', count)
  },

  resetTextContent(_instance: Instance) { },

  shouldSetTextContent(_type: string, props: Record<string, any>) {
    return typeof props.children === 'string' || typeof props.children === 'number'
  },

  getPublicInstance(instance: Instance) {
    return instance.hwnd!
  },

  getRootHostContext(_rootContainer: Container) {
    return {}
  },

  getChildHostContext(_parentContext: any, _type: string) {
    return {}
  },

  prepareForCommit(_containerInfo: Container) {
    return null
  },

  preparePortalMount(_containerInfo: Container) { },

  clearContainer(_container: Container) {
    // 不需要清理，React reconciler 会通过 removeChildFromContainer 来移除子节点
  },

  scheduleTimeout(fn: () => void, delay: number) {
    return os.setTimeout(fn, delay)
  },

  cancelTimeout(id: any) {
    os.clearTimeout?.(id)
  },

  noTimeout: -1,

  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  supportsMicrotasks: false,

  setCurrentUpdatePriority(p: number) { currentUpdatePriority = p },
  getCurrentUpdatePriority() { return currentUpdatePriority },
  resolveUpdatePriority() { return DefaultEventPriority },

  resolveEventType() { return null },
  resolveEventTimeStamp() { return Date.now() },
  trackSchedulerEvent() { },

  shouldAttemptEagerTransition() { return false },
  detachDeletedInstance(instance: Instance) {
    if (DEBUG) console.log('[reconciler] detachDeletedInstance hwnd:', instance.hwnd, 'type:', instance.type)
    if (instance.hwnd !== null) instancesByHwnd.delete(instance.hwnd)
  },
  
  // 添加必需方法
  getInstanceFromNode(_node: any) { return null },
  beforeActiveInstanceBlur() { },
  afterActiveInstanceBlur() { },
  prepareScopeUpdate(_scopeInstance: any, _instance: any) { },
  getInstanceFromScope(_scopeInstance: any) { return null },
  
  // Suspense/Concurrent Mode 支持
  maySuspendCommit() { return false },
  requestPostPaintCallback() { },
  preloadInstance() { return true },
  startSuspendingCommit() { },
  suspendInstance() { },
  waitForCommitToBeReady() { return null },

  rendererVersion: '0.1.0',
  rendererPackageName: 'react-qw',
  NotPendingTransition: null,
  HostTransitionContext: createContext(null) as any,
  resetFormInstance(_form: any) { },
}

const reconciler = ReactReconciler(hostConfig)
export default reconciler
