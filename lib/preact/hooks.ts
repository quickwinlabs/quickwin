// Minimal Preact Hooks
// Based on https://github.com/preactjs/preact (hooks/src/index.js)
// DOM dependencies removed - for custom renderers only

import { options, type VNode } from './preact.js'

const COMPONENT_FORCE = 1 << 2
const ObjectIs = Object.is

let currentIndex: number
let currentComponent: any
let previousComponent: any
let currentHook = 0
let afterPaintEffects: any[] = []

let oldBeforeDiff = options._diff
let oldBeforeRender = options._render
let oldAfterDiff = options.diffed
let oldCommit = options._commit
let oldBeforeUnmount = options.unmount
let oldRoot = options._root

const RAF_TIMEOUT = 35
let prevRaf: any

options._diff = (vnode: VNode) => {
    currentComponent = null
    if (oldBeforeDiff) oldBeforeDiff(vnode)
}

options._root = (vnode: VNode, parentDom: any) => {
    if (vnode && parentDom._children && parentDom._children._mask) {
        vnode._mask = parentDom._children._mask
    }
    if (oldRoot) oldRoot(vnode, parentDom)
}

options._render = (vnode: VNode) => {
    if (oldBeforeRender) oldBeforeRender(vnode)
    currentComponent = vnode._component
    currentIndex = 0
    const hooks = currentComponent.__hooks
    if (hooks) {
        if (previousComponent === currentComponent) {
            hooks._pendingEffects = []
            currentComponent._renderCallbacks = []
            hooks._list.some((hookItem: any) => {
                if (hookItem._nextValue) {
                    hookItem._value = hookItem._nextValue
                }
                hookItem._pendingArgs = hookItem._nextValue = undefined
            })
        } else {
            hooks._pendingEffects.some(invokeCleanup)
            hooks._pendingEffects.some(invokeEffect)
            hooks._pendingEffects = []
            currentIndex = 0
        }
    }
    previousComponent = currentComponent
}

options.diffed = (vnode: VNode) => {
    if (oldAfterDiff) oldAfterDiff(vnode)
    const c = vnode._component
    if (c && c.__hooks) {
        if (c.__hooks._pendingEffects.length) afterPaint(afterPaintEffects.push(c))
        c.__hooks._list.some((hookItem: any) => {
            if (hookItem._pendingArgs) {
                hookItem._args = hookItem._pendingArgs
            }
            hookItem._pendingArgs = undefined
        })
    }
    previousComponent = currentComponent = null
}

options._commit = (vnode: VNode, commitQueue: any[]) => {
    commitQueue.some((component: any) => {
        try {
            component._renderCallbacks.some(invokeCleanup)
            component._renderCallbacks = component._renderCallbacks.filter((cb: any) =>
                cb._value ? invokeEffect(cb) : true
            )
        } catch (e) {
            commitQueue.some((c: any) => {
                if (c._renderCallbacks) c._renderCallbacks = []
            })
            commitQueue = []
            if (options._catchError) options._catchError(e, component._vnode)
        }
    })
    if (oldCommit) oldCommit(vnode, commitQueue)
}

options.unmount = (vnode: VNode) => {
    if (oldBeforeUnmount) oldBeforeUnmount(vnode)
    const c = vnode._component
    if (c && c.__hooks) {
        let hasErrored: any
        c.__hooks._list.some((s: any) => {
            try {
                invokeCleanup(s)
            } catch (e) {
                hasErrored = e
            }
        })
        c.__hooks = null as any
        if (hasErrored && options._catchError) options._catchError(hasErrored, c._vnode!)
    }
}

function getHookState(index: number, type: number): any {
    if (options._hook) {
        options._hook(currentComponent, index, currentHook || type)
    }
    currentHook = 0
    const hooks =
        currentComponent.__hooks ||
        (currentComponent.__hooks = {
            _list: [],
            _pendingEffects: []
        })
    if (index >= hooks._list.length) {
        hooks._list.push({})
    }
    return hooks._list[index]
}

export function useState<S>(initialState?: S | (() => S)): [S, (state: S | ((prevState: S) => S)) => void] {
    currentHook = 1
    return useReducer(invokeOrReturn, initialState as S)
}

export function useReducer<S, A>(
    reducer: (state: S, action: A) => S,
    initialState: S | (() => S),
    init?: (initialState: any) => S
): [S, (action: A) => void] {
    const hookState = getHookState(currentIndex++, 2)
    hookState._reducer = reducer
    if (!hookState._component) {
        hookState._value = [
            !init ? invokeOrReturn(undefined, initialState) : init(initialState),
            (action: A) => {
                const currentValue = hookState._nextValue
                    ? hookState._nextValue[0]
                    : hookState._value[0]
                const nextValue = hookState._reducer(currentValue, action)
                if (!ObjectIs(currentValue, nextValue)) {
                    hookState._nextValue = [nextValue, hookState._value[1]]
                    hookState._component.setState({})
                }
            }
        ]
        hookState._component = currentComponent
        if (!currentComponent._hasScuFromHooks) {
            currentComponent._hasScuFromHooks = true
            let prevScu = currentComponent.shouldComponentUpdate
            const prevCWU = currentComponent.componentWillUpdate
            currentComponent.componentWillUpdate = function (p: any, s: any, c: any) {
                if (this._bits & COMPONENT_FORCE) {
                    let tmp = prevScu
                    prevScu = undefined
                    updateHookState.call(this, p, s, c)
                    prevScu = tmp
                }
                if (prevCWU) prevCWU.call(this, p, s, c)
            }
            function updateHookState(this: any, p: any, s: any, c: any): boolean {
                if (!hookState._component.__hooks) return true
                const hooksList = hookState._component.__hooks._list
                let shouldUpdate =
                    hookState._component.props !== p ||
                    hooksList.every((x: any) => !x._nextValue)
                hooksList.some((hookItem: any) => {
                    if (hookItem._nextValue) {
                        const currentValue = hookItem._value[0]
                        hookItem._value = hookItem._nextValue
                        hookItem._nextValue = undefined
                        if (!ObjectIs(currentValue, hookItem._value[0]))
                            shouldUpdate = true
                    }
                })
                return prevScu
                    ? prevScu.call(this, p, s, c) || shouldUpdate
                    : shouldUpdate
            }
            currentComponent.shouldComponentUpdate = updateHookState
        }
    }
    return hookState._value
}

