import * as gui from 'gui'
import reconciler, { scaleFactor, instancesByHwnd, forceFlexLayout, type Instance } from './reconciler.js'

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
const rootMap = new Map<gui.HWND, { root: any, onEvent?: RootWindowConfig['onEvent'] }>()

function ensureDefaultClass() {
  if (defaultClassRegistered) return DEFAULT_CLASS
  gui.RegisterClass(DEFAULT_CLASS, (hwnd, msg, wParam, lParam) => {
    if (msg === gui.WmMsg.DESTROY) {
      const entry = rootMap.get(hwnd)
      if (entry) {
        rootMap.delete(hwnd)
        reconciler.updateContainer(null, entry.root, null, () => {
          instancesByHwnd.delete(hwnd)
        })
      }
    }
    const entry = rootMap.get(hwnd)
    const result = entry?.onEvent?.({ hwnd, msg, wParam, lParam })
    if (typeof result === 'number') return result
    if (msg === gui.WmMsg.SIZE) forceFlexLayout(hwnd)
    return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  })
  defaultClassRegistered = true
  return DEFAULT_CLASS
}

export function createRoot(container: gui.HWND | RootWindowConfig) {
  let hwnd: gui.HWND
  if (typeof container === 'object') {
    const cfg = container
    const className = ensureDefaultClass()
    const ws = (cfg.ws ?? 0) | gui.WindowStyle.OVERLAPPEDWINDOW
    const h = gui.CreateWindow(
      className, cfg.text || '', ws,
      cfg.x != null ? cfg.x * scaleFactor : gui.CreatePos.USEDEFAULT,
      cfg.y != null ? cfg.y * scaleFactor : gui.CreatePos.USEDEFAULT,
      (cfg.width ?? 800) * scaleFactor,
      (cfg.height ?? 600) * scaleFactor,
      null, null
    )
    if (!h) throw new Error('CreateWindow failed')
    hwnd = h
    if (!cfg.noShowWindow) gui.ShowWindow(hwnd)
  } else {
    hwnd = container
  }
  const root = reconciler.createContainer(
    hwnd, 0, null, false, null, '',
    noop, noop, noop, noop,
  )
  const rootInst: Instance = { hwnd, type: '_root', props: { style: { flexDirection: 'column', alignItems: 'stretch' } }, children: [] }
  instancesByHwnd.set(hwnd, rootInst)
  if (typeof container === 'object')
    rootMap.set(hwnd, { root, onEvent: container.onEvent })
  return {
    render(element: any) {
      reconciler.updateContainer(element, root, null, noop)
    },
    unmount() {
      reconciler.updateContainer(null, root, null, noop)
    }
  }
}

export * from './components/index.js'

export function render(element: any, containerOrConfig?: gui.HWND | RootWindowConfig | null, callback?: () => void) {
  if (containerOrConfig == null) {
    throw new Error('render() requires a window handle or RootWindowConfig as second argument')
  }
  const root = createRoot(containerOrConfig)
  root.render(element)
}
