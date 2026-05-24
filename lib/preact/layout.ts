import * as ffi from 'ffi'
import * as win from 'win'
import * as gui from 'gui'
import { HWND_PROP, STYLE_PROP, CHILDREN_HWNDS_PROP, RENDERED_VNODE_PROP, isVNode, getChildren, type VNode } from './render.js'
import { moveWindow } from './props.js'

const scaleFactor = gui.GetScaleFactor()

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_S32 = ffi.FFI_TYPE_SINT32
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_U64 = ffi.FFI_TYPE_UINT64

const _user32 = win.LoadLibrary('user32.dll')
const GetClientRect_proc = _user32 ? win.GetProcAddress(_user32, 'GetClientRect') : 0

export interface LayoutStyle {
    flexDirection?: 'row' | 'column'
    justifyContent?: string
    alignItems?: string
    flexGrow?: number
    width?: number | string
    height?: number | string
    padding?: number
    margin?: number
    gap?: number
}

interface LayoutRect {
    x: number
    y: number
    w: number
    h: number
}

function getClientSize(hwnd: number): { w: number; h: number } {
    if (!GetClientRect_proc) return { w: 0, h: 0 }
    const rectBuf = new ArrayBuffer(16)
    const ok = ffi.ffiCall(GetClientRect_proc, [FFI_U64, FFI_PTR], [hwnd, rectBuf], FFI_U32) as number
    if (!ok) return { w: 0, h: 0 }
    const dv = new DataView(rectBuf)
    return { w: dv.getInt32(8, true), h: dv.getInt32(12, true) }
}

function resolveSize(val: number | string | undefined, available: number): number {
    if (val === undefined) return -1
    if (typeof val === 'number') return (val * scaleFactor) | 0
    if (typeof val === 'string' && val.endsWith('%')) {
        const pct = parseFloat(val)
        if (!isNaN(pct)) return (available * pct / 100) | 0
    }
    return -1
}

const DEFAULT_SIZES: Record<string, number> = {
    button: (24 * scaleFactor) | 0, edit: (24 * scaleFactor) | 0,
    static: (20 * scaleFactor) | 0, checkbox: (24 * scaleFactor) | 0,
    groupbox: (48 * scaleFactor) | 0, combobox: (200 * scaleFactor) | 0,
    listbox: (100 * scaleFactor) | 0, progressbar: (24 * scaleFactor) | 0,
}

function getDefaultChildSize(vnode: VNode): number {
    const ctrlType = typeof vnode.props === 'object' ? vnode.props?.type : undefined
    return DEFAULT_SIZES[ctrlType as string] ?? (30 * scaleFactor) | 0
}

function getLayoutChildren(vnode: VNode): { hwnd: number; style: LayoutStyle; vnode: VNode }[] {
    const result: { hwnd: number; style: LayoutStyle; vnode: VNode }[] = []
    if (vnode.type !== 'w') return result

    for (const child of getChildren(vnode)) {
        if (!isVNode(child)) continue
        const childHwnd = child[HWND_PROP] as number | undefined
        if (childHwnd) {
            result.push({ hwnd: childHwnd, style: (child[STYLE_PROP] as LayoutStyle) || {}, vnode: child })
        }
    }
    return result
}

function layoutNode(hwnd: number, vnode: VNode, availableRect: LayoutRect): void {
    if (!isVNode(vnode) || vnode.type !== 'w') return

    const style = (vnode[STYLE_PROP] as LayoutStyle) || {}
    const dir = style.flexDirection || 'column'
    const gap = ((style.gap || 0) * scaleFactor) | 0
    const padding = ((style.padding || 0) * scaleFactor) | 0
    const margin = ((style.margin || 0) * scaleFactor) | 0

    const fixedW = resolveSize(style.width, availableRect.w)
    const fixedH = resolveSize(style.height, availableRect.h)
    const nodeW = fixedW >= 0 ? fixedW : availableRect.w - margin * 2
    const nodeH = fixedH >= 0 ? fixedH : availableRect.h - margin * 2

    const nodeX = availableRect.x + margin
    const nodeY = availableRect.y + margin
    moveWindow(hwnd, nodeX, nodeY, nodeW, nodeH)

    const children = getLayoutChildren(vnode)
    if (children.length === 0) return

    const isRow = dir === 'row'
    const totalGap = gap * Math.max(0, children.length - 1)
    const mainSize = (isRow ? nodeW : nodeH) - padding * 2 - totalGap
    const crossSize = (isRow ? nodeH : nodeW) - padding * 2

    let totalFlex = 0
    let fixedMainTotal = 0
    for (const child of children) {
        const fg = child.style.flexGrow || 0
        const fixedMain = isRow
            ? resolveSize(child.style.width, mainSize)
            : resolveSize(child.style.height, mainSize)
        if (fg > 0) {
            totalFlex += fg
        } else if (fixedMain >= 0) {
            fixedMainTotal += fixedMain
        } else {
            fixedMainTotal += getDefaultChildSize(child.vnode)
        }
    }

    const flexUnit = totalFlex > 0 ? Math.max(0, mainSize - fixedMainTotal) / totalFlex : 0

    let offset = 0
    for (const child of children) {
        const fg = child.style.flexGrow || 0
        let childMain: number
        if (fg > 0) {
            childMain = (fg * flexUnit) | 0
        } else {
            const fixed = isRow
                ? resolveSize(child.style.width, mainSize)
                : resolveSize(child.style.height, mainSize)
            childMain = fixed >= 0 ? fixed : getDefaultChildSize(child.vnode)
        }

        const childCross = isRow
            ? resolveSize(child.style.height, crossSize)
            : resolveSize(child.style.width, crossSize)
        const actualCross = childCross >= 0 ? childCross : crossSize

        const childMargin = ((child.style.margin || 0) * scaleFactor) | 0
        const relX = isRow ? padding + offset : padding + childMargin
        const relY = isRow ? padding + childMargin : padding + offset
        const cw = isRow ? childMain : actualCross - childMargin * 2
        const ch = isRow ? actualCross - childMargin * 2 : childMain

        moveWindow(child.hwnd, relX, relY, Math.max(cw, 0), Math.max(ch, 0))

        if (isVNode(child.vnode) && child.vnode.type === 'w') {
            layoutNode(child.hwnd, child.vnode, { x: relX, y: relY, w: Math.max(cw, 0), h: Math.max(ch, 0) })
        }

        offset += childMain + gap
    }
}

function resolveToElementVNode(vnode: VNode): VNode | null {
    if (!isVNode(vnode)) return null
    if (vnode.type === 'w') return vnode
    if (typeof vnode.type === 'function') {
        const rendered = vnode[RENDERED_VNODE_PROP]
        if (rendered && isVNode(rendered)) {
            return resolveToElementVNode(rendered)
        }
    }
    return null
}

export function layout(rootHwnd: number, vnode: any): void {
    const clientSize = getClientSize(rootHwnd)
    if (clientSize.w <= 0 || clientSize.h <= 0) return

    const targetVNode = resolveToElementVNode(vnode)
    if (!targetVNode) return

    const targetHwnd = targetVNode[HWND_PROP] as number
    if (!targetHwnd) return

    moveWindow(targetHwnd, 0, 0, clientSize.w, clientSize.h)
    layoutNode(targetHwnd, targetVNode, { x: 0, y: 0, w: clientSize.w, h: clientSize.h })
}
