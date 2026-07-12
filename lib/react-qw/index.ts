import * as gui from 'gui'
import reconciler from './reconciler.js'

const noop = () => { }

export interface RootWindowConfig {
  text?: string
  ws?: number
  x?: number
  y?: number
  width?: number
  height?: number
}

let defaultClassRegistered = false
const DEFAULT_CLASS = '_QuickWinDefault'
const rootMap = new Map<gui.HWND, any>()

function ensureDefaultClass() {
  if (defaultClassRegistered) return DEFAULT_CLASS
  gui.RegisterClass(DEFAULT_CLASS, (hwnd, msg, wParam, lParam) => {
    if (msg === gui.WmMsg.DESTROY) {
      const root = rootMap.get(hwnd)
      if (root) {
        reconciler.updateContainer(null, root, null, noop)
        rootMap.delete(hwnd)
      }
      return 0
    }
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
      cfg.x ?? 0x80000000, cfg.y ?? 0x80000000,
      cfg.width ?? 800, cfg.height ?? 600,
      null, null
    )
    if (!h) throw new Error('CreateWindow failed')
    hwnd = h
    gui.ShowWindow(hwnd)
  } else {
    hwnd = container
  }
  const root = reconciler.createContainer(
    hwnd, 0, null, false, null, '',
    noop, noop, noop, noop,
  )
  if (typeof container === 'object')
    rootMap.set(hwnd, root)
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
