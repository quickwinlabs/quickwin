/** @jsxImportSource .. */
import * as gui from 'gui'
import type { LayoutStyle } from '../layout.js'

export interface ButtonProps {
    text?: string
    onClick?: () => void
    disabled?: boolean
    default?: boolean
    style?: LayoutStyle
}

export function Button(props: ButtonProps) {
    const btnStyle = gui.ButtonStyle.PUSHBUTTON | gui.WindowStyle.TABSTOP
    const ws = props.default ? btnStyle | gui.ButtonStyle.DEFPUSHBUTTON : btnStyle

    return (
        <w type="BUTTON"
            text={props.text || ''}
            ws={ws}
            style={props.style}
            disabled={props.disabled}
            onEvent={(e) => {
                if (e.msg === gui.WmMsg.LBUTTONDOWN) props.onClick?.()
            }} />
    )
}
