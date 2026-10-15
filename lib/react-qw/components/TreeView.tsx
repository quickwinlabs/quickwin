import { forwardRef, useRef, useEffect, useState } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import { TVITEM, TVINSERTSTRUCT } from '../../windows/structs.js'
import { nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'
import { TreeViewStyle, TvExStyle, TvExpandCmd, TvGnRelative, TvIfFlag, TvInsertAfter, TvMsg, TvNotifyCode, WindowStyle, WmMsg } from '../../../constants'

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


function buildTvItem(textPtr: number, cChildren: number): ArrayBuffer {
    let mask = TvIfFlag.TEXT
    if (cChildren > 0) mask |= TvIfFlag.CHILDREN
    return TVITEM.encode({
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
    const textBuf = WCHAR.encode(node.label)
    const itemBuf = buildTvItem(textBuf.ptr, cChildren)
    const item = TVITEM.decode(itemBuf)
    const tvins = TVINSERTSTRUCT.encode({ hParent: parentHandle, hInsertAfter: TvInsertAfter.ROOT, item })
    const hItem = gui.SendMessage(hTree, TvMsg.INSERTITEMW, 0, tvins.ptr)
    hItemMap.set(hItem, node)
    if (node.key) keyMap.set(node.key, hItem)
    if (node.children && node.children.length > 0) {
      insertItems(hTree, node.children, hItem, hItemMap, keyMap)
      gui.SendMessage(hTree, TvMsg.EXPAND, TvExpandCmd.EXPAND, hItem)
    }
  }
}

function deleteAllItems(hTree: gui.HWND): void {
  const n = gui.SendMessage(hTree, TvMsg.GETCOUNT, 0, 0)
  if (n > 0)
    gui.SendMessage(hTree, TvMsg.DELETEITEM, 1, TvInsertAfter.ROOT)
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

  const tvWs = WindowStyle.VISIBLE | WindowStyle.BORDER | WindowStyle.VSCROLL
    | WindowStyle.TABSTOP
    | TreeViewStyle.HASLINES
    | TreeViewStyle.HASBUTTONS
    | TreeViewStyle.LINESATROOT
    | TreeViewStyle.SHOWSELALWAYS

  useEffect(() => {
    const h = tvRef.current
    if (!h) return
    deleteAllItems(h)
    hItemMapRef.current.clear()
    keyMapRef.current.clear()
    if (data && data.length > 0)
      insertItems(h, data, TvInsertAfter.ROOT, hItemMapRef.current, keyMapRef.current)
  }, [data])

  useEffect(() => {
    const h = tvRef.current
    if (!h) return
    gui.SendMessage(h, TvMsg.SETEXTENDEDSTYLE, 0, TvExStyle.DOUBLEBUFFER)
  }, [])

  useEffect(() => {
    if (selKey == null) return
    const h = tvRef.current
    if (!h) return
    const hItem = keyMapRef.current.get(selKey)
    if (hItem !== undefined)
      gui.SendMessage(h, TvMsg.SELECTITEM, TvGnRelative.CARET, hItem)
  }, [selKey])

  return (
    <w type="STATIC"
      ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === WmMsg.NOTIFY) {
          const code = nmCode(e.lParam)
          if (code === TvNotifyCode.SELCHANGEDW) {
            const h = tvRef.current
            if (!h) return
            const hCaret =             gui.SendMessage(h, TvMsg.GETNEXTITEM, TvGnRelative.CARET, 0)
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
