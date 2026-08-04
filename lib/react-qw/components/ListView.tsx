import { forwardRef, useRef, useEffect, type ForwardedRef } from 'react'
import * as gui from 'gui'
import { LvItemFlag, LvItemState, LvColumnMask } from 'gui'
import * as ffi from 'ffi'
import * as win from 'win'
import type { WStyle } from '../jsx.d.ts'

function textToUtf16(s: string): ArrayBuffer {
  const buf = new ArrayBuffer((s.length + 1) * 2)
  const dv = new DataView(buf)
  for (let i = 0; i < s.length; i++)
    dv.setUint16(i * 2, s.charCodeAt(i), true)
  return buf
}

function readI32(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24)
}

function readU32(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24) >>> 0
}

function readU64(ptr: number, offset: number): number {
  const lo = readU32(ptr, offset)
  const hi = readU32(ptr, offset + 4)
  return lo + hi * 0x100000000
}

function writeU32(ptr: number, offset: number, v: number): void {
  ffi.writeByte(ptr + offset, v & 0xFF)
  ffi.writeByte(ptr + offset + 1, (v >> 8) & 0xFF)
  ffi.writeByte(ptr + offset + 2, (v >> 16) & 0xFF)
  ffi.writeByte(ptr + offset + 3, (v >> 24) & 0xFF)
}

function bufPtr(buf: ArrayBuffer): number {
  return ffi.bufferPtr(buf)
}

const LV_WS = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.WindowStyle.VSCROLL | gui.WindowStyle.HSCROLL
  | gui.ListViewStyle.REPORT | gui.ListViewStyle.SINGLESEL

// x64 结构体偏移（NMHDR 为 24 字节）
const CD_STAGE = 24     // NMCUSTOMDRAW.dwDrawStage
const CD_HDC = 32       // NMCUSTOMDRAW.hdc
const CD_ITEM = 56      // NMCUSTOMDRAW.dwItemSpec（行索引）
const CD_CLRTEXT = 80   // NMLVCUSTOMDRAW.clrText
const CD_CLRTEXTBK = 84 // NMLVCUSTOMDRAW.clrTextBk
const CD_SUBITEM = 88   // NMLVCUSTOMDRAW.iSubItem
const NMIA_ITEM = 24    // NMITEMACTIVATE.iItem
const NMIA_SUBITEM = 28 // NMITEMACTIVATE.iSubItem
const NM_CODE = 16      // NMHDR.code

const fontCache = new Map<string, number>()

let gdi32: win.HMODULE | null = null
let createFontIndirectW: number | null = null
let selectObjectFn: number | null = null
let getObjectW: number | null = null

function ensureGdi(): void {
  if (gdi32 !== null) return
  gdi32 = win.LoadLibrary('gdi32.dll')
  if (!gdi32) return
  createFontIndirectW = win.GetProcAddress(gdi32, 'CreateFontIndirectW')
  selectObjectFn = win.GetProcAddress(gdi32, 'SelectObject')
  getObjectW = win.GetProcAddress(gdi32, 'GetObjectW')
}

let user32: win.HMODULE | null = null
let loadCursorW: number | null = null
let setCursorFn: number | null = null
let screenToClient: number | null = null

function ensureUser32(): void {
  if (user32 !== null) return
  user32 = win.LoadLibrary('user32.dll')
  if (!user32) return
  loadCursorW = win.GetProcAddress(user32, 'LoadCursorW')
  setCursorFn = win.GetProcAddress(user32, 'SetCursor')
  screenToClient = win.GetProcAddress(user32, 'ScreenToClient')
}

function getCellFont(hwnd: gui.HWND, style: CellStyle): number | null {
  const key = (style.bold ? 'b' : '') + (style.italic ? 'i' : '') + (style.underline ? 'u' : '')
  if (key === '') return null
  const cached = fontCache.get(key)
  if (cached !== undefined) return cached === 0 ? null : cached

  ensureGdi()
  if (!createFontIndirectW || !getObjectW || !hwnd) return null
  const lf = new ArrayBuffer(92)
  const dv = new DataView(lf)
  const cur = gui.SendMessage(hwnd, gui.WmMsg.GETFONT, 0, 0)
  if (cur) {
    const got = ffi.ffiCall(getObjectW, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_SINT32, ffi.FFI_TYPE_POINTER],
      [cur, 92, lf], ffi.FFI_TYPE_SINT32)
    if (!got) return null
  } else {
    dv.setInt32(0, -13, true)
  }
  if (style.bold) dv.setInt32(16, gui.FontWeight.BOLD, true)
  if (style.italic) dv.setUint8(20, 1)
  if (style.underline) dv.setUint8(21, 1)
  const h = ffi.ffiCall(createFontIndirectW, [ffi.FFI_TYPE_POINTER], [lf], ffi.FFI_TYPE_UINT64)
  fontCache.set(key, h === 0 ? 0 : h)
  return h === 0 ? null : h
}

