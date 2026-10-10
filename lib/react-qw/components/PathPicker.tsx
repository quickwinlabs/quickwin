import { forwardRef, useState, useRef } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import { OPENFILENAMEW, BROWSEINFOW } from '../../windows/structs.js'
import { GetOpenFileName } from '../../windows/comdlg32.js'
import { SHBrowseForFolder, SHGetPathFromIDList } from '../../windows/shell32.js'
import { CoTaskMemFree } from '../../windows/ole32.js'
import type { WStyle } from '../jsx.d.ts'

function openFileDialog(
  owner: gui.HWND,
  filter: string,
  title: string | undefined,
  multiple: boolean,
): string | string[] | null {
  const fileBuf = WCHAR.alloc(260)
  const filterWide = WCHAR.encode(filter)
  const titleWide = title ? WCHAR.encode(title) : null

  let flags = 0x1000 | 0x0800 | 0x0008
  if (multiple) flags |= 0x0200
  flags |= 0x80000

  // 缺省字段跳过 = fresh buffer 上留 0
  const ofn = OPENFILENAMEW.encode({
    lStructSize: OPENFILENAMEW.size,
    hwndOwner: owner,
    lpstrFilter: filterWide.ptr,
    lpstrFile: fileBuf.ptr,
    nMaxFile: 260,
    lpstrTitle: titleWide?.ptr ?? 0,
    Flags: flags,
  })

  const ret = GetOpenFileName(ofn.ptr)
  if (!ret) return null

  if (!multiple) {
    return WCHAR.decode(fileBuf)
  }

  // 多选缓冲：dir\0 file1\0 file2\0 \0 —— 整缓冲一次解码按 NUL 拆分
  const strs = new TextDecoder('utf-16le').decode(new Uint8Array(fileBuf)).split('\0')
  const dir = strs[0] ?? ''
  const files = strs.slice(1).filter((f) => f.length > 0).map((f) => dir + '\\' + f)
  return files.length > 0 ? files : [dir]
}

function openFolderDialog(owner: gui.HWND, title: string | undefined): string | null {
  const titleWide = title ? WCHAR.encode(title) : null

  const bi = BROWSEINFOW.encode({
    hwndOwner: owner,
    lpszTitle: titleWide?.ptr ?? 0,
    ulFlags: 0x00000041,
  })

  const pidl = SHBrowseForFolder(bi.ptr)
  if (!pidl) return null

  const pathBuf = WCHAR.alloc(260)
  const ok = SHGetPathFromIDList(pidl, pathBuf)
  CoTaskMemFree(pidl)

  return ok ? WCHAR.decode(pathBuf) : null
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
