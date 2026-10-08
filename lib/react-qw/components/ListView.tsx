import { NULL, type Ptr, type PtrArrayBuffer } from '../../ffi/ctype.js'
import { forwardRef, useRef, useEffect, type ForwardedRef } from 'react'
import * as gui from 'gui'
import { LvItemFlag, LvItemState, LvColumnMask } from 'gui'
import * as ffi from 'ffi'
import { WCHAR } from '../../ffi/bind.js'
import { nmCode } from '../nmhdr.js'
import { LoadCursor, SetCursor, ScreenToClient, GetCursorPos } from '../../windows/user32.js'
import { CreateFontIndirect, DeleteObject, GetObject, SelectObject } from '../../windows/gdi32.js'
import {
  LOGFONTW, POINT, NMCUSTOMDRAW, NMLVCUSTOMDRAW, NMLISTVIEW,
  LVHITTESTINFO, LVITEMW, LVCOLUMNW,
} from '../../windows/structs.js'
import type { WStyle } from '../jsx.d.ts'

export function makeColorBlock(size: number, bgra: number): ArrayBuffer {
  const n = size * size
  const buf = new ArrayBuffer(n * 4)
  const b = new Uint8Array(buf)
  for (let i = 0; i < n; i++) {
    b[i * 4] = bgra & 0xFF
    b[i * 4 + 1] = (bgra >> 8) & 0xFF
    b[i * 4 + 2] = (bgra >> 16) & 0xFF
    b[i * 4 + 3] = 0xFF
  }
  return buf
}

// 自绘时要把颜色写回通知结构指向的原生内存；struct 的 decode 能读原生指针、encode 只写 ArrayBuffer，
// 所以这两处写入保留逐字节写（偏移由 struct 的 offsetOf 给出）。
function writeU32(ptr: number, offset: number, v: number): void {
  ffi.writeByte(ptr + offset, v & 0xFF)
  ffi.writeByte(ptr + offset + 1, (v >> 8) & 0xFF)
  ffi.writeByte(ptr + offset + 2, (v >> 16) & 0xFF)
  ffi.writeByte(ptr + offset + 3, (v >> 24) & 0xFF)
}


const LV_WS = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.WindowStyle.VSCROLL | gui.WindowStyle.HSCROLL
  | gui.ListViewStyle.REPORT | gui.ListViewStyle.SINGLESEL

const CD_CLRTEXT = NMLVCUSTOMDRAW.offsetOf('clrText')
const CD_CLRTEXTBK = NMLVCUSTOMDRAW.offsetOf('clrTextBk')

const fontCache = new Map<string, number>()

function getCellFont(hwnd: gui.HWND, style: CellStyle): number | null {
  const key = (style.bold ? 'b' : '') + (style.italic ? 'i' : '') + (style.underline ? 'u' : '')
  if (key === '') return null
  const cached = fontCache.get(key)
  if (cached !== undefined) return cached === 0 ? null : cached

  if (!hwnd) return null
  // 以控件当前字体为底（取不到则用 -13 高度的默认字体），再叠加粗 / 斜 / 下划线
  let base: Parameters<typeof CreateFontIndirect>[0] = { lfHeight: -13 }
  const cur = gui.SendMessage(hwnd, gui.WmMsg.GETFONT, 0, 0)
  if (cur) {
    const lf = LOGFONTW.alloc()
    if (!GetObject(cur, LOGFONTW.size, lf)) return null
    base = LOGFONTW.decode(lf)
  }
  const h = CreateFontIndirect({
    ...base,
    ...(style.bold ? { lfWeight: gui.FontWeight.BOLD } : {}),
    ...(style.italic ? { lfItalic: 1 } : {}),
    ...(style.underline ? { lfUnderline: 1 } : {}),
  })
  fontCache.set(key, h ? h : 0)
  return h ? h : null
}

