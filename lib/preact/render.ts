import '../polyfill.js'
import * as gui from 'gui'
import * as os from 'os'
import { applyProps, destroyWindow } from './props.js'
import { layout as doLayout } from './layout.js'
import { options, type VNode as PreactVNode, type ComponentChild } from './preact.js'

const scaleFactor = gui.GetScaleFactor()
const dpiFont = gui.CreateSystemDpiFont()

type RefCallback = (hwnd: gui.HWND) => void

function setHwndRef(vnode: QWVNode, hwnd: gui.HWND): void {
    vnode[HWND_PROP] = hwnd
    const ref = vnode.ref as RefCallback | { current: unknown } | null
    if (ref) {
        if (typeof ref === 'function') {
            ref(hwnd)
        } else {
            ref.current = hwnd
        }
    }
}

const HWND_PROP = '__qw_hwnd'
const STYLE_PROP = '__qw_style'
const CHILDREN_HWNDS_PROP = '__qw_children'
const RENDERED_VNODE_PROP = '__qw_rendered'

interface QWComponent {
    _vnode: QWVNode | null
    props: any
    context: any
    __hooks: { _list: any[]; _pendingEffects: any[] } | null
    _renderCallbacks: Array<() => void>
    _parentDom: unknown
    _qw_parent_hwnd: gui.HWND
    _dirty: boolean
    _forceUpdate(): void
}

interface QWVNode extends PreactVNode {
    [key: string]: unknown
}

let rootHwnd: gui.HWND | null = null
let rootVNode: QWVNode | null = null

function createControl(type: string, parentHwnd: gui.HWND, vnode: QWVNode): gui.HWND {
    const ws = (vnode.props?.ws as number) || 0
    const style = gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | ws
    const text = (vnode.props?.text || '') as string
    const hwnd = gui.CreateWindow(type, text, style, 0, 0, 0, 0, parentHwnd, null)
    if (!hwnd) return 0 as gui.HWND
    gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont as unknown as number, 1)
    applyProps(hwnd, vnode.props || {}, vnode)
    return hwnd
}

function isVNode(val: unknown): val is QWVNode {
    return val != null && typeof val === 'object' && (val as any).constructor === undefined && (val as any).type !== undefined
}

function getChildren(vnode: QWVNode): unknown[] {
    const children = vnode.props?.children
    if (children == null) return []
    if (Array.isArray(children)) return children.filter((c: unknown) => c != null && c !== false && c !== true)
    if (typeof children === 'object' && (children as any).type !== undefined) return [children]
    return []
}

function renderToWin32(vnode: unknown, parentHwnd: gui.HWND, context: any): gui.HWND {
    if (vnode == null || vnode === false || vnode === true) return 0 as gui.HWND

    if (typeof vnode === 'string' || typeof vnode === 'number') {
        const hwnd = gui.CreateWindow('STATIC', String(vnode), gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.StaticStyle.LEFT, 0, 0, 0, 0, parentHwnd, null)
        if (hwnd) gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont as unknown as number, 1)
        return hwnd
    }

    if (Array.isArray(vnode)) {
        for (const child of vnode) renderToWin32(child, parentHwnd, context)
        return 0 as gui.HWND
    }

    if (!isVNode(vnode)) return 0 as gui.HWND

    if (typeof vnode.type === 'function') {
        return renderComponent(vnode, parentHwnd, context)
    }

    if (vnode.type === 'w') {
        const ctrlType = vnode.props?.type as string | undefined
        if (!ctrlType) return 0 as gui.HWND
        const hwnd = createControl(ctrlType, parentHwnd, vnode)
        if (!hwnd) return 0 as gui.HWND

        setHwndRef(vnode, hwnd)
        vnode[STYLE_PROP] = vnode.props?.style ?? {}

        const children = getChildren(vnode)
        const childHwnds: number[] = []
        for (const child of children) {
            const childHwnd = renderToWin32(child, hwnd, context)
            if (childHwnd) childHwnds.push(childHwnd as unknown as number)
        }
        vnode[CHILDREN_HWNDS_PROP] = childHwnds
        return hwnd
    }

    return 0 as gui.HWND
}

