import * as gui from 'gui'
import reconciler from './reconciler.js'

const noop = () => {}

export function createRoot(containerHwnd: gui.HWND) {
  const root = reconciler.createContainer(
    containerHwnd, 0, null, false, null, '',
    noop, noop, noop, noop,
  )
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

export function render(element: any, containerHwnd: gui.HWND, callback?: () => void) {
  const root = createRoot(containerHwnd)
  root.render(element)
}