export function useEffect(callback: () => void | (() => void), args?: any[]): void {
    const state = getHookState(currentIndex++, 3)
    if (!options._skipEffects && argsChanged(state._args, args)) {
        state._value = callback
        state._pendingArgs = args
        currentComponent.__hooks._pendingEffects.push(state)
    }
}

export function useLayoutEffect(callback: () => void | (() => void), args?: any[]): void {
    const state = getHookState(currentIndex++, 4)
    if (!options._skipEffects && argsChanged(state._args, args)) {
        state._value = callback
        state._pendingArgs = args
        currentComponent._renderCallbacks.push(state)
    }
}

export function useRef<T>(initialValue: T): { current: T } {
    currentHook = 5
    return useMemo(() => ({ current: initialValue }), [])
}

export function useImperativeHandle<T>(
    ref: any,
    createHandle: () => T,
    args?: any[]
): void {
    currentHook = 6
    useLayoutEffect(
        () => {
            if (typeof ref === 'function') {
                const result = ref(createHandle())
                return () => {
                    ref(null)
                    if (result && typeof result === 'function') result()
                }
            } else if (ref) {
                ref.current = createHandle()
                return () => { ref.current = null }
            }
        },
        args == null ? args : args.concat(ref)
    )
}

export function useMemo<T>(factory: () => T, args: any[]): T {
    const state = getHookState(currentIndex++, 7)
    if (argsChanged(state._args, args)) {
        state._value = factory()
        state._args = args
        state._factory = factory
    }
    return state._value
}

export function useCallback<T extends (...args: any[]) => any>(callback: T, args: any[]): T {
    currentHook = 8
    return useMemo(() => callback, args)
}

export function useContext<T>(context: any): T {
    const provider = currentComponent.context[context._id]
    const state = getHookState(currentIndex++, 9)
    state._context = context
    if (!provider) return context._defaultValue
    if (state._value == null) {
        state._value = true
        provider.sub(currentComponent)
    }
    return provider.props.value
}

export function useDebugValue<T>(value: T, formatter?: (value: T) => any): void {
    if (options.useDebugValue) {
        options.useDebugValue(formatter ? formatter(value) : value)
    }
}

export function useErrorBoundary(cb?: (error: any) => void): [any, () => void] {
    const state = getHookState(currentIndex++, 10)
    const errState = useState<any>()
    state._value = cb
    if (!(currentComponent as any).componentDidCatch) {
        (currentComponent as any).componentDidCatch = (err: any, errorInfo: any) => {
            if (state._value) state._value(err, errorInfo)
            errState[1](err)
        }
    }
    return [errState[0], () => { errState[1](undefined) }]
}

export function useId(): string {
    const state = getHookState(currentIndex++, 11)
    if (!state._value) {
        let root: any = currentComponent._vnode
        while (root !== null && !root._mask && root._parent !== null) {
            root = root._parent
        }
        let mask = root._mask || (root._mask = [0, 0])
        state._value = 'P' + mask[0] + '-' + mask[1]++
    }
    return state._value
}

function flushAfterPaintEffects() {
    let component
    while ((component = afterPaintEffects.shift())) {
        const hooks = component.__hooks
        if (!component._parentDom || !hooks) continue
        try {
            hooks._pendingEffects.some(invokeCleanup)
            hooks._pendingEffects.some(invokeEffect)
            hooks._pendingEffects = []
        } catch (e) {
            hooks._pendingEffects = []
            if (options._catchError) options._catchError(e, component._vnode)
        }
    }
}

function afterNextFrame(callback: () => void) {
    setTimeout(callback, RAF_TIMEOUT)
}

function afterPaint(newQueueLength: number) {
    if (newQueueLength === 1 || prevRaf !== options.requestAnimationFrame) {
        prevRaf = options.requestAnimationFrame
        ;(prevRaf || afterNextFrame)(flushAfterPaintEffects)
    }
}

function invokeCleanup(hook: any) {
    const comp = currentComponent
    let cleanup = hook._cleanup
    if (typeof cleanup === 'function') {
        hook._cleanup = undefined
        cleanup()
    }
    currentComponent = comp
}

function invokeEffect(hook: any) {
    const comp = currentComponent
    hook._cleanup = hook._value()
    currentComponent = comp
}

function argsChanged(oldArgs: any[] | undefined, newArgs: any[] | undefined): boolean {
    return (
        !oldArgs ||
        oldArgs.length !== newArgs!.length ||
        newArgs!.some((arg, index) => !ObjectIs(arg, oldArgs[index]))
    )
}

function invokeOrReturn<S>(arg: S, f: S | ((arg: S) => S)): S {
    return typeof f === 'function' ? (f as (arg: S) => S)(arg) : f
}