function invokeComponent(component: QWComponent, vnode: QWVNode): ComponentChild {
    options._diff?.(vnode)
    options._render?.(vnode)
    try {
        const fn = vnode.type as (...args: any[]) => any
        return fn.call(component, component.props, component.context)
    } catch (e: unknown) {
        const errHandler = (component as any)._errorHandler
        if (errHandler) {
            errHandler(e)
            return null
        }
        console.log('[preact-render] render threw: ' + e)
        return null
    } finally {
        options.diffed?.(vnode)
    }
}

function renderComponent(vnode: QWVNode, parentHwnd: gui.HWND, context: any): gui.HWND {
    const rendered = invokeComponent(newComponent(vnode, parentHwnd, context), vnode)
    if (rendered == null) return 0 as gui.HWND
    const resultHwnd = renderToWin32(rendered, parentHwnd, context)
    setHwndRef(vnode, resultHwnd)
    vnode[RENDERED_VNODE_PROP] = rendered
    vnode[STYLE_PROP] = vnode.props?.style as Record<string, any> ?? rendered[STYLE_PROP] as Record<string, any> ?? {}
    return resultHwnd
}

function newComponent(vnode: QWVNode, parentHwnd: gui.HWND, context: any): QWComponent {
    const component: QWComponent = {
        _vnode: vnode,
        props: vnode.props,
        context,
        __hooks: { _list: [], _pendingEffects: [] },
        _renderCallbacks: [],
        _parentDom: true,
        _qw_parent_hwnd: parentHwnd,
        _dirty: false,
        _forceUpdate() {
            component._dirty = true
            scheduleUpdate(component)
        },
    }
    vnode._component = component as any
    return component
}

function destroyHwnd(hwnd: number): void {
    if (!hwnd) return
    gui.UnsetWindowProc(hwnd as gui.HWND)
    destroyWindow(hwnd)
}

function destroyVNode(vnode: QWVNode): void {
    options.unmount?.(vnode)

    const hwnd = vnode[HWND_PROP] as number | undefined
    if (hwnd) destroyHwnd(hwnd)
    const ref = vnode.ref as RefCallback | { current: unknown } | null
    if (ref) {
        if (typeof ref === 'function') {
            ref(0 as gui.HWND)
        } else {
            ref.current = null
        }
    }
    vnode[HWND_PROP] = 0

    for (const child of getChildren(vnode)) {
        if (isVNode(child)) destroyVNode(child)
    }

    const extra = vnode[CHILDREN_HWNDS_PROP] as number[] | undefined
    if (extra) {
        for (const h of extra) destroyHwnd(h)
    }
    vnode[CHILDREN_HWNDS_PROP] = []
}

