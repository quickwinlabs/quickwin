// Minimal Preact - VNode creation + Options
// Based on https://github.com/preactjs/preact (src/create-element.js, src/options.js, src/constants.js)
// DOM dependencies removed - for custom renderers only

let vnodeId = 0

export type Key = string | number | null

export type RefObject<T> = { current: T };
export type RefCallback<T> = (instance: T | null) => void | (() => void);
export type Ref<T> = RefCallback<T> | RefObject<T | null> | null;

export type ComponentChild = VNode<any> | string | number | boolean | null | undefined
export type ComponentChildren = ComponentChild[] | ComponentChild

export type FunctionComponent<P = {}> = {
    (props: P, context?: any): VNode<any> | null
    defaultProps?: Partial<P>
    displayName?: string
}

export type ComponentType<P = {}> = FunctionComponent<P>

export interface VNode<P = any> {
    type: string | ComponentType<P>
    props: P & { children?: ComponentChildren }
    key: Key
    ref?: Ref<any>
    _children: VNode[]
    _parent: VNode | null
    _depth: number
    _dom: unknown
    _component: Component<{}, {}> | null
    constructor: undefined
    _original: number
    _index: number
    _flags: number
    _mask?: number[]
}

export interface Component<P = {}, S = {}> {
    props: P
    context: Record<string, unknown>
    _vnode: VNode | null
    _renderCallbacks: Array<() => void>
    _parentDom: unknown
    __hooks: { _list: any[]; _pendingEffects: any[] } | null
    _forceUpdate(): void
}

export interface Options {
    vnode?(vnode: VNode): void
    _diff?(vnode: VNode): void
    _render?(vnode: VNode): void
    diffed?(vnode: VNode): void
    _commit?(vnode: VNode, commitQueue: Component[]): void
    unmount?(vnode: VNode): void
    _root?(vnode: VNode, parentDom: unknown): void
    _catchError?(error: unknown, vnode: VNode, oldVNode?: VNode): unknown
    debounceRendering?(cb: () => void): void
    requestAnimationFrame?: ((cb: () => void) => void) | null
    useDebugValue?(value: unknown): void
    _hook?(component: Component, index: number, type: number): void
    _skipEffects?: boolean
}

export const options: Options = {}

export function createElement<P extends Record<string, any> = {}>(
    type: string | ComponentType<P>,
    props: (P & { key?: Key; ref?: Ref<any> }) | null,
    ...children: ComponentChildren[]
): VNode<P> {
    let normalizedProps: Record<string, any> = {}
    let key: Key = null
    let ref: Ref<any> | null = null

    if (props != null) {
        for (const i in props) {
            if (i === 'key') key = props[i] ?? null
            else if (i === 'ref' && typeof type !== 'function') ref = props[i] ?? null
            else normalizedProps[i] = props[i]
        }
    }

    if (children.length > 0) {
        normalizedProps.children = children.length === 1 ? children[0] : children
    }

    return createVNode(type, normalizedProps as P, key, ref!, null)
}

export function createVNode<P = {}>(
    type: string | ComponentType<P>,
    props: P,
    key: Key,
    ref: Ref<any>,
    original: number | null
): VNode<P> {
    const vnode: VNode<P> = {
        type,
        props: props as VNode<P>['props'],
        key,
        ref,
        _children: [],
        _parent: null,
        _depth: 0,
        _dom: null,
        _component: null,
        constructor: undefined,
        _original: original == null ? ++vnodeId : original,
        _index: -1,
        _flags: 0,
    }

    if (original == null && options.vnode) options.vnode(vnode)

    return vnode
}

export function createRef<T = any>(): RefObject<T | null> {
    return { current: null }
}

export function Fragment<P extends { children?: ComponentChildren }>(props: P): ComponentChildren {
    return props.children
}

export function isValidElement(vnode: unknown): vnode is VNode {
    return vnode != null && (vnode as any).constructor === undefined
}

export const h = createElement
