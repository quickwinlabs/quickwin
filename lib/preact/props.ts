import * as gui from 'gui'
import * as ffi from 'ffi'
import * as win from 'win'

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_S32 = ffi.FFI_TYPE_SINT32
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_U64 = ffi.FFI_TYPE_UINT64

const _user32 = win.LoadLibrary('user32.dll')

const MoveWindow_proc = _user32 ? win.GetProcAddress(_user32, 'MoveWindow') : 0
const EnableWindow_proc = _user32 ? win.GetProcAddress(_user32, 'EnableWindow') : 0
const ShowWindow_proc = _user32 ? win.GetProcAddress(_user32, 'ShowWindow') : 0
const SendMessageW_proc = _user32 ? win.GetProcAddress(_user32, 'SendMessageW') : 0
const DestroyWindow_proc = _user32 ? win.GetProcAddress(_user32, 'DestroyWindow') : 0

const SW_HIDE = gui.ShowWindowCmd.HIDE
const SW_SHOW = gui.ShowWindowCmd.SHOW

const BM_GETCHECK = gui.ButtonMsg.GETCHECK
const BM_SETCHECK = gui.ButtonMsg.SETCHECK
const BST_CHECKED = gui.ButtonCheckState.CHECKED
const BST_UNCHECKED = gui.ButtonCheckState.UNCHECKED
const EM_SETCUEBANNER = gui.EditMsg.SETCUEBANNER
const EM_SETPASSWORDCHAR = gui.EditMsg.SETPASSWORDCHAR
const CB_ADDSTRING = gui.ComboBoxMsg.ADDSTRING
const LB_ADDSTRING = gui.LbMsg.ADDSTRING
const PBM_SETRANGE32 = gui.ProgressMsg.SETRANGE32
const PBM_SETPOS = gui.ProgressMsg.SETPOS

export interface WProps {
    type?: string
    text?: string
    value?: string
    disabled?: boolean
    visible?: boolean
    style?: Record<string, any>
    onEvent?: (e: Record<string, any>) => void
    placeholder?: string
    password?: boolean
    checked?: boolean
    items?: string[]
    max?: number
    children?: any
}

export function applyProps(hwnd: number, props: WProps, vnode?: Record<string, any>): void {
    if (props.text !== undefined) {
        gui.SetWindowText(hwnd as gui.HWND, props.text)
    }
    if (props.value !== undefined) {
        gui.SetWindowText(hwnd as gui.HWND, props.value)
    }
    if (props.disabled !== undefined && EnableWindow_proc) {
        ffi.ffiCall(EnableWindow_proc, [FFI_U64, FFI_U32] as const, [hwnd, props.disabled ? 0 : 1], FFI_U32)
    }
    if (props.visible !== undefined && ShowWindow_proc) {
        ffi.ffiCall(ShowWindow_proc, [FFI_U64, FFI_S32] as const, [hwnd, props.visible ? SW_SHOW : SW_HIDE], FFI_U32)
    }
    if (props.onEvent !== undefined && vnode) {
        const h = hwnd as unknown as gui.HWND
        const oldProc = vnode._oldProc || gui.GetWindowLongPtr(h, gui.Gwlp.WNDPROC)
        vnode._oldProc = oldProc
        gui.SetWindowProc(h, (hw, msg, wParam, lParam) => {
            const cb = vnode!.props?.onEvent
            if (cb) cb({ hwnd: hw as unknown as number, msg, wParam, lParam })
            return gui.CallWindowProc(oldProc as unknown as gui.WNDPROC, hw, msg, wParam, lParam)
        })
    }
    if (props.placeholder !== undefined && SendMessageW_proc) {
        ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_S32, FFI_U32, FFI_PTR] as const, [hwnd, EM_SETCUEBANNER, 0, strToWide(props.placeholder)], FFI_U64)
    }
    if (props.password !== undefined && SendMessageW_proc) {
        ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_U64, FFI_U64, FFI_U64] as const, [hwnd, EM_SETPASSWORDCHAR, props.password ? 42 : 0, 0], FFI_U64)
    }
    if (props.checked !== undefined && SendMessageW_proc) {
        ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_U64, FFI_U64, FFI_U64] as const, [hwnd, BM_SETCHECK, props.checked ? BST_CHECKED : BST_UNCHECKED, 0], FFI_U64)
    }
    if (props.items && SendMessageW_proc) {
        const msg = props.type === 'combobox' ? CB_ADDSTRING : LB_ADDSTRING
        for (const item of props.items) {
            ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_S32, FFI_U32, FFI_PTR] as const, [hwnd, msg, 0, strToWide(item)], FFI_U64)
        }
    }
    if (props.max !== undefined && SendMessageW_proc) {
        ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_U64, FFI_U64, FFI_U64] as const, [hwnd, PBM_SETRANGE32, 0, props.max], FFI_U64)
    }
    if (props.value !== undefined && props.type === 'progressbar' && SendMessageW_proc) {
        ffi.ffiCall(SendMessageW_proc, [FFI_U64, FFI_U64, FFI_U64, FFI_U64] as const, [hwnd, PBM_SETPOS, Number(props.value), 0], FFI_U64)
    }
}

const wideCache = new Map<string, ArrayBuffer>()
const MAX_WIDE_CACHE = 50

function strToWide(str: string): ArrayBuffer {
    const cached = wideCache.get(str)
    if (cached) return cached
    const buf = new ArrayBuffer((str.length + 1) * 2)
    const dv = new DataView(buf)
    for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true)
    if (wideCache.size >= MAX_WIDE_CACHE) {
        const key = wideCache.keys().next().value
        if (key !== undefined) wideCache.delete(key)
    }
    wideCache.set(str, buf)
    return buf
}

export function moveWindow(hwnd: number, x: number, y: number, w: number, h: number): void {
    if (!MoveWindow_proc) return
    ffi.ffiCall(MoveWindow_proc, [FFI_U64, FFI_S32, FFI_S32, FFI_S32, FFI_S32, FFI_U32] as const, [hwnd, x, y, w, h, 1], FFI_U32)
}

export function destroyWindow(hwnd: number): boolean {
    if (!DestroyWindow_proc) return false
    return !!ffi.ffiCall(DestroyWindow_proc, [FFI_U64] as const, [hwnd], FFI_U32)
}
