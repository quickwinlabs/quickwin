import * as gui from 'gui'
import React from 'react'
import { DefWindowProc, GetSystemMetrics, ShowWindow, UpdateWindow } from '../windows/user32.js'
import reconciler, { scaleFactor, instancesByHwnd, forceFlexLayout, type Instance } from './reconciler.js'
import { CreatePos, ShowWindowCmd, SysMetrics, WindowStyle, WmMsg } from '../../constants'

const noop = () => { }

export interface RootWindowConfig {
  text?: string
  ws?: number
  x?: number
  y?: number
  width?: number
  height?: number
  noShowWindow?: boolean
  onEvent?: (e: { hwnd: gui.HWND; msg: number; wParam: number; lParam: number }) => number | void
}

let defaultClassRegistered = false
const DEFAULT_CLASS = '_QuickWinDefault'
const rootMap = new Map<gui.HWND, { root: ReturnType<typeof reconciler.createContainer>, onEvent?: RootWindowConfig['onEvent'] }>()

function ensureDefaultClass() {
  if (defaultClassRegistered) return DEFAULT_CLASS
  gui.RegisterClass(DEFAULT_CLASS, (hwnd, msg, wParam, lParam) => {
    const entry = rootMap.get(hwnd)
    if (msg === WmMsg.DESTROY && entry) {
      rootMap.delete(hwnd)
      reconciler.updateContainer(null, entry.root, null, () => {
        instancesByHwnd.delete(hwnd)
      })
    }
    const result = entry?.onEvent?.({ hwnd, msg, wParam, lParam })
    if (typeof result === 'number') return result
    if (msg === WmMsg.SIZE) forceFlexLayout(hwnd)
    return DefWindowProc(hwnd, msg, wParam, lParam)
  })
  defaultClassRegistered = true
  return DEFAULT_CLASS
}

export function createRoot(container: gui.HWND | RootWindowConfig) {
  let hwnd: gui.HWND
  if (typeof container === 'object') {
    const cfg = container
    const className = ensureDefaultClass()
    const ws = (cfg.ws ?? 0) | WindowStyle.OVERLAPPEDWINDOW
    const w = (cfg.width ?? 800) * scaleFactor
    const h = (cfg.height ?? 600) * scaleFactor
    const [sw, sh] = [GetSystemMetrics(SysMetrics.CXSCREEN), GetSystemMetrics(SysMetrics.CYSCREEN)]
    const x = cfg.x === undefined ? ((sw - w) / 2) | 0
      : cfg.x === CreatePos.USEDEFAULT ? CreatePos.USEDEFAULT
      : cfg.x * scaleFactor
    const y = cfg.y === undefined ? ((sh - h) / 2) | 0
      : cfg.y === CreatePos.USEDEFAULT ? CreatePos.USEDEFAULT
      : cfg.y * scaleFactor
    const hwin = gui.CreateWindow(className, cfg.text || '', ws, x, y, w, h, null, null)
    if (!hwin) throw new Error('CreateWindow failed')
    hwnd = hwin
    // 启动首帧：ShowWindow 后立即 WM_PAINT，不留白（原 gui.ShowWindow 复合语义）
    if (!cfg.noShowWindow) { ShowWindow(hwnd, ShowWindowCmd.SHOWNORMAL); UpdateWindow(hwnd) }
  } else {
    hwnd = container
  }
  const root = reconciler.createContainer(
    hwnd, 0, null, false, null, '',
    (error, info) => console.log('[React uncaught]', error, error.stack, info.componentStack),
    (error, info) => console.log('[React caught]', error, error.stack, info.componentStack),
    (error, info) => console.log('[React recoverable]', error, error.stack, info.componentStack),
    noop,
  )
  const rootInst: Instance = { hwnd, type: '_root', props: { type: '_root', style: { flexDirection: 'column', alignItems: 'stretch' } }, children: [] }
  instancesByHwnd.set(hwnd, rootInst)
  if (typeof container === 'object')
    rootMap.set(hwnd, { root, onEvent: container.onEvent })
  return {
    hwnd,
    render(element: React.ReactNode) {
      reconciler.updateContainer(element, root, null, noop)
    },
    unmount() {
      reconciler.updateContainer(null, root, null, noop)
    }
  }
}

export * from './components/index.js'

export function render(element: React.ReactNode, containerOrConfig?: gui.HWND | RootWindowConfig | null, _callback?: () => void) {
  if (containerOrConfig == null) {
    throw new Error('render() requires a window handle or RootWindowConfig as second argument')
  }
  const root = createRoot(containerOrConfig)
  root.render(element)
}
