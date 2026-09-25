import { forwardRef, useState, useRef } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import * as win from 'win'
import { OPENFILENAMEW, BROWSEINFOW } from '../../win-common-structs.js'
import type { WStyle } from '../jsx.d.ts'

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_U32 = ffi.FFI_TYPE_UINT32

let _GetOpenFileNameW = 0
let _SHBrowseForFolderW = 0
let _SHGetPathFromIDListW = 0
let _CoTaskMemFree = 0

function ensureDlls(): boolean {
  if (_GetOpenFileNameW) return true
  const comdlg32 = win.LoadLibrary('comdlg32.dll')
  const shell32 = win.LoadLibrary('shell32.dll')
  const ole32 = win.LoadLibrary('ole32.dll')
  if (!comdlg32 || !shell32 || !ole32) return false
  const load = (lib: win.HMODULE, name: string): number => win.GetProcAddress(lib, name) || 0
  _GetOpenFileNameW = load(comdlg32, 'GetOpenFileNameW')
  _SHBrowseForFolderW = load(shell32, 'SHBrowseForFolderW')
  _SHGetPathFromIDListW = load(shell32, 'SHGetPathFromIDListW')
  _CoTaskMemFree = load(ole32, 'CoTaskMemFree')
  return !!_GetOpenFileNameW && !!_SHBrowseForFolderW && !!_SHGetPathFromIDListW && !!_CoTaskMemFree
}

function strToWide(s: string): ArrayBuffer {
  return new TextEncoder('utf-16le').encode(s + '\0').buffer
}

const _decoder = new TextDecoder('utf-16le')

function wideToStr(buf: ArrayBuffer, offset = 0): string {
  const str = _decoder.decode(new Uint8Array(buf, offset))
  const nullIdx = str.indexOf('\0')
  return nullIdx >= 0 ? str.substring(0, nullIdx) : str
}

function openFileDialog(
  owner: gui.HWND,
  filter: string,
  title: string | undefined,
  multiple: boolean,
): string | string[] | null {
  if (!ensureDlls()) return null

  const fileBuf = new ArrayBuffer(260 * 2)
  const filterWide = strToWide(filter)
  const titleWide = title ? strToWide(title) : null

  let flags = 0x1000 | 0x0800 | 0x0008
  if (multiple) flags |= 0x0200
  flags |= 0x80000

  const ofn = OPENFILENAMEW.write({
    lStructSize: OPENFILENAMEW.size,
    hwndOwner: owner,
    hInstance: 0,
    lpstrFilter: ffi.bufferPtr(filterWide),
    lpstrCustomFilter: 0,
    nMaxCustFilter: 0,
    nFilterIndex: 0,
    lpstrFile: ffi.bufferPtr(fileBuf),
    nMaxFile: 260,
    lpstrFileTitle: 0,
    nMaxFileTitle: 0,
    lpstrInitialDir: 0,
    lpstrTitle: titleWide ? ffi.bufferPtr(titleWide) : 0,
    Flags: flags,
    nFileOffset: 0,
    nFileExtension: 0,
    lpstrDefExt: 0,
    lCustData: 0,
    lpfnHook: 0,
    lpTemplateName: 0,
    pvReserved: 0,
    dwReserved: 0,
    FlagsEx: 0,
  })

  const ret = ffi.ffiCall(_GetOpenFileNameW, [FFI_PTR], [ofn], FFI_U32)
  if (!ret) return null

  if (!multiple) {
    return wideToStr(fileBuf)
  }

  const dir = wideToStr(fileBuf)
  let pos = (dir.length + 1) * 2
  const files: string[] = []
  while (pos < fileBuf.byteLength) {
    const f = wideToStr(fileBuf, pos)
    if (f.length === 0) break
    files.push(dir + '\\' + f)
    pos += (f.length + 1) * 2
  }

  if (files.length === 0) return [dir]
  return files
}

function openFolderDialog(owner: gui.HWND, title: string | undefined): string | null {
  if (!ensureDlls()) return null

  const titleWide = title ? strToWide(title) : null

  const bi = BROWSEINFOW.write({
    hwndOwner: owner,
    pidlRoot: 0,
    pszDisplayName: 0,
    lpszTitle: titleWide ? ffi.bufferPtr(titleWide) : 0,
    ulFlags: 0x00000041,
    lpfn: 0,
    lParam: 0,
    iImage: 0,
  })

  const pidl = ffi.ffiCall(_SHBrowseForFolderW, [FFI_PTR], [bi], FFI_PTR)
  if (!pidl) return null

  const pathBuf = new ArrayBuffer(260 * 2)
  const ok = ffi.ffiCall(_SHGetPathFromIDListW, [ffi.FFI_TYPE_POINTER, FFI_PTR], [pidl, pathBuf], FFI_U32)
  ffi.ffiCall(_CoTaskMemFree, [ffi.FFI_TYPE_POINTER], [pidl], ffi.FFI_TYPE_VOID)

  return ok ? wideToStr(pathBuf) : null
}

interface PathPickerBase {
  type?: 'file' | 'folder'
  filter?: string
  title?: string
  placeholder?: string
  disabled?: boolean
  style?: WStyle
}

export type PathPickerProps = PathPickerBase & (
  | { multiple: true;  value?: string[]; defaultValue?: string[]; onChange?: (v: string[]) => void }
  | { multiple?: false; value?: string;  defaultValue?: string;  onChange?: (v: string) => void }
)

export const PathPicker = forwardRef<gui.HWND, PathPickerProps>(
  (props, ref) => {
    const { type = 'file', filter = 'All Files\0*.*\0\0', title, disabled, style } = props
    const multiple = props.multiple === true
    const controlledValue = props.value
    const defaultValue = props.defaultValue
    const onChange = props.onChange

    const [internalValue, setInternalValue] = useState<string | string[]>(
      defaultValue ?? (multiple ? [] : '')
    )
    const isControlled = controlledValue !== undefined
    const displayValue = isControlled ? controlledValue : internalValue

    const containerRef = useRef<gui.HWND>(null)

    const displayText = Array.isArray(displayValue) ? displayValue.join('\n') : (displayValue ?? '')

    const handleBrowse = () => {
      const owner = containerRef.current
      if (!owner) return

      let result: string | string[] | null
      if (type === 'folder') {
        const r = openFolderDialog(owner, title)
        result = r !== null ? (multiple ? [r] : r) : null
      } else {
        result = openFileDialog(owner, filter, title, multiple)
      }

      if (result === null) return

      if (!isControlled) setInternalValue(result)
      ;(onChange as ((v: string | string[]) => void) | undefined)?.(result)
    }

    return (
      <w
        type="STATIC"
        ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
        style={{ ...style, flexDirection: 'row', alignItems: 'stretch' }}
        ref={(h: gui.HWND) => {
          containerRef.current = h
          if (typeof ref === 'function') ref(h)
          else if (ref) ref.current = h
        }}
      >
        <w
          type="EDIT"
          text={displayText}
          ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.EditStyle.READONLY | gui.EditStyle.AUTOHSCROLL}
          style={{ flexGrow: 1 }}
        />
        <w
          type="BUTTON"
          text="..."
          ws={gui.WindowStyle.VISIBLE}
          style={{ width: 70 }}
          disabled={disabled}
          onEvent={(e) => {
            if (e.msg === gui.WmMsg.LBUTTONUP) handleBrowse()
          }}
        />
      </w>
    )
  }
)
