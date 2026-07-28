export type JustifyContent = 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly'

export interface FlexStyle {
  flexDirection?: 'row' | 'column'
  justifyContent?: JustifyContent
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap?: number
  padding?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
}

interface ChildStyle {
  width?: number | 'auto'; height?: number | 'auto'
  flexGrow?: number
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch'
}

interface ChildInfo {
  style: ChildStyle
}

export interface LayoutResult {
  x: number; y: number; width: number; height: number
}

const DEFAULT_W = 100
const DEFAULT_H = 30

export function calculateFlexLayout(
  flex: FlexStyle,
  parentW: number,
  parentH: number,
  children: ChildInfo[]
): LayoutResult[] {
  const dir = flex.flexDirection || 'column'
  const gap = flex.gap ?? 0
  const justify = flex.justifyContent || 'flex-start'
  const align = flex.alignItems || 'stretch'
  const isRow = dir === 'row'
  const n = children.length

  const mainSize: 'w' | 'h' = isRow ? 'w' : 'h'
  const crossSize: 'w' | 'h' = isRow ? 'h' : 'w'
  const mainPos: 'x' | 'y' = isRow ? 'x' : 'y'
  const crossPos: 'x' | 'y' = isRow ? 'y' : 'x'
  const mainDim: 'width' | 'height' = isRow ? 'width' : 'height'
  const crossDim: 'width' | 'height' = isRow ? 'height' : 'width'
  const pt = flex.paddingTop ?? flex.padding ?? 0
  const pr = flex.paddingRight ?? flex.padding ?? 0
  const pb = flex.paddingBottom ?? flex.padding ?? 0
  const pl = flex.paddingLeft ?? flex.padding ?? 0
  const mainPadding = isRow ? pl + pr : pt + pb
  const crossPadding = isRow ? pt + pb : pl + pr
  const parentMain = (isRow ? parentW : parentH) - mainPadding
  const parentCross = (isRow ? parentH : parentW) - crossPadding

  const sizes = children.map(c => ({
    w: typeof c.style.width === 'number' ? c.style.width : DEFAULT_W,
    h: typeof c.style.height === 'number' ? c.style.height : DEFAULT_H,
  }))

  const flexGrows = children.map(c => c.style.flexGrow ?? 0)
  const totalGrow = flexGrows.reduce((s, g) => s + g, 0)

  const baseMain = sizes.reduce((s, c) => s + c[mainSize], 0)
  let freeGrow = parentMain - baseMain - Math.max(0, n - 1) * gap
  if (totalGrow > 0 && freeGrow > 0) {
    for (let i = 0; i < n; i++) {
      sizes[i]![mainSize] += freeGrow * flexGrows[i]! / totalGrow
    }
  }

  const totalMain = sizes.reduce((s, c) => s + c[mainSize], 0)
  const free = parentMain - totalMain - Math.max(0, n - 1) * gap
  let offset = 0, extraGap = 0
  if (justify === 'flex-end') offset = free
  else if (justify === 'center') offset = Math.max(0, free / 2)
  else if (justify === 'space-between' && n > 1) extraGap = free / (n - 1)
  else if (justify === 'space-around') { extraGap = free / n; offset = extraGap / 2 }
  else if (justify === 'space-evenly') { extraGap = free / (n + 1); offset = extraGap }

  let cursor = offset
  return sizes.map((sz, i) => {
    const childCrossBase = sz[crossSize]
    const childAlign = children[i]!.style.alignSelf ?? 'auto'
    const effectiveAlign = childAlign === 'auto' ? align : childAlign
    let childMain = sz[mainSize]
    let childCross = childCrossBase
    const res: LayoutResult = { x: 0, y: 0, width: 0, height: 0 }
    res[mainPos] = cursor
    res[crossPos] = 0
    res[mainDim] = childMain
    res[crossDim] = childCross
    if (effectiveAlign === 'stretch') {
      const hasExplicitCross = typeof children[i]!.style[crossDim] === 'number'
      if (!hasExplicitCross) {
        res[crossDim] = parentCross
        res[crossPos] = 0
      }
    } else if (effectiveAlign === 'flex-end') {
      res[crossPos] = parentCross - childCross
    } else if (effectiveAlign === 'center') {
      res[crossPos] = Math.max(0, (parentCross - childCross) / 2)
    }
    cursor += childMain + gap + extraGap
    return res
  })
}
