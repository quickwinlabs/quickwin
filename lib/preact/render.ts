import '../polyfill.js'
import * as gui from 'gui'
import * as os from 'os'
import { applyProps, registerEventHandler, unregisterEventHandler, dispatchEvent, commandCodeToEventType, moveWindow, destroyWindow, type WProps, type QWEvent } from './props.js'
import { layout as doLayout, type LayoutStyle } from './layout.js'

const HWND_PROP = '__qw_hwnd'
const STYLE_PROP = '__qw_style'
const CHILDREN_HWNDS_PROP = '__qw_children'
const RENDERED_VNODE_PROP = '__qw_rendered'

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const SS_LEFT = 0x0000

const COMPONENT_DIRTY = 1 << 3

interface VNode {
    type: any
    props: any
    [key: string]: any
}

interface QWComponent {
    _vnode: VNode
    props: any
    state: any
    context: any
    __hooks: { _list: any[]; _pendingEffects: any[] }
    _renderCallbacks: any[]
    _bits: number
    _hasScuFromHooks: boolean
    _parentDom: any
    _qw_parent_hwnd: number
    setState(partial: any): void
    forceUpdate(): void
    shouldComponentUpdate?(...args: any[]): boolean
    componentWillUpdate?(...args: any[]): void
    componentDidCatch?(error: any, info: any): void
}

let rootHwnd: gui.HWND | null = null
let rootVNode: VNode | null = null
let classRegistered = false
let preactOptions: any = null

const commitQueue: any[] = []

const WIN32_CLASS: Record<string, string> = {
    button: 'BUTTON', edit: 'EDIT', static: 'STATIC',
    checkbox: 'BUTTON', groupbox: 'BUTTON', combobox: 'COMBOBOX',
    listbox: 'LISTBOX', progressbar: 'msctls_progress32', div: 'QwDiv',
}

const WIN32_STYLE: Record<string, number> = {
    button: 0x00000000,
    edit: 0x00800080,
    static: 0x0000,
    checkbox: 0x00000003,
    groupbox: 0x00000007,
    combobox: 0x0003,
    listbox: 0x00200001,
    progressbar: 0,
    div: 0,
}

function createControl(type: string, parentHwnd: number, props: WProps): number {
    const base = WS_CHILD | WS_VISIBLE
    const winClass = WIN32_CLASS[type] || 'STATIC'
    const style = base | (WIN32_STYLE[type] ?? SS_LEFT)
    const text = props.text || props.value || ''
    const hwnd = gui.CreateWindow(winClass, text, style, 0, 0, 0, 0, parentHwnd as gui.HWND, null)
    if (!hwnd) return 0
    applyProps(hwnd, props)
    return hwnd as number
}

function ensureDivClassRegistered(): void {
    if (classRegistered) return
    classRegistered = true
    gui.RegisterClass('QwDiv', (hwnd, msg, wParam, lParam) => {
        if (msg === gui.WmMsg.COMMAND && rootHwnd) {
            gui.SendMessage(rootHwnd, msg, wParam, lParam)
            return 0
        }
        return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    })
}

function isVNode(val: any): val is VNode {
    return val != null && typeof val === 'object' && val.constructor === undefined && val.type !== undefined
}

function getChildren(vnode: VNode): VNode[] {
    const children = vnode.props?.children
    if (children == null) return []
    if (Array.isArray(children)) return children.filter(c => c != null && c !== false && c !== true)
    if (typeof children === 'object' && (children as VNode).type !== undefined) return [children]
    return []
}

function renderToWin32(vnode: VNode | null | undefined | string | number | boolean, parentHwnd: number, context: any): number {
    if (vnode == null || vnode === false || vnode === true) return 0

    if (typeof vnode === 'string' || typeof vnode === 'number') {
        const hwnd = gui.CreateWindow('STATIC', String(vnode), WS_CHILD | WS_VISIBLE | SS_LEFT, 0, 0, 0, 0, parentHwnd as gui.HWND, null)
        return hwnd as number
    }

    if (Array.isArray(vnode)) {
        for (const child of vnode) renderToWin32(child, parentHwnd, context)
        return 0
    }

    if (!isVNode(vnode)) return 0

    const { type } = vnode
    if (type === undefined || vnode.constructor !== undefined) return 0

    if (typeof type === 'function') {
        return renderComponent(vnode, parentHwnd, context)
    }

    if (type === 'w') {
        ensureDivClassRegistered()
        const ctrlType = vnode.props?.type || 'div'
        const hwnd = createControl(ctrlType, parentHwnd, vnode.props || {})
        if (!hwnd) return 0

        vnode[HWND_PROP] = hwnd
        vnode[STYLE_PROP] = vnode.props?.style || {}

        const children = getChildren(vnode)
        const childHwnds: number[] = []
        for (const child of children) {
            const childHwnd = renderToWin32(child, hwnd, context)
            if (childHwnd) childHwnds.push(childHwnd)
        }
        vnode[CHILDREN_HWNDS_PROP] = childHwnds
        return hwnd
    }

    return 0
}

function promoteHookValues(component: QWComponent): void {
    if (!component.__hooks) return
    component.__hooks._list.some((hookItem: any) => {
        if (hookItem._nextValue) {
            hookItem._value = hookItem._nextValue
            hookItem._nextValue = undefined
        }
        hookItem._pendingArgs = undefined
    })
}

