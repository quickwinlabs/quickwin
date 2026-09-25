import { forwardRef, useRef, useEffect, useState } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import { struct } from '../../ffi-struct.js'
import { nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'

const TVITEM = struct({
    mask: 'u32',
    hItem: 'ptr',
    state: 'u32',
    stateMask: 'u32',
    pszText: 'ptr',
    cchTextMax: 'i32',
    iImage: 'i32',
    iSelectedImage: 'i32',
    cChildren: 'i32',
    lParam: 'ptr',
})
const TVINSERTSTRUCT = struct({ hParent: 'ptr', hInsertAfter: 'ptr', item: TVITEM })

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

function bufPtr(buf: ArrayBuffer): number {
  return ffi.bufferPtr(buf)
}

function buildTvItem(textPtr: number, cChildren: number): ArrayBuffer {
    let mask = gui.TvIfFlag.TEXT
    if (cChildren > 0) mask |= gui.TvIfFlag.CHILDREN
    return TVITEM.write({
        mask, hItem: 0, state: 0, stateMask: 0,
        pszText: textPtr, cchTextMax: 260,
        iImage: 0, iSelectedImage: 0, cChildren, lParam: 0,
    })
}

function insertItems(
  hTree: gui.HWND, nodes: TreeNode[], parentHandle: number,
  hItemMap: Map<number, TreeNode>, keyMap: Map<string, number>
): void {
  for (const node of nodes) {
    const cChildren = node.children && node.children.length > 0 ? 1 : 0
    const textBuf = textToUtf16(node.label)
    const itemBuf = buildTvItem(bufPtr(textBuf), cChildren)
    const item = TVITEM.read(itemBuf)
    const tvins = TVINSERTSTRUCT.write({ hParent: parentHandle, hInsertAfter: gui.TvInsertAfter.ROOT, item })
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
          const code = nmCode(e.lParam)
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
