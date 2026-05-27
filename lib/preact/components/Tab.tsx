/** @jsxImportSource .. */
import * as gui from 'gui'
import * as os from 'os'
import * as ffi from 'ffi'
import * as win from 'win'
import { useState, useRef } from '../hooks.js'
import { moveWindow } from '../props.js'

const TCIF_TEXT = 0x0001
const TCM_ADJUSTRECT = 0x1328
const FFI_U64 = ffi.FFI_TYPE_UINT64
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_PTR = ffi.FFI_TYPE_POINTER

const _user32 = win.LoadLibrary('user32.dll')
const GetClientRect_proc = _user32 ? win.GetProcAddress(_user32, 'GetClientRect') : 0

export interface TabItem {
    title: string
    content: any
}

export interface TabProps {
    tabs: TabItem[]
    selectedIndex?: number
    defaultSelectedIndex?: number
    onChange?: (index: number) => void
    style?: Record<string, any>
}

function insertTabItem(hwnd: gui.HWND, title: string, index: number) {
    const strLen = title.length
    const strBuf = new ArrayBuffer((strLen + 1) * 2)
    const strView = new Uint16Array(strBuf)
    for (let i = 0; i < strLen; i++) {
        strView[i] = title.charCodeAt(i)
    }

    const itemBuf = new ArrayBuffer(40)
    const u32 = new Uint32Array(itemBuf)
    u32[0] = TCIF_TEXT
    const strPtr = ffi.bufferPtr(strBuf)
    u32[4] = (strPtr >>> 0)
    u32[5] = Math.floor(strPtr / 0x100000000)

    const itemPtr = ffi.bufferPtr(itemBuf)
    gui.SendMessage(hwnd, gui.TcMsg.INSERTITEMW, index, itemPtr as any)
}

function positionContent(tabHwnd: gui.HWND, contentHwnd: number): void {
    if (!tabHwnd || !contentHwnd || !GetClientRect_proc) return

    const rectBuf = new ArrayBuffer(16)
    const ok = ffi.ffiCall(GetClientRect_proc, [FFI_U64, FFI_PTR], [tabHwnd, rectBuf], FFI_U32) as number
    if (!ok) return

    const workBuf = new ArrayBuffer(16)
    new Uint8Array(workBuf).set(new Uint8Array(rectBuf))

    gui.SendMessage(tabHwnd, TCM_ADJUSTRECT, 0, ffi.bufferPtr(workBuf) as any)

    const dv = new DataView(workBuf)
    const left = dv.getInt32(0, true)
    const top = dv.getInt32(4, true)
    const right = dv.getInt32(8, true)
    const bottom = dv.getInt32(12, true)

    moveWindow(contentHwnd, left, top, Math.max(right - left, 0), Math.max(bottom - top, 0))
}

export function Tab(props: TabProps) {
    const [internalSel, setInternalSel] = useState(props.defaultSelectedIndex ?? 0)
    const sel = props.selectedIndex !== undefined ? props.selectedIndex : internalSel
    const onChange = props.onChange
    const currentTabs = props.tabs || []
    const contentRef = useRef<number>(0)

    const tabRef = (hwnd: gui.HWND) => {
        if (!hwnd) return
        gui.SendMessage(hwnd, gui.TcMsg.DELETEALLITEMS, 0, 0)
        for (let i = 0; i < currentTabs.length; i++) {
            const pos = gui.SendMessage(hwnd, gui.TcMsg.GETITEMCOUNT, 0, 0) as number
            insertTabItem(hwnd, currentTabs[i].title, pos)
        }
        if (sel >= 0 && sel < currentTabs.length) {
            gui.SendMessage(hwnd, gui.TcMsg.SETCURSEL, sel, 0)
        }
        os.setTimeout(() => {
            if (contentRef.current) positionContent(hwnd, contentRef.current)
        }, 0)
    }

    return (
        <w type="SysTabControl32"
            ref={tabRef}
            ws={gui.TabStyle.FOCUSNEVER}
            style={{ flex: 1, ...props.style } as any}
            onEvent={(e) => {
                if (e.msg === gui.WmMsg.SIZE) {
                    os.setTimeout(() => {
                        if (contentRef.current) positionContent(e.hwnd as gui.HWND, contentRef.current)
                    }, 0)
                }
                if (e.msg === gui.WmMsg.LBUTTONDOWN) {
                    os.setTimeout(() => {
                        const hwnd = e.hwnd as gui.HWND
                        const curSel = gui.SendMessage(hwnd, gui.TcMsg.GETCURSEL, 0, 0) as number
                        if (curSel >= 0 && curSel !== sel) {
                            setInternalSel(curSel)
                            onChange?.(curSel)
                            os.setTimeout(() => {
                                if (contentRef.current) positionContent(hwnd, contentRef.current)
                            }, 0)
                        }
                    }, 0)
                }
            }}>
            {typeof currentTabs[sel]?.content === 'string' || typeof currentTabs[sel]?.content === 'number'
                ? <w type="STATIC" ref={contentRef as any} text={String(currentTabs[sel]?.content)} />
                : <w type="STATIC" ref={contentRef as any}>{currentTabs[sel]?.content ?? null}</w>}
        </w>
    )
}
