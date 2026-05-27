/** @jsxImportSource .. */
import * as gui from 'gui'
import * as os from 'os'
import type { LayoutStyle } from '../layout.js'

export interface EditBoxProps {
    value?: string
    onChange?: (value: string) => void
    placeholder?: string
    password?: boolean
    multiline?: boolean
    readonly?: boolean
    number?: boolean
    disabled?: boolean
    visible?: boolean
    style?: LayoutStyle
    ws?: number
}

export function EditBox(props: EditBoxProps) {
    let editStyle = gui.EditStyle.LEFT | gui.WindowStyle.TABSTOP | gui.EditStyle.AUTOHSCROLL
    if (props.password) editStyle |= gui.EditStyle.PASSWORD
    if (props.multiline) {
        editStyle |= gui.EditStyle.MULTILINE | gui.EditStyle.AUTOVSCROLL | gui.WindowStyle.VSCROLL | gui.EditStyle.WANTRETURN
    }
    if (props.readonly) editStyle |= gui.EditStyle.READONLY
    if (props.number) editStyle |= gui.EditStyle.NUMBER
    const ws = props.ws !== undefined ? props.ws : 0

    const editRef = (hwnd: gui.HWND | null) => {
        if (hwnd && props.placeholder) {
            gui.SendMessage(hwnd, gui.EditMsg.SETCUEBANNER, 1, props.placeholder)
        }
    }

    return (
        <w type="EDIT"
            ref={editRef}
            text={props.value || ''}
            ws={editStyle | ws}
            style={props.style}
            disabled={props.disabled}
            visible={props.visible}
            onEvent={(e) => {
                if (e.msg === gui.WmMsg.KEYUP && props.onChange) {
                    os.setTimeout(() => {
                        props.onChange!(gui.GetWindowText(e.hwnd))
                    }, 0)
                }
            }} />
    )
}
