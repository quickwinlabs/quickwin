import * as gui from 'gui'
import type { HWND } from 'gui'
import * as ffi from 'ffi'
import { isVNode, getChildren, type VNode } from './render.js'
import { moveWindow } from './props.js'

const scaleFactor = gui.GetScaleFactor()
const TCM_ADJUSTRECT = 0x1328

export interface LayoutStyle {
    flexDirection?: 'row' | 'column'
    justifyContent?: string
    alignItems?: string
    flex?: number
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

function getClientSize(hwnd: HWND): { w: number; h: number } {
    const r = gui.GetClientRect(hwnd)
    if (!r) return { w: 0, h: 0 }
    return { w: r.right - r.left, h: r.bottom - r.top }
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

const DEFAULT_CHILD_SIZE = (30 * scaleFactor) | 0

function getLayoutChildren(vnode: VNode): { hwnd: HWND; style: LayoutStyle; vnode: VNode }[] {
    const result: { hwnd: HWND; style: LayoutStyle; vnode: VNode }[] = []
    if (vnode.type !== 'w') return result

    for (const child of getChildren(vnode)) {
        if (!isVNode(child)) continue
        const childHwnd = child.__qw_hwnd
        if (childHwnd) {
            result.push({ hwnd: childHwnd, style: child.__qw_style || {}, vnode: child })
        }
    }
    return result
}

function layoutNode(hwnd: HWND, vnode: VNode, availableRect: LayoutRect): void {
    if (!isVNode(vnode) || vnode.type !== 'w') return

    const style = vnode.__qw_style || {}
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

    let childOffX = 0, childOffY = 0
    let childAreaW = nodeW, childAreaH = nodeH
    if (vnode.props?.type === 'SysTabControl32') {
        const cr = gui.GetClientRect(hwnd)
        if (cr) {
            const buf = new ArrayBuffer(16)
            const dv = new DataView(buf)
            dv.setInt32(0, cr.left, true)
            dv.setInt32(4, cr.top, true)
            dv.setInt32(8, cr.right, true)
            dv.setInt32(12, cr.bottom, true)
            gui.SendMessage(hwnd, TCM_ADJUSTRECT, 0, ffi.bufferPtr(buf) as any)
            const l = dv.getInt32(0, true)
            const t = dv.getInt32(4, true)
            const r = dv.getInt32(8, true)
            const b = dv.getInt32(12, true)
            childOffX = l - cr.left
            childOffY = t - cr.top
            childAreaW = Math.max(r - l, 0)
            childAreaH = Math.max(b - t, 0)
        }
    }

    const children = getLayoutChildren(vnode)
    if (children.length === 0) return

    const isRow = dir === 'row'
    const totalGap = gap * Math.max(0, children.length - 1)
    const mainSize = (isRow ? childAreaW : childAreaH) - padding * 2 - totalGap
    const crossSize = (isRow ? childAreaH : childAreaW) - padding * 2

    function getFlexGrow(s: LayoutStyle): number {
        return s.flexGrow ?? s.flex ?? 0
    }

    let totalFlex = 0
    let fixedMainTotal = 0
    for (const child of children) {
        const fg = getFlexGrow(child.style)
        const fixedMain = isRow
            ? resolveSize(child.style.width, mainSize)
            : resolveSize(child.style.height, mainSize)
        if (fg > 0) {
            totalFlex += fg
        } else if (fixedMain >= 0) {
            fixedMainTotal += fixedMain
        } else {
            fixedMainTotal += DEFAULT_CHILD_SIZE
        }
    }

    const flexUnit = totalFlex > 0 ? Math.max(0, mainSize - fixedMainTotal) / totalFlex : 0

    let offset = 0
    for (const child of children) {
        const fg = getFlexGrow(child.style)
        let childMain: number
        if (fg > 0) {
            childMain = (fg * flexUnit) | 0
        } else {
            const fixed = isRow
                ? resolveSize(child.style.width, mainSize)
                : resolveSize(child.style.height, mainSize)
            childMain = fixed >= 0 ? fixed : DEFAULT_CHILD_SIZE
        }

        const childCross = isRow
            ? resolveSize(child.style.height, crossSize)
            : resolveSize(child.style.width, crossSize)
        const actualCross = childCross >= 0 ? childCross : crossSize

        const childMargin = ((child.style.margin || 0) * scaleFactor) | 0
        const relX = childOffX + (isRow ? padding + offset : padding + childMargin)
        const relY = childOffY + (isRow ? padding + childMargin : padding + offset)
        const cw = isRow ? childMain : actualCross - childMargin * 2
        const ch = isRow ? actualCross - childMargin * 2 : childMain

        moveWindow(child.hwnd, relX, relY, Math.max(cw, 0), Math.max(ch, 0))

        if (isVNode(child.vnode)) {
            const elementVNode = resolveToElementVNode(child.vnode)
            if (elementVNode) {
                layoutNode(child.hwnd, elementVNode, { x: relX, y: relY, w: Math.max(cw, 0), h: Math.max(ch, 0) })
            }
        }

        offset += childMain + gap
    }
}

function resolveToElementVNode(vnode: VNode): VNode | null {
    if (!isVNode(vnode)) return null
    if (vnode.type === 'w') return vnode
    if (typeof vnode.type === 'function') {
        const rendered = vnode.__qw_rendered
        if (rendered && isVNode(rendered)) {
            return resolveToElementVNode(rendered)
        }
    }
    return null
}

export function layout(rootHwnd: HWND, vnode: VNode): void {
    const clientSize = getClientSize(rootHwnd)
    if (clientSize.w <= 0 || clientSize.h <= 0) return

    const targetVNode = resolveToElementVNode(vnode)
    if (!targetVNode) return

    const targetHwnd = targetVNode.__qw_hwnd
    if (!targetHwnd) return

    moveWindow(targetHwnd, 0, 0, clientSize.w, clientSize.h)
    layoutNode(targetHwnd, targetVNode, { x: 0, y: 0, w: clientSize.w, h: clientSize.h })
}
