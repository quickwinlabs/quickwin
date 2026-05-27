import type { VNode, ComponentChildren, Ref } from './preact.js'
import type { LayoutStyle } from './layout.js'
import type { HWND } from 'gui'

interface WEvent {
    hwnd: HWND
    msg: number
    wParam: number
    lParam: number
}

interface WIntrinsicProps {
    type?: string
    text?: string
    ref?: Ref<HWND>
    ws?: number
    disabled?: boolean
    visible?: boolean
    style?: LayoutStyle
    onEvent?: (e: WEvent) => void
    children?: ComponentChildren
}

declare global {
    namespace JSX {
        interface IntrinsicElements {
            w: WIntrinsicProps
        }
        interface Element extends VNode { }
    }
}

export { }
