import { forwardRef, useState, useRef } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import { bind, WCHAR } from '../../ffi/bind.js'
import { OPENFILENAMEW, BROWSEINFOW } from '../../win-common-structs.js'
import type { WStyle } from '../jsx.d.ts'

function makeBindings() {
  return {
    GetOpenFileNameW: bind('comdlg32.dll', 'GetOpenFileNameW', '<BYTE>ptr -> u32'),
    SHBrowseForFolderW: bind('shell32.dll', 'SHBrowseForFolderW', '<BYTE>ptr -> <>ptr'),
    SHGetPathFromIDListW: bind('shell32.dll', 'SHGetPathFromIDListW', '<>ptr <BYTE>ptr -> u32'),
    CoTaskMemFree: bind('ole32.dll', 'CoTaskMemFree', '<>ptr -> void'),
  }
}
type DllBindings = ReturnType<typeof makeBindings>

let _bindings: DllBindings | null = null

function ensureDlls(): DllBindings | null {
  if (_bindings) return _bindings
  try {
    _bindings = makeBindings()
  } catch {
    return null
  }
  return _bindings
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
  const dll = ensureDlls()
  if (!dll) return null

  const fileBuf = new ArrayBuffer(260 * 2)
  const filterWide = WCHAR.encode(filter)
  const titleWide = title ? WCHAR.encode(title) : null

  let flags = 0x1000 | 0x0800 | 0x0008
  if (multiple) flags |= 0x0200
  flags |= 0x80000

  const ofn = OPENFILENAMEW.encode({
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

  const ret = dll.GetOpenFileNameW(ofn)
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
  const dll = ensureDlls()
  if (!dll) return null

  const titleWide = title ? WCHAR.encode(title) : null

  const bi = BROWSEINFOW.encode({
    hwndOwner: owner,
    pidlRoot: 0,
    pszDisplayName: 0,
    lpszTitle: titleWide ? ffi.bufferPtr(titleWide) : 0,
    ulFlags: 0x00000041,
    lpfn: 0,
    lParam: 0,
    iImage: 0,
  })

  const pidl = dll.SHBrowseForFolderW(bi)
  if (!pidl) return null

  const pathBuf = new ArrayBuffer(260 * 2)
  const ok = dll.SHGetPathFromIDListW(pidl, pathBuf)
  dll.CoTaskMemFree(pidl)

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