function handleCustomDraw<D>(lParam: number, columns: Column<D>[], data: D[], hwnd: gui.HWND | null): number {
  const stage = readU32(lParam, CD_STAGE)
  if (stage === gui.CustomDrawStage.PREPAINT) return gui.CustomDrawFlag.NOTIFYITEMDRAW
  if (stage === gui.CustomDrawStage.ITEMPREPAINT) return gui.CustomDrawFlag.NOTIFYSUBITEMDRAW
  if (stage === gui.CustomDrawStage.SUBITEMPREPAINT) {
    const colIndex = readI32(lParam, CD_SUBITEM)
    const row = readI32(lParam, CD_ITEM)
    const style = resolveCellStyle(columns, data, row, colIndex)
    if (!style) return gui.CustomDrawFlag.DODEFAULT

    if (style.color !== undefined) writeU32(lParam, CD_CLRTEXT, style.color)
    if (style.background !== undefined) writeU32(lParam, CD_CLRTEXTBK, style.background)

    const hfont = getCellFont(hwnd!, style)
    if (hfont && selectObjectFn) {
      const hdc = readU64(lParam, CD_HDC)
      if (hdc) {
        ffi.ffiCall(selectObjectFn, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [hdc, hfont], ffi.FFI_TYPE_UINT64)
        return gui.CustomDrawFlag.NEWFONT
      }
    }
  }
  return gui.CustomDrawFlag.DODEFAULT
}

export type Align = 'left' | 'center' | 'right'

export interface CellStyle {
  color?: number
  background?: number
  bold?: boolean
  underline?: boolean
  italic?: boolean
  cursor?: gui.StandardCursor
}

export interface Column<D> {
  name: string
  dataIndex?: keyof D
  width?: number
  align?: Align
  render?: (record: D, index: number) => string
  cellStyle?: CellStyle | ((record: D, index: number) => CellStyle)
  onCellClick?: (record: D, index: number) => void
}

export interface ListViewProps<D extends object> {
  columns: Column<D>[]
  data: D[]
  style?: WStyle
}

function alignToFmt(align: Align | undefined): number {
  if (align === 'center') return gui.LvColumnFormat.CENTER
  if (align === 'right') return gui.LvColumnFormat.RIGHT
  return gui.LvColumnFormat.LEFT
}

function cellText<D>(record: D, col: Column<D>, index: number): string {
  if (col.render) return col.render(record, index)
  if (col.dataIndex === undefined) return ''
  const v = record[col.dataIndex!]
  return v == null ? '' : String(v)
}

function resolveCellStyle<D>(columns: Column<D>[], data: D[], row: number, colIndex: number): CellStyle | undefined {
  const col = columns[colIndex]
  if (!col || !col.cellStyle) return undefined
  const record = data[row]
  if (record === undefined) return undefined
  const style = typeof col.cellStyle === 'function' ? col.cellStyle(record, row) : col.cellStyle
  return style || undefined
}

function makeLVItem(i: number, sub: number, text: string): ArrayBuffer {
  const b = new ArrayBuffer(84)
  const dv = new DataView(b)
  dv.setInt32(4, i, true)
  dv.setInt32(8, sub, true)
  dv.setUint32(0, LvItemFlag.TEXT, true)
  dv.setBigUint64(24, BigInt(bufPtr(textToUtf16(text))), true)
  return b
}

