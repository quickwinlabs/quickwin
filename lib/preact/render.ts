import '../polyfill.js'
import * as gui from 'gui'
import type { HWND } from 'gui'
import * as os from 'os'
import { applyProps, destroyWindow } from './props.js'
import { layout as doLayout, type LayoutStyle } from './layout.js'
import { options, type VNode as PreactVNode, type ComponentChild, type ComponentType, type Component } from './preact.js'

const scaleFactor = gui.GetScaleFactor()
const dpiFont = gui.CreateSystemDpiFont()

type RefCallback = (hwnd: HWND | null) => void

const HWND_PROP = '__qw_hwnd'
const STYLE_PROP = '__qw_style'
const CHILDREN_HWNDS_PROP = '__qw_children'
const RENDERED_VNODE_PROP = '__qw_rendered'

type QWComponent = {
    _vnode: QWVNode | null
    props: any
    context: any
    __hooks: { _list: any[]; _pendingEffects: any[] } | null
    _renderCallbacks: Array<() => void>
    _parentDom: unknown
    _qw_parent_hwnd: HWND
    _dirty: boolean
    _forceUpdate(): void
    _errorHandler?: (err: any) => void
}

type Win32ElProps = {
    type: string
    text?: string
    ws?: number
    style?: LayoutStyle
    disabled?: boolean
    visible?: boolean
    selectedIndex?: number
    sort?: boolean
    gridLines?: boolean
    columns?: string[]
    columnWidths?: number[]
    placeholder?: string
    multiline?: boolean
    password?: boolean
    singleline?: boolean
    onEvent?: (e: Record<string, any>) => void
    onOK?: () => void
    children?: ComponentChild
}

type QWVNodeBase = {
    __qw_hwnd?: HWND | null
    __qw_style?: LayoutStyle
    __qw_children?: HWND[]
    __qw_rendered?: ComponentChild
    _oldProc?: unknown
}

type Win32VNode = Omit<PreactVNode<Win32ElProps>, 'type'> & QWVNodeBase & { type: 'w' }

type FuncVNode<P = {}> = Omit<PreactVNode<P>, 'type'> & QWVNodeBase & { type: ComponentType<P> }

type QWVNode = Win32VNode | FuncVNode<any>

let rootHwnd: HWND | null = null
let rootVNode: QWVNode | null = null

function setHwndRef(vnode: QWVNode, hwnd: HWND | null): void {
    vnode.__qw_hwnd = hwnd
    const ref = vnode.ref as RefCallback | { current: unknown } | null
    if (ref) {
        if (typeof ref === 'function') {
            ref(hwnd)
        } else {
            ref.current = hwnd
        }
    }
}

function createControl(type: string, parentHwnd: HWND, vnode: Win32VNode): HWND | null {
    const ws = vnode.props?.ws || 0
    const style = gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | ws
    const text = vnode.props?.text || ''
    const hwnd = gui.CreateWindow(type, text, style, 0, 0, 0, 0, parentHwnd, null)
    if (!hwnd) return null;
    gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont!, 1)
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
    if (typeof children === 'object' && (children as any)?.type !== undefined) return [children]
    return []
}

function renderToWin32(vnode: unknown, parentHwnd: HWND, context: any): HWND | null {
    if (vnode == null || vnode === false || vnode === true) return null

    if (typeof vnode === 'string' || typeof vnode === 'number') {
        const hwnd = gui.CreateWindow('STATIC', String(vnode), gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.StaticStyle.LEFT, 0, 0, 0, 0, parentHwnd, null)
        if (!hwnd) return null
        gui.SendMessage(hwnd, gui.WmMsg.SETFONT, dpiFont!, 1)
        return hwnd
    }

    if (Array.isArray(vnode)) {
        for (const child of vnode) renderToWin32(child, parentHwnd, context)
        return null
    }

    if (!isVNode(vnode)) return null

    if (typeof vnode.type === 'function') {
        return renderComponent(vnode, parentHwnd, context)
    }

    if (vnode.type === 'w') {
        const ctrlType = vnode.props?.type
        if (!ctrlType) return null
        const hwnd = createControl(ctrlType, parentHwnd, vnode)
        if (!hwnd) return null

        setHwndRef(vnode, hwnd)
        vnode.__qw_style = vnode.props?.style ?? {}

        const children = getChildren(vnode)
        const childHwnds: HWND[] = []
        for (const child of children) {
            const childHwnd = renderToWin32(child, hwnd, context)
            if (childHwnd) childHwnds.push(childHwnd)
        }
        vnode.__qw_children = childHwnds
        return hwnd
    }

    return null
}

