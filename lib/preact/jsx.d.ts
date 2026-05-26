import type { VNode, ComponentChildren } from './preact.js'
import type { LayoutStyle } from './layout.js'

interface WEvent {
    hwnd: number
    msg: number
    wParam: number
    lParam: number
}

interface WIntrinsicProps {
    type?: string
    text?: string
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
        interface Element extends VNode {}
    }
}

export {}
