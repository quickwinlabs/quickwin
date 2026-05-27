import * as gui from 'gui'
import type { HWND, WNDPROC } from 'gui'
import * as ffi from 'ffi'
import * as win from 'win'
import type { LayoutStyle } from './layout.js'

const FFI_S32 = ffi.FFI_TYPE_SINT32
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_U64 = ffi.FFI_TYPE_UINT64

const _user32 = win.LoadLibrary('user32.dll')

const MoveWindow_proc = _user32 ? win.GetProcAddress(_user32, 'MoveWindow') : 0
const EnableWindow_proc = _user32 ? win.GetProcAddress(_user32, 'EnableWindow') : 0
const ShowWindow_proc = _user32 ? win.GetProcAddress(_user32, 'ShowWindow') : 0
const DestroyWindow_proc = _user32 ? win.GetProcAddress(_user32, 'DestroyWindow') : 0

const SW_HIDE = gui.ShowWindowCmd.HIDE
const SW_SHOW = gui.ShowWindowCmd.SHOW

export interface WProps {
    type?: string
    text?: string
    ws?: number
    disabled?: boolean
    visible?: boolean
    style?: LayoutStyle
    onEvent?: (e: Record<string, any>) => void
    children?: any
}

export function applyProps(hwnd: HWND, props: WProps, vnode?: Record<string, any>): void {
    if (props.text !== undefined) {
        gui.SetWindowText(hwnd, props.text)
    }
    if (props.disabled !== undefined && EnableWindow_proc) {
        ffi.ffiCall(EnableWindow_proc, [FFI_U64, FFI_U32] as const, [hwnd, props.disabled ? 0 : 1], FFI_U32)
    }
    if (props.visible !== undefined && ShowWindow_proc) {
        ffi.ffiCall(ShowWindow_proc, [FFI_U64, FFI_S32] as const, [hwnd, props.visible ? SW_SHOW : SW_HIDE], FFI_U32)
    }
    if (props.onEvent !== undefined && vnode) {
        const h = hwnd
        const oldProc = vnode._oldProc || gui.GetWindowLongPtr(h, gui.Gwlp.WNDPROC)
        vnode._oldProc = oldProc
        gui.SetWindowProc(h, (hw, msg, wParam, lParam) => {
            const cb = vnode!.props?.onEvent
            if (cb) cb({ hwnd: hw, msg, wParam, lParam })
            return gui.CallWindowProc(oldProc as unknown as WNDPROC, hw, msg, wParam, lParam)
        })
    }
}

export function moveWindow(hwnd: HWND, x: number, y: number, w: number, h: number): void {
    if (!MoveWindow_proc) return
    ffi.ffiCall(MoveWindow_proc, [FFI_U64, FFI_S32, FFI_S32, FFI_S32, FFI_S32, FFI_U32] as const, [hwnd, x, y, w, h, 1], FFI_U32)
}

export function destroyWindow(hwnd: HWND): boolean {
    if (!DestroyWindow_proc) return false
    return !!ffi.ffiCall(DestroyWindow_proc, [FFI_U64] as const, [hwnd], FFI_U32)
}
