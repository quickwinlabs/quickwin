import { forwardRef, useRef, useEffect, useState } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import type { WStyle } from '../jsx.d.ts'

export interface TreeNode<D = unknown> {
  key?: string
  label: string
  children?: TreeNode<D>[]
}

export interface TreeViewProps<D> {
  data: TreeNode<D>[]
  onSelect?: (node: TreeNode<D> | null) => void
  defaultSelectedKey?: string
  selectedKey?: string
  style?: WStyle
}

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

function bufPtr(buf: ArrayBuffer): number {
  return ffi.bufferPtr(buf)
}

function setPtr(dv: DataView, offset: number, ptr: number): void {
  dv.setUint32(offset, ptr & 0xFFFFFFFF, true)
  dv.setUint32(offset + 4, Math.floor(ptr / 0x100000000), true)
}

function buildTvItem(textPtr: number, cChildren: number): ArrayBuffer {
  let mask = gui.TvIfFlag.TEXT
  if (cChildren > 0) mask |= gui.TvIfFlag.CHILDREN
  const buf = new ArrayBuffer(56)
  const dv = new DataView(buf)
  dv.setUint32(0, mask, true)            // mask (offset 0)
  setPtr(dv, 8, 0)                       // hItem
  dv.setUint32(16, 0, true)              // state
  dv.setUint32(20, 0, true)              // stateMask
  setPtr(dv, 24, textPtr)                // pszText
  dv.setInt32(32, 260, true)             // cchTextMax
  dv.setInt32(36, 0, true)               // iImage
  dv.setInt32(40, 0, true)               // iSelectedImage
  dv.setInt32(44, cChildren, true)       // cChildren
  setPtr(dv, 48, 0)                      // lParam
  return buf
}

function buildTvInsertStruct(hParent: number, hInsertAfter: number, itemBuf: ArrayBuffer): ArrayBuffer {
  const buf = new ArrayBuffer(72)
  const dv = new DataView(buf)
  setPtr(dv, 0, hParent)                 // hParent (offset 0)
  setPtr(dv, 8, hInsertAfter)            // hInsertAfter (offset 8)
  const src = new DataView(itemBuf)
  for (let i = 0; i < 56; i += 4)
    dv.setUint32(16 + i, src.getUint32(i, true), true)
  return buf
}

function insertItems(
  hTree: gui.HWND, nodes: TreeNode[], parentHandle: number,
  hItemMap: Map<number, TreeNode>, keyMap: Map<string, number>
): void {
  for (const node of nodes) {
    const cChildren = node.children && node.children.length > 0 ? 1 : 0
    const textBuf = textToUtf16(node.label)
    const itemBuf = buildTvItem(bufPtr(textBuf), cChildren)
    const tvins = buildTvInsertStruct(parentHandle, gui.TvInsertAfter.ROOT, itemBuf)
    const hItem = gui.SendMessage(hTree, gui.TvMsg.INSERTITEMW, 0, bufPtr(tvins))
    hItemMap.set(hItem, node)
    if (node.key) keyMap.set(node.key, hItem)
    if (node.children && node.children.length > 0) {
      insertItems(hTree, node.children, hItem, hItemMap, keyMap)
      gui.SendMessage(hTree, gui.TvMsg.EXPAND, gui.TvExpandCmd.EXPAND, hItem)
    }
  }
}

function deleteAllItems(hTree: gui.HWND): void {
  const n = gui.SendMessage(hTree, gui.TvMsg.GETCOUNT, 0, 0)
  if (n > 0)
    gui.SendMessage(hTree, gui.TvMsg.DELETEITEM, 1, gui.TvInsertAfter.ROOT)
}

const TreeView = forwardRef(function TreeViewInner<D>(
  { data, onSelect, defaultSelectedKey, selectedKey: controlledKey, style }: TreeViewProps<D>,
  ref: React.Ref<gui.HWND>
) {
  const [internalKey, setInternalKey] = useState<string | null>(defaultSelectedKey ?? null)
  const isControlled = controlledKey !== undefined
  const selKey = isControlled ? controlledKey : internalKey
  const tvRef = useRef<gui.HWND>(null)
  const hItemMapRef = useRef<Map<number, TreeNode<D>>>(new Map())
  const keyMapRef = useRef<Map<string, number>>(new Map())
  const onChangeRef = useRef(onSelect)
  onChangeRef.current = onSelect

  const tvWs = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER | gui.WindowStyle.VSCROLL
    | gui.WindowStyle.TABSTOP
    | gui.TreeViewStyle.HASLINES
    | gui.TreeViewStyle.HASBUTTONS
    | gui.TreeViewStyle.LINESATROOT
    | gui.TreeViewStyle.SHOWSELALWAYS

  useEffect(() => {
    const h = tvRef.current
    if (!h) return
    deleteAllItems(h)
    hItemMapRef.current.clear()
    keyMapRef.current.clear()
    if (data && data.length > 0)
      insertItems(h, data, gui.TvInsertAfter.ROOT, hItemMapRef.current, keyMapRef.current)
  }, [data])

  useEffect(() => {
    const h = tvRef.current
    if (!h) return
    gui.SendMessage(h, gui.TvMsg.SETEXTENDEDSTYLE, 0, gui.TvExStyle.DOUBLEBUFFER)
  }, [])

  useEffect(() => {
    if (selKey == null) return
    const h = tvRef.current
    if (!h) return
    const hItem = keyMapRef.current.get(selKey)
    if (hItem !== undefined)
      gui.SendMessage(h, gui.TvMsg.SELECTITEM, gui.TvGnRelative.CARET, hItem)
  }, [selKey])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = readI32(e.lParam, 16)
          if (code === gui.TvNotifyCode.SELCHANGEDW) {
            const h = tvRef.current
            if (!h) return
            const hCaret =             gui.SendMessage(h, gui.TvMsg.GETNEXTITEM, gui.TvGnRelative.CARET, 0)
            const node = hItemMapRef.current.get(hCaret) ?? null
            const key = node?.key ?? null
            if (!isControlled) setInternalKey(key)
            onChangeRef.current?.(node)
          }
        }
      }}
    >
      <w type="SysTreeView32" ws={tvWs}
        style={{flexGrow:1}}
        ref={(h: gui.HWND) => { tvRef.current = h }}
      />
    </w>
  )
}) as <D = unknown>(
  props: TreeViewProps<D> & { ref?: React.Ref<gui.HWND> }
) => React.ReactElement

export { TreeView }