function handleCustomDraw<D>(lParam: number, columns: Column<D>[], data: D[], hwnd: gui.HWND | null): number {
  const { dwDrawStage: stage } = NMCUSTOMDRAW.decode(lParam as Ptr<'NMCUSTOMDRAW'>)
  if (stage === gui.CustomDrawStage.PREPAINT) return gui.CustomDrawFlag.NOTIFYITEMDRAW
  if (stage === gui.CustomDrawStage.ITEMPREPAINT) return gui.CustomDrawFlag.NOTIFYSUBITEMDRAW
  if (stage === gui.CustomDrawStage.SUBITEMPREPAINT) {
    // 只有子项阶段才按 NMLVCUSTOMDRAW（更大的结构）读，前面的阶段只读了 NMCUSTOMDRAW 的前缀
    const cd = NMLVCUSTOMDRAW.decode(lParam as Ptr<'NMLVCUSTOMDRAW'>)
    const style = resolveCellStyle(columns, data, cd.dwItemSpec, cd.iSubItem)
    if (!style) return gui.CustomDrawFlag.DODEFAULT

    if (style.color !== undefined) writeU32(lParam, CD_CLRTEXT, style.color)
    if (style.background !== undefined) writeU32(lParam, CD_CLRTEXTBK, style.background)

    const hfont = getCellFont(hwnd!, style)
    if (hfont && cd.hdc) {
      SelectObject(cd.hdc, hfont)
      return gui.CustomDrawFlag.NEWFONT
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
  /** 图标像素数据数组，每个元素为 iconSize*iconSize*4 的 BGRA 像素 ArrayBuffer（色块/程序生成） */
  icons?: ArrayBuffer[]
  /** 图标尺寸，默认 32 */
  iconSize?: number
  /** 返回记录使用的图标在 icons 中的下标 */
  getIcon?: (record: D, index: number) => number
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

function makeLVItem(i: number, sub: number, text: string, image?: number): PtrArrayBuffer<any> & { __textBuf?: ArrayBuffer } {
  const textBuf = WCHAR.encode(text)
  const b: PtrArrayBuffer<any> & { __textBuf?: ArrayBuffer } = LVITEMW.encode({
    mask: LvItemFlag.TEXT | (image !== undefined ? LvItemFlag.IMAGE : 0),
    iItem: i,
    iSubItem: sub,
    state: 0,
    stateMask: 0,
    pszText: textBuf.ptr,
    cchTextMax: 0,
    iImage: image ?? 0,
    lParam: 0,
    iIndent: 0,
    iGroupId: 0,
    cColumns: 0,
    puColumns: 0,
    piColFmt: 0,
    iGroup: 0,
  })
  b.__textBuf = textBuf
  return b
}

const ListView = forwardRef(function ListViewInner<D extends object>(
  { columns, data, style, icons, iconSize, getIcon }: ListViewProps<D>,
  ref: ForwardedRef<gui.HWND>
) {
  const lvRef = useRef<gui.HWND>(null)
  const iconListRef = useRef<number>(0)

  useEffect(() => {
    const h = lvRef.current
    if (!h) return
    const il = iconListRef.current
    iconListRef.current = 0
    if (il) {
      gui.SendMessage(h, gui.LvMsg.SETIMAGELIST, gui.LvImageList.SMALL, 0)
      gui.ImageListDestroy(il)
    }
    if (!icons || icons.length === 0) return
    const size = iconSize ?? 32
    const img = gui.ImageListCreate(size, size, gui.ImageListFlag.COLOR32, icons.length, 1)
    if (!img) return
    for (const p of icons) {
      const hbm = gui.CreateBitmapFromPixels(size, size, p)
      if (hbm) {
        gui.ImageListAdd(img, hbm)
        DeleteObject(hbm)
      }
    }
    gui.SendMessage(h, gui.LvMsg.SETIMAGELIST, gui.LvImageList.SMALL, img)
    iconListRef.current = img
  }, [icons, iconSize])

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
      const titleBuf = WCHAR.encode(columns[j]!.name)
      const lvc: PtrArrayBuffer<any> & { __titleBuf?: ArrayBuffer } = LVCOLUMNW.encode({
        mask: LvColumnMask.TEXT | LvColumnMask.WIDTH | LvColumnMask.FORMAT,
        fmt: alignToFmt(columns[j]!.align),
        cx: columns[j]!.width ?? 100,
        pszText: titleBuf.ptr,
        cchTextMax: 0,
        iSubItem: j,
        iImage: 0,
        iOrder: 0,
        cxMin: 0,
        cxDefault: 0,
        cxIdeal: 0,
      })
      lvc.__titleBuf = titleBuf
      gui.SendMessage(h, gui.LvMsg.INSERTCOLUMNW, j, lvc.ptr)
    }
  }, [columns])

  useEffect(() => {
    const h = lvRef.current
    if (!h) return

    gui.SendMessage(h, gui.LvMsg.DELETEALLITEMS, 0, 0)
    const nCols = columns.length

    for (let i = 0; i < data.length; i++) {
      const record = data[i]!
      const img = getIcon ? getIcon(record, i) : undefined
      const itemBuf = makeLVItem(i, 0, cellText(record, columns[0]!, i), img)
      gui.SendMessage(h, gui.LvMsg.INSERTITEMW, 0, itemBuf.ptr)

      for (let j = 1; j < nCols; j++) {
        const subBuf = makeLVItem(i, j, cellText(record, columns[j]!, i))
        gui.SendMessage(h, gui.LvMsg.SETITEMW, 0, subBuf.ptr)
      }
    }

    for (let j = 0; j < columns.length; j++) {
      if (columns[j]!.width == null) {
        gui.SendMessage(h, gui.LvMsg.SETCOLUMNWIDTH, j, gui.LvColumnWidthCmd.AUTOSIZE_USEHEADER)
      }
    }
  }, [data, columns, getIcon])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = nmCode(e.lParam)
          if (code === gui.LvNotifyCode.CUSTOMDRAW) {
            return handleCustomDraw(e.lParam, columns, data, lvRef.current)
          }
          if (code === gui.LvNotifyCode.ITEMCHANGING) {
            const { uNewState, uOldState } = NMLISTVIEW.decode(e.lParam as Ptr<'NMLISTVIEW'>)
            if ((uNewState & LvItemState.SELECTED) !== (uOldState & LvItemState.SELECTED)) return 1
          }
          if (code === gui.LvNotifyCode.CLICK) {
            const { iItem, iSubItem } = NMLISTVIEW.decode(e.lParam as Ptr<'NMLISTVIEW'>)
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

          // GetCursorPos 出参写入初值 → ScreenToClient 就地更新 → decode 读回
          const pt = POINT.alloc()
          if (!GetCursorPos(pt.ptr)) return
          ScreenToClient(h, pt.ptr)
          const { x: sx, y: sy } = POINT.decode(pt)

          const hit = LVHITTESTINFO.encode({ pt: [sx, sy], iItem: -1, iSubItem: -1 })
          gui.SendMessage(h, gui.LvMsg.SUBITEMHITTEST, 0, hit.ptr)
          const { iItem, iSubItem } = LVHITTESTINFO.decode(hit)
          const style = resolveCellStyle(columns, data, iItem, iSubItem)
          if (!style || style.cursor === undefined) return
          const hc = LoadCursor(NULL, style.cursor)
          if (hc) {
            SetCursor(hc)
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
