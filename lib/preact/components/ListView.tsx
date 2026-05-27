/** @jsxImportSource .. */
import * as gui from 'gui'
import * as os from 'os'
import * as ffi from 'ffi'

const _prevKeys = new Map<number, string>()
const _colInserted = new Set<number>()

const LVCF_FMT = 0x0001
const LVCF_WIDTH = 0x0002
const LVCF_TEXT = 0x0004

const LVIF_TEXT = 0x0001
const LVIF_STATE = 0x0008

const LVCFMT_LEFT = 0x0000

const LVNI_SELECTED = 0x0002
const LVIS_SELECTED = 0x0002

export interface ListViewColumn {
    title: string
    width?: number
}

export interface ListViewProps {
    columns: ListViewColumn[]
    items: string[][]
    selectedIndex?: number
    defaultSelectedIndex?: number
    onChange?: (index: number) => void
    fullRowSelect?: boolean
    gridLines?: boolean
    style?: Record<string, any>
}

function makeUtf16Buffer(s: string): ArrayBuffer {
    const len = s.length
    const buf = new ArrayBuffer((len + 1) * 2)
    const view = new Uint16Array(buf)
    for (let i = 0; i < len; i++) view[i] = s.charCodeAt(i)
    return buf
}

function insertColumn(hwnd: gui.HWND, title: string, width: number, index: number) {
    const strBuf = makeUtf16Buffer(title)
    const colBuf = new ArrayBuffer(56)
    const u32 = new Uint32Array(colBuf)
    u32[0] = LVCF_FMT | LVCF_WIDTH | LVCF_TEXT
    u32[1] = LVCFMT_LEFT
    u32[2] = width
    const strPtr = ffi.bufferPtr(strBuf)
    u32[4] = (strPtr >>> 0)
    u32[5] = Math.floor(strPtr / 0x100000000)
    u32[6] = title.length + 1
    gui.SendMessage(hwnd, gui.LvMsg.INSERTCOLUMNW, index, ffi.bufferPtr(colBuf) as any)
}

function insertItem(hwnd: gui.HWND, text: string, rowIndex: number): number {
    const strBuf = makeUtf16Buffer(text)
    const itemBuf = new ArrayBuffer(56)
    const u32 = new Uint32Array(itemBuf)
    u32[0] = LVIF_TEXT
    u32[1] = rowIndex
    u32[2] = 0
    const strPtr = ffi.bufferPtr(strBuf)
    u32[6] = (strPtr >>> 0)
    u32[7] = Math.floor(strPtr / 0x100000000)
    u32[8] = text.length + 1
    return gui.SendMessage(hwnd, gui.LvMsg.INSERTITEMW, 0, ffi.bufferPtr(itemBuf) as any) as number
}

function setSubItemText(hwnd: gui.HWND, rowIndex: number, subItemIndex: number, text: string) {
    const strBuf = makeUtf16Buffer(text)
    const itemBuf = new ArrayBuffer(56)
    const u32 = new Uint32Array(itemBuf)
    u32[0] = LVIF_TEXT
    u32[1] = rowIndex
    u32[2] = subItemIndex
    const strPtr = ffi.bufferPtr(strBuf)
    u32[6] = (strPtr >>> 0)
    u32[7] = Math.floor(strPtr / 0x100000000)
    u32[8] = text.length + 1
    gui.SendMessage(hwnd, gui.LvMsg.SETITEMW, 0, ffi.bufferPtr(itemBuf) as any)
}

function setSelectedItem(hwnd: gui.HWND, index: number) {
    const itemBuf = new ArrayBuffer(56)
    const u32 = new Uint32Array(itemBuf)
    u32[0] = LVIF_STATE
    u32[3] = LVIS_SELECTED
    u32[4] = LVIS_SELECTED
    gui.SendMessage(hwnd, gui.LvMsg.SETITEMSTATE, index, ffi.bufferPtr(itemBuf) as any)
}

function populateItems(hwnd: gui.HWND, items: string[][], selectedIndex: number) {
    gui.SendMessage(hwnd, gui.LvMsg.DELETEALLITEMS, 0, 0)
    for (let i = 0; i < items.length; i++) {
        const row = items[i]
        if (row.length > 0) {
            insertItem(hwnd, row[0], i)
            for (let j = 1; j < row.length; j++) {
                if (row[j] !== undefined) {
                    setSubItemText(hwnd, i, j, row[j])
                }
            }
        }
    }
    if (selectedIndex >= 0 && selectedIndex < items.length) {
        setSelectedItem(hwnd, selectedIndex)
        gui.SendMessage(hwnd, gui.LvMsg.ENSUREVISIBLE, selectedIndex, 0)
    }
}

export function ListView(props: ListViewProps) {
    const columns = props.columns || []
    const items = props.items || []
    const defaultWidth = 100

    let listStyle = gui.ListViewStyle.REPORT | gui.ListViewStyle.SINGLESEL | gui.ListViewStyle.SHOWSELALWAYS | gui.WindowStyle.VSCROLL | gui.WindowStyle.BORDER

    const listRef = (hwnd: gui.HWND | null) => {
        if (!hwnd) return

        if (!_colInserted.has(hwnd as number)) {
            _colInserted.add(hwnd as number)

            let exStyle = gui.LvExStyle.DOUBLEBUFFER
            if (props.fullRowSelect !== false) exStyle |= gui.LvExStyle.FULLROWSELECT
            if (props.gridLines) exStyle |= gui.LvExStyle.GRIDLINES
            gui.SendMessage(hwnd, gui.LvMsg.SETEXTENDEDLISTVIEWSTYLE, 0, exStyle)

            for (let i = 0; i < columns.length; i++) {
                insertColumn(hwnd, columns[i].title, columns[i].width ?? defaultWidth, i)
            }
        }

        const key = JSON.stringify(items)
        if (_prevKeys.get(hwnd as number) === key) return
        _prevKeys.set(hwnd as number, key)

        const idx = props.selectedIndex !== undefined ? props.selectedIndex : (props.defaultSelectedIndex !== undefined ? props.defaultSelectedIndex : -1)
        populateItems(hwnd, items, idx)
    }

    const onChange = props.onChange

    return (
        <w type="SysListView32"
            ref={listRef}
            ws={listStyle}
            style={props.style}
            onEvent={(e) => {
                if (e.msg === gui.WmMsg.LBUTTONDOWN) {
                    os.setTimeout(() => {
                        if (!onChange) return
                        const sel = gui.SendMessage(e.hwnd as gui.HWND, gui.LvMsg.GETNEXTITEM, -1, LVNI_SELECTED) as number
                        if (sel >= 0) {
                            onChange(sel)
                        }
                    }, 0)
                }
            }} />
    )
}