function invokeComponent(component: QWComponent, vnode: FuncVNode<any>): ComponentChild {
    options._diff?.(vnode)
    options._render?.(vnode)
    try {
        return vnode.type(component.props, component.context)
    } catch (e: unknown) {
        const errHandler = component._errorHandler
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

function renderComponent(vnode: FuncVNode<any>, parentHwnd: HWND, context: any): HWND | null {
    const rendered = invokeComponent(newComponent(vnode, parentHwnd, context), vnode)
    if (rendered == null) return null
    const resultHwnd = renderToWin32(rendered, parentHwnd, context)
    setHwndRef(vnode, resultHwnd)
    vnode.__qw_rendered = rendered
    vnode.__qw_style = vnode.props?.style ?? (isVNode(rendered) ? rendered.__qw_style : undefined) ?? {}
    return resultHwnd
}

function newComponent(vnode: FuncVNode<any>, parentHwnd: HWND, context: any): QWComponent {
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
    vnode._component = component
    return component
}

function destroyHwnd(hwnd: HWND): void {
    if (!hwnd) return
    gui.UnsetWindowProc(hwnd)
    destroyWindow(hwnd)
}

function destroyVNode(vnode: QWVNode): void {
    options.unmount?.(vnode)

    if (vnode.__qw_hwnd) destroyHwnd(vnode.__qw_hwnd)
    const ref = vnode.ref as RefCallback | { current: unknown } | null
    if (ref) {
        if (typeof ref === 'function') {
            ref(null)
        } else {
            ref.current = null
        }
    }
    vnode.__qw_hwnd = null

    for (const child of getChildren(vnode)) {
        if (isVNode(child)) destroyVNode(child)
    }

    if (vnode.__qw_children) {
        for (const h of vnode.__qw_children) destroyHwnd(h)
    }
    vnode.__qw_children = []
}

function reconcile(
    oldVNode: unknown,
    newVNode: unknown,
    parentHwnd: HWND,
    context: any
): HWND | null {
    if (oldVNode == null || oldVNode === false || oldVNode === true) {
        return renderToWin32(newVNode, parentHwnd, context)
    }
    if (newVNode == null || newVNode === false || newVNode === true) {
        if (isVNode(oldVNode)) destroyVNode(oldVNode)
        return null
    }
    if (typeof oldVNode !== typeof newVNode ||
        typeof oldVNode === 'string' || typeof oldVNode === 'number' ||
        Array.isArray(oldVNode) || Array.isArray(newVNode)) {
        if (isVNode(oldVNode)) destroyVNode(oldVNode)
        return renderToWin32(newVNode, parentHwnd, context)
    }
    if (!isVNode(oldVNode) || !isVNode(newVNode)) {
        return renderToWin32(newVNode, parentHwnd, context)
    }

    const o = oldVNode
    const n = newVNode

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
        n._component = comp

        const oldResult = o.__qw_rendered
        const newResult = invokeComponent(comp, n)

        let resultHwnd: HWND | null
        if (newResult != null) {
            resultHwnd = reconcile(oldResult || null, newResult, parentHwnd, context)
        } else {
            if (oldResult && isVNode(oldResult)) destroyVNode(oldResult)
            resultHwnd = null
        }
        setHwndRef(n, resultHwnd)
        n.__qw_rendered = newResult
        n.__qw_style = n.props?.style ?? (isVNode(newResult) ? newResult.__qw_style : undefined) ?? {}
        return resultHwnd
    }

    if (o.type === 'w' && n.type === 'w') {
        const oldCtrl = o.props?.type || ''
        const newCtrl = n.props?.type || ''
        if (oldCtrl === newCtrl) {
            const hwnd = o.__qw_hwnd
            if (hwnd) {
                setHwndRef(n, hwnd)
                n.__qw_style = n.props?.style ?? {}
                n._oldProc = o._oldProc
                applyProps(hwnd, n.props || {}, n)

                const oldChildren = getChildren(o)
                const newChildren = getChildren(n)
                const oldChildHwnds = o.__qw_children
                const childHwnds: HWND[] = []
                const maxLen = Math.max(oldChildren.length, newChildren.length)
                for (let i = 0; i < maxLen; i++) {
                    const oc = oldChildren[i]
                    const nc = newChildren[i]
                    if (oc != null && oc !== false && oc !== true) {
                        if (nc != null && nc !== false && nc !== true) {
                            if (typeof oc === 'string' && typeof nc === 'string') {
                                if (oc !== nc && oldChildHwnds && oldChildHwnds[i]) {
                                    applyProps(oldChildHwnds[i], { text: nc })
                                }
                                if (oldChildHwnds && oldChildHwnds[i])
                                    childHwnds.push(oldChildHwnds[i])
                            } else {
                                const ch = reconcile(oc, nc, hwnd, context)
                                if (ch) childHwnds.push(ch)
                            }
                        } else {
                            if (isVNode(oc)) destroyVNode(oc)
                            else if (oldChildHwnds && oldChildHwnds[i])
                                destroyHwnd(oldChildHwnds[i])
                        }
                    } else if (nc != null && nc !== false && nc !== true) {
                        const ch = renderToWin32(nc, hwnd, context)
                        if (ch) childHwnds.push(ch)
                    }
                }
                n.__qw_children = childHwnds
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

        const vnode = component._vnode!
        const parentHwnd = component._qw_parent_hwnd
        if (!parentHwnd) return
        if (typeof vnode.type !== 'function') return

        const oldRendered = vnode.__qw_rendered
        const rendered = invokeComponent(component, vnode)

        if (rendered != null) {
            reconcile(oldRendered || null, rendered, parentHwnd, component.context)
        } else if (oldRendered) {
            if (isVNode(oldRendered)) destroyVNode(oldRendered)
        }
        vnode.__qw_rendered = rendered

        const commitQueue: Component[] = [component]
        options._commit?.(vnode, commitQueue)

        if (rootHwnd && rootVNode) {
            doLayout(rootHwnd, rootVNode)
        }
    }, 0)
}

export function notifyResize(hwnd: HWND): void {
    if (rootVNode) doLayout(hwnd, rootVNode)
}

export function render(vnode: any, containerHwnd: HWND): HWND {
    rootHwnd = containerHwnd
    rootVNode = vnode

    renderToWin32(vnode, containerHwnd, {})

    if (vnode._component) {
        const commitQueue: Component[] = [vnode._component]
        options._commit?.(vnode, commitQueue)
    }

    doLayout(containerHwnd, vnode)
    return containerHwnd
}

export { HWND_PROP, STYLE_PROP, CHILDREN_HWNDS_PROP, RENDERED_VNODE_PROP, isVNode, getChildren, type QWVNode, type QWComponent }
// re-export as VNode for layout.ts compat
export type VNode = QWVNode
export { scaleFactor }