function invokeComponent(component: QWComponent, vnode: VNode): any {
    if (preactOptions?._diff) preactOptions._diff(vnode)
    promoteHookValues(component)
    if (preactOptions?._render) preactOptions._render(vnode)

    let rendered: any
    try {
        rendered = vnode.type.call(component, component.props, component.context)
    } catch (e) {
        console.log('[preact-render] render threw: ' + e)
        rendered = null
    }

    if (preactOptions?.diffed) preactOptions.diffed(vnode)
    return rendered
}

function renderComponent(vnode: VNode, parentHwnd: number, context: any): number {
    const component: QWComponent = {
        _vnode: vnode,
        props: vnode.props,
        state: {},
        context,
        __hooks: { _list: [], _pendingEffects: [] },
        _renderCallbacks: [],
        _bits: 0,
        _hasScuFromHooks: false,
        _parentDom: true,
        _qw_parent_hwnd: parentHwnd,
        setState(partial: any) {
            const newState = typeof partial === 'function' ? partial(this.state) : partial
            this.state = { ...this.state, ...newState }
            this._bits |= COMPONENT_DIRTY
            scheduleUpdate(this)
        },
        forceUpdate() {
            this._bits |= COMPONENT_DIRTY
            scheduleUpdate(this)
        },
    }

    vnode._component = component
    const rendered = invokeComponent(component, vnode)
    if (rendered == null) return 0

    const resultHwnd = renderToWin32(rendered, parentHwnd, context)
    vnode[HWND_PROP] = resultHwnd
    vnode[RENDERED_VNODE_PROP] = rendered
    return resultHwnd
}

function destroyHwnd(hwnd: number): void {
    if (!hwnd) return
    unregisterEventHandler(hwnd)
    gui.RemoveWindow(hwnd as gui.HWND)
    destroyWindow(hwnd)
}

function destroyVNode(vnode: VNode): void {
    if (preactOptions?.unmount) preactOptions.unmount(vnode)

    const hwnd = vnode[HWND_PROP]
    if (hwnd) destroyHwnd(hwnd)
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

function scheduleUpdate(component: QWComponent): void {
    if (!(component._bits & COMPONENT_DIRTY)) return
    os.setTimeout(() => {
        if (!(component._bits & COMPONENT_DIRTY)) return
        component._bits &= ~COMPONENT_DIRTY

        const vnode = component._vnode
        const parentHwnd = component._qw_parent_hwnd
        if (!parentHwnd) return

        const oldRendered = vnode[RENDERED_VNODE_PROP]
        if (oldRendered && isVNode(oldRendered)) destroyVNode(oldRendered)

        const rendered = invokeComponent(component, vnode)

        if (rendered != null) {
            renderToWin32(rendered, parentHwnd, component.context)
        }
        vnode[RENDERED_VNODE_PROP] = rendered

        commitQueue.length = 0
        commitQueue.push(component)
        if (preactOptions?._commit) preactOptions._commit(vnode, commitQueue)

        if (rootHwnd && rootVNode) {
            doLayout(rootHwnd as number, rootVNode)
        }
    }, 0)
}

function wndProc(hwnd: gui.HWND, msg: number, wParam: number, lParam: number): number {
    if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)

    switch (msg) {
        case gui.WmMsg.DESTROY:
            gui.PostQuitMessage(0)
            return 0

        case gui.WmMsg.COMMAND: {
            const ctrlHwnd = lParam
            if (ctrlHwnd) {
                const code = (wParam >> 16) & 0xFFFF
                dispatchEvent(ctrlHwnd, commandCodeToEventType(code, ctrlHwnd))
            }
            return 0
        }

        case gui.WmMsg.SIZE: {
            if (rootHwnd && rootVNode) {
                doLayout(rootHwnd as number, rootVNode)
            }
            return 0
        }

        default:
            return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    }
}

export function setPreactOptions(opts: any): void {
    preactOptions = opts
}

export function render(vnode: any, containerHwnd?: gui.HWND): gui.HWND {
    ensureDivClassRegistered()

    if (!containerHwnd) {
        gui.RegisterClass('PreactApp', wndProc)

        const screenW = 960, screenH = 720
        containerHwnd = gui.CreateWindow(
            'PreactApp', 'Preact App',
            gui.WindowStyle.OVERLAPPEDWINDOW,
            100, 100, screenW, screenH,
            null, null
        )
        if (!containerHwnd) {
            gui.MessageBox('Failed to create main window')
            return 0 as gui.HWND
        }

        const hFont = gui.CreateSystemDpiFont()
        if (hFont) {
            gui.SendMessage(containerHwnd, gui.WmMsg.SETFONT, hFont as number, 0)
        }
    }

    rootHwnd = containerHwnd
    rootVNode = vnode

    renderToWin32(vnode, containerHwnd as number, {})

    commitQueue.length = 0
    if (vnode._component) commitQueue.push(vnode._component)
    if (preactOptions?._commit) preactOptions._commit(vnode, commitQueue)

    doLayout(containerHwnd as number, vnode)

    gui.ShowWindow(containerHwnd)

    return containerHwnd
}

export { HWND_PROP, STYLE_PROP, CHILDREN_HWNDS_PROP, RENDERED_VNODE_PROP, isVNode, getChildren, type VNode, type QWComponent }