const ListView = forwardRef(function ListViewInner<D extends object>(
  { columns, data, style }: ListViewProps<D>,
  ref: ForwardedRef<gui.HWND>
) {
  const lvRef = useRef<gui.HWND>(null)

  useEffect(() => {
    const h = lvRef.current
    if (!h) return

    // 从后往前删旧列
    const hdr = gui.SendMessage(h, gui.LvMsg.GETHEADER, 0, 0) as gui.HWND
    if (hdr) {
      let n = gui.SendMessage(hdr, gui.HdmMsg.GETITEMCOUNT, 0, 0)
      for (let k = n - 1; k >= 0; k--)
        gui.SendMessage(h, gui.LvMsg.DELETECOLUMN, k, 0)
    }

    gui.SendMessage(h, gui.LvMsg.SETEXTENDEDLISTVIEWSTYLE, 0,
      gui.LvExStyle.FULLROWSELECT | gui.LvExStyle.GRIDLINES | gui.LvExStyle.DOUBLEBUFFER)

    const n = columns.length
    for (let j = 0; j < n; j++) {
      const titleBuf = textToUtf16(columns[j]!.name)
      const lvc = new ArrayBuffer(52)
      const dv = new DataView(lvc)
      dv.setUint32(0, LvColumnMask.TEXT | LvColumnMask.WIDTH | LvColumnMask.FORMAT, true)
      dv.setInt32(4, alignToFmt(columns[j]!.align), true)
      dv.setInt32(8, columns[j]!.width ?? 100, true)
      dv.setBigUint64(16, BigInt(bufPtr(titleBuf)), true)
      dv.setInt32(28, j, true)
      gui.SendMessage(h, gui.LvMsg.INSERTCOLUMNW, j, bufPtr(lvc))
    }
  }, [columns])

  useEffect(() => {
    const h = lvRef.current
    if (!h) return

    gui.SendMessage(h, gui.LvMsg.DELETEALLITEMS, 0, 0)
    const nCols = columns.length

    for (let i = 0; i < data.length; i++) {
      const record = data[i]!
      gui.SendMessage(h, gui.LvMsg.INSERTITEMW, 0, bufPtr(makeLVItem(i, 0, cellText(record, columns[0]!, i))))

      for (let j = 1; j < nCols; j++) {
        gui.SendMessage(h, gui.LvMsg.SETITEMW, 0, bufPtr(makeLVItem(i, j, cellText(record, columns[j]!, i))))
      }
    }

    for (let j = 0; j < columns.length; j++) {
      if (columns[j]!.width == null) {
        gui.SendMessage(h, gui.LvMsg.SETCOLUMNWIDTH, j, gui.LvColumnWidthCmd.AUTOSIZE_USEHEADER)
      }
    }
  }, [data, columns])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = readI32(e.lParam, NM_CODE)
          if (code === gui.LvNotifyCode.CUSTOMDRAW) {
            return handleCustomDraw(e.lParam, columns, data, lvRef.current)
          }
          if (code === gui.LvNotifyCode.ITEMCHANGING) {
            const uNewState = readU32(e.lParam, 32)
            const uOldState = readU32(e.lParam, 36)
            if ((uNewState & LvItemState.SELECTED) !== (uOldState & LvItemState.SELECTED)) return 1
          }
          if (code === gui.LvNotifyCode.CLICK) {
            const iItem = readI32(e.lParam, NMIA_ITEM)
            const iSubItem = readI32(e.lParam, NMIA_SUBITEM)
            const col = columns[iSubItem]
            const record = data[iItem]
            if (col?.onCellClick && record !== undefined) col.onCellClick(record, iItem)
          }
        }
        return
      }}
    >
      <w type="SysListView32" ws={LV_WS}
        style={{flexGrow:1}}
        ref={(h: gui.HWND) => {
          lvRef.current = h
        }}
        onEvent={(e) => {
          if (e.msg !== gui.WmMsg.SETCURSOR) return
          if ((e.lParam & 0xFFFF) !== gui.HitTest.CLIENT) return
          const h = lvRef.current
          if (!h) return
          ensureUser32()
          if (!loadCursorW || !setCursorFn || !screenToClient) return

          const sp = gui.GetCursorPos()
          if (!sp) return
          const sbuf = new ArrayBuffer(8)
          const sdv = new DataView(sbuf)
          sdv.setInt32(0, sp[0], true)
          sdv.setInt32(4, sp[1], true)
          ffi.ffiCall(screenToClient, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_POINTER], [h, sbuf], ffi.FFI_TYPE_SINT32)

          const lvhi = new ArrayBuffer(24)
          const lvd = new DataView(lvhi)
          lvd.setInt32(0, sdv.getInt32(0, true), true)
          lvd.setInt32(4, sdv.getInt32(4, true), true)
          lvd.setInt32(12, -1, true)
          lvd.setInt32(16, -1, true)
          const lvhiPtr = bufPtr(lvhi)
          gui.SendMessage(h, gui.LvMsg.SUBITEMHITTEST, 0, lvhiPtr)
          const iItem = readI32(lvhiPtr, 12)
          const iSubItem = readI32(lvhiPtr, 16)
          const style = resolveCellStyle(columns, data, iItem, iSubItem)
          if (!style || style.cursor === undefined) return
          const hc = ffi.ffiCall(loadCursorW,
            [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [0, style.cursor], ffi.FFI_TYPE_UINT64)
          if (hc) {
            ffi.ffiCall(setCursorFn, [ffi.FFI_TYPE_UINT64], [hc], ffi.FFI_TYPE_UINT64)
            return 1
          }
          return
        }}
      />
    </w>
  )
}) as <D extends object>(
  props: ListViewProps<D> & { ref?: React.Ref<gui.HWND> }
) => React.ReactElement

export { ListView }
