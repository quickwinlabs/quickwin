import { forwardRef, useRef, useEffect, useState, useImperativeHandle } from 'react'
import * as gui from 'gui'
import { WCHAR } from '../../ffi/bind.js'
import { I32 } from '../../ffi/scalar.js'
import type { WStyle } from '../jsx.d.ts'
import { LbMsg, LbnCode, ListBoxStyle, WindowStyle, WmMsg } from '../../../constants'

type ListBoxBaseProps = {
  items: string[]
  style?: WStyle
  disabled?: boolean
  sort?: boolean
  scrollToBottom?: boolean
}

/** 单选：选中值是一个索引（-1 = 无选中） */
export type SingleListBoxProps = ListBoxBaseProps & {
  multiple?: false
  selectedIndex?: number
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
}

/** 多选：LBS_EXTENDEDSEL（Ctrl 点选、Shift 连选、方向键扩展），选中值是一组索引 */
export type MultiListBoxProps = ListBoxBaseProps & {
  multiple: true
  selectedIndices?: number[]
  defaultSelectedIndices?: number[]
  onChange?: (indices: number[]) => void
}

/** 选中值形态由 multiple 判别：单选标量 / 多选数组 */
export type ListBoxProps = SingleListBoxProps | MultiListBoxProps

function initialSelection(props: ListBoxProps): number[] {
  if (props.multiple === true) return props.defaultSelectedIndices ?? []
  const i = props.defaultSelectedIndex ?? -1
  return i >= 0 ? [i] : []
}

/** 受控值归一成数组；undefined = 非受控 */
function controlledSelection(props: ListBoxProps): number[] | undefined {
  if (props.multiple === true) return props.selectedIndices
  const i = props.selectedIndex
  if (i === undefined) return undefined
  return i >= 0 ? [i] : []
}

function emitChange(props: ListBoxProps, indices: number[]): void {
  if (props.multiple === true) props.onChange?.(indices)
  else props.onChange?.(indices[0] ?? -1)
}

/** 读取选中项；LB_GETSELITEMS 只对多选列表有效，单选走 LB_GETCURSEL */
function readSelection(h: gui.HWND, multiple: boolean): number[] {
  if (!multiple) {
    const i = gui.SendMessage(h, LbMsg.GETCURSEL, 0, 0)
    return i >= 0 ? [i] : []
  }
  const n = gui.SendMessage(h, LbMsg.GETSELCOUNT, 0, 0)
  if (n <= 0) return []
  const buf = I32.alloc(n)
  const got = gui.SendMessage(h, LbMsg.GETSELITEMS, n, buf.ptr)
  const view = new Int32Array(buf)
  const out: number[] = []
  for (const v of view.subarray(0, Math.min(got, n))) out.push(v)
  return out
}

/** 覆盖式写入：LBS_EXTENDEDSEL 下 LB_SETCURSEL 无效，先 LB_SETSEL(FALSE, -1) 全清再逐个选中 */
function writeSelection(h: gui.HWND, multiple: boolean, indices: number[]): void {
  if (!multiple) {
    gui.SendMessage(h, LbMsg.SETCURSEL, indices[0] ?? -1, 0)
    return
  }
  gui.SendMessage(h, LbMsg.SETSEL, 0, -1)
  for (const i of indices) gui.SendMessage(h, LbMsg.SETSEL, 1, i)
}

function sameIndices(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export const ListBox = forwardRef<gui.HWND, ListBoxProps>((props, ref) => {
  const multiple = props.multiple === true
  const [internal, setInternal] = useState<number[]>(() => initialSelection(props))
  const controlledValue = controlledSelection(props)
  const controlled = controlledValue !== undefined
  const indices = controlledValue ?? internal
  // 数组每次渲染都是新引用：用串化后的键做 effect 依赖
  const indicesKey = indices.join(',')
  const lbRef = useRef<gui.HWND>(null)
  useImperativeHandle(ref, () => lbRef.current!)

  const lbWs = WindowStyle.VISIBLE | WindowStyle.BORDER | WindowStyle.VSCROLL
    | ListBoxStyle.HASSTRINGS | ListBoxStyle.NOTIFY | ListBoxStyle.NOINTEGRALHEIGHT
    | (multiple ? ListBoxStyle.EXTENDEDSEL : 0)
    | (props.sort ? ListBoxStyle.SORT : 0)

  useEffect(() => {
    const h = lbRef.current
    if (!h) return
    gui.SendMessage(h, LbMsg.RESETCONTENT, 0, 0)
    for (const item of props.items) {
      const w = WCHAR.encode(item)
      gui.SendMessage(h, LbMsg.ADDSTRING, 0, w.ptr)
    }
    writeSelection(h, multiple, indices.filter((i) => i >= 0 && i < props.items.length))
    if (props.scrollToBottom && props.items.length > 0)
      gui.SendMessage(h, LbMsg.SETTOPINDEX, props.items.length - 1, 0)
  }, [props.items])

  useEffect(() => {
    const h = lbRef.current
    if (!h) return
    const target = indices.filter((i) => i >= 0 && i < props.items.length)
    // 用户操作后回写会打断 Shift 连选/锚点：与控件现状一致就不动
    if (!sameIndices(readSelection(h, multiple), target)) writeSelection(h, multiple, target)
  }, [multiple, indicesKey, props.items])

  return (
    <w
      type="STATIC"
      ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
      style={{ ...props.style, flexDirection: 'column', alignItems: 'stretch' }}
      onEvent={(e) => {
        if (e.msg !== WmMsg.COMMAND) return
        const code = (e.wParam >> 16) & 0xFFFF
        if (code !== LbnCode.SELCHANGE) return
        const h = lbRef.current
        if (!h) return
        const next = readSelection(h, multiple)
        if (sameIndices(next, indices)) return
        if (!controlled) setInternal(next)
        emitChange(props, next)
      }}
    >
      <w type="LISTBOX" ws={lbWs}
        style={{flexGrow:1}}
        ref={(h: gui.HWND) => {
          lbRef.current = h
        }}
      />
    </w>
  )
})
