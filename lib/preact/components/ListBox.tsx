/** @jsxImportSource .. */
import * as gui from 'gui'
import * as os from 'os'

export interface ListBoxProps {
    items: string[]
    selectedIndex?: number
    defaultSelectedIndex?: number
    onChange?: (index: number, text: string) => void
    onDoubleClick?: (index: number, text: string) => void
    sort?: boolean
    multiSelect?: boolean
    extendedSelect?: boolean
    disabled?: boolean
    visible?: boolean
    style?: Record<string, any>
    ws?: number
}

export function ListBox(props: ListBoxProps) {
    let listStyle = gui.ListBoxStyle.NOTIFY | gui.ListBoxStyle.HASSTRINGS | gui.ListBoxStyle.NOINTEGRALHEIGHT | gui.WindowStyle.VSCROLL | gui.WindowStyle.BORDER
    if (props.sort) listStyle |= gui.ListBoxStyle.SORT
    if (props.multiSelect) listStyle |= gui.ListBoxStyle.MULTIPLESEL
    if (props.extendedSelect) listStyle |= gui.ListBoxStyle.EXTENDEDSEL
    const ws = props.ws !== undefined ? props.ws : 0

    const listRef = (hwnd: gui.HWND) => {
        if (!hwnd) return
        const items = props.items || []
        for (const item of items) {
            gui.SendMessage(hwnd, gui.LbMsg.ADDSTRING, 0, item)
        }
        const idx = props.selectedIndex !== undefined ? props.selectedIndex : (props.defaultSelectedIndex !== undefined ? props.defaultSelectedIndex : -1)
        if (idx >= 0 && idx < items.length) {
            gui.SendMessage(hwnd, gui.LbMsg.SETCURSEL, idx, 0)
        }
    }

    const onChange = props.onChange
    const onDoubleClick = props.onDoubleClick

    return (
        <w type="LISTBOX"
            ref={listRef}
            ws={listStyle | ws}
            style={props.style}
            disabled={props.disabled}
            visible={props.visible}
            onEvent={(e) => {
                if (e.msg === gui.WmMsg.LBUTTONDOWN) {
                    os.setTimeout(() => {
                        if (!onChange) return
                        const sel = gui.SendMessage(e.hwnd as gui.HWND, gui.LbMsg.GETCURSEL, 0, 0) as number
                        if (sel >= 0) {
                            const text = (props.items || [])[sel]
                            if (text !== undefined) onChange(sel, text)
                        }
                    }, 0)
                }
                if (e.msg === gui.WmMsg.LBUTTONDBLCLK) {
                    os.setTimeout(() => {
                        if (!onDoubleClick) return
                        const sel = gui.SendMessage(e.hwnd as gui.HWND, gui.LbMsg.GETCURSEL, 0, 0) as number
                        if (sel >= 0) {
                            const text = (props.items || [])[sel]
                            if (text !== undefined) onDoubleClick(sel, text)
                        }
                    }, 0)
                }
            }} />
    )
}