function reconcile(
    oldVNode: unknown,
    newVNode: unknown,
    parentHwnd: gui.HWND,
    context: any
): gui.HWND {
    if (oldVNode == null || oldVNode === false || oldVNode === true) {
        return renderToWin32(newVNode, parentHwnd, context)
    }
    if (newVNode == null || newVNode === false || newVNode === true) {
        if (isVNode(oldVNode)) destroyVNode(oldVNode as QWVNode)
        return 0 as gui.HWND
    }
    if (typeof oldVNode !== typeof newVNode ||
        typeof oldVNode === 'string' || typeof oldVNode === 'number' ||
        Array.isArray(oldVNode) || Array.isArray(newVNode)) {
        if (isVNode(oldVNode)) destroyVNode(oldVNode as QWVNode)
        return renderToWin32(newVNode, parentHwnd, context)
    }
    if (!isVNode(oldVNode) || !isVNode(newVNode)) {
        return renderToWin32(newVNode, parentHwnd, context)
    }

    const o = oldVNode as QWVNode
    const n = newVNode as QWVNode

    if (typeof n.type === 'function') {
        const oldComp = o._component as QWComponent | null
        let comp: QWComponent
        if (oldComp) {
            oldComp._vnode = n
            oldComp.props = n.props
            oldComp._qw_parent_hwnd = parentHwnd
            comp = oldComp
        } else {
            if (isVNode(o)) destroyVNode(o)
            comp = newComponent(n, parentHwnd, context)
        }
        n._component = comp as any

        const oldResult = o[RENDERED_VNODE_PROP]
        const newResult = invokeComponent(comp, n)

        let resultHwnd: gui.HWND
        if (newResult != null) {
            resultHwnd = reconcile(oldResult || null, newResult, parentHwnd, context)
        } else {
            if (oldResult && isVNode(oldResult)) destroyVNode(oldResult as QWVNode)
            resultHwnd = 0 as gui.HWND
        }
        setHwndRef(n, resultHwnd)
        n[RENDERED_VNODE_PROP] = newResult
        n[STYLE_PROP] = n.props?.style as Record<string, any> ?? (newResult ? newResult[STYLE_PROP] : {}) ?? {}
        return resultHwnd
    }

    if (o.type === 'w' && n.type === 'w') {
        const oldCtrl = (o.props?.type as string) || ''
        const newCtrl = (n.props?.type as string) || ''
        if (oldCtrl === newCtrl) {
            const hwnd = o[HWND_PROP] as gui.HWND | undefined
            if (hwnd) {
                setHwndRef(n, hwnd)
                n[STYLE_PROP] = n.props?.style ?? {}
                n._oldProc = o._oldProc
                applyProps(hwnd, n.props || {}, n)

                const oldChildren = getChildren(o)
                const newChildren = getChildren(n)
                const oldChildHwnds = o[CHILDREN_HWNDS_PROP] as number[] | undefined
                const childHwnds: number[] = []
                const maxLen = Math.max(oldChildren.length, newChildren.length)
                for (let i = 0; i < maxLen; i++) {
                    const oc = oldChildren[i]
                    const nc = newChildren[i]
                    if (oc != null && oc !== false && oc !== true) {
                        if (nc != null && nc !== false && nc !== true) {
                            if (typeof oc === 'string' && typeof nc === 'string') {
                                if (oc !== nc && oldChildHwnds && oldChildHwnds[i]) {
                                    applyProps(oldChildHwnds[i] as gui.HWND, { text: nc })
                                }
                                if (oldChildHwnds && oldChildHwnds[i])
                                    childHwnds.push(oldChildHwnds[i])
                            } else {
                                const ch = reconcile(oc, nc, hwnd, context)
                                if (ch) childHwnds.push(ch as unknown as number)
                            }
                        } else {
                            if (isVNode(oc)) destroyVNode(oc)
                            else if (oldChildHwnds && oldChildHwnds[i])
                                destroyHwnd(oldChildHwnds[i])
                        }
                    } else if (nc != null && nc !== false && nc !== true) {
                        const ch = renderToWin32(nc, hwnd, context)
                        if (ch) childHwnds.push(ch as unknown as number)
                    }
                }
                n[CHILDREN_HWNDS_PROP] = childHwnds
                return hwnd
            }
        }
    }

    destroyVNode(o)
    return renderToWin32(n, parentHwnd, context)
}

function scheduleUpdate(component: QWComponent): void {
    if (!component._dirty) return
    os.setTimeout(() => {
        if (!component._dirty) return
        component._dirty = false

        const vnode = component._vnode as QWVNode
        const parentHwnd = component._qw_parent_hwnd
        if (!parentHwnd) return

        const oldRendered = vnode[RENDERED_VNODE_PROP]
        const rendered = invokeComponent(component, vnode)

        if (rendered != null) {
            reconcile(oldRendered || null, rendered, parentHwnd, component.context)
        } else if (oldRendered) {
            if (isVNode(oldRendered)) destroyVNode(oldRendered as QWVNode)
        }
        vnode[RENDERED_VNODE_PROP] = rendered

        const commitQueue = [component]
        options._commit?.(vnode, commitQueue as any)

        if (rootHwnd && rootVNode) {
            doLayout(rootHwnd as unknown as number, rootVNode)
        }
    }, 0)
}

export function notifyResize(hwnd: gui.HWND): void {
    if (rootVNode) doLayout(hwnd as unknown as number, rootVNode)
}

export function render(vnode: any, containerHwnd: gui.HWND): gui.HWND {
    rootHwnd = containerHwnd
    rootVNode = vnode

    renderToWin32(vnode, containerHwnd, {})

    if (vnode._component) {
        const commitQueue = [vnode._component]
        options._commit?.(vnode, commitQueue as any)
    }

    doLayout(containerHwnd as unknown as number, vnode)
    return containerHwnd
}

export { HWND_PROP, STYLE_PROP, CHILDREN_HWNDS_PROP, RENDERED_VNODE_PROP, isVNode, getChildren, type QWVNode, type QWComponent }
// re-export as VNode for layout.ts compat
export type VNode = QWVNode
export { scaleFactor }
