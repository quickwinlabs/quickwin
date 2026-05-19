import type { VNode, ComponentChildren } from './preact.js'
import type { QWEvent, WProps } from './props.js'
import type { LayoutStyle } from './layout.js'

interface WIntrinsicProps {
    type?: 'div' | 'button' | 'edit' | 'static' | 'checkbox' | 'groupbox' | 'combobox' | 'listbox' | 'progressbar'
    text?: string
    value?: string
    disabled?: boolean
    visible?: boolean
    style?: LayoutStyle
    onEvent?: (e: QWEvent) => void
    placeholder?: string
    password?: boolean
    checked?: boolean
    items?: string[]
    max?: number
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
