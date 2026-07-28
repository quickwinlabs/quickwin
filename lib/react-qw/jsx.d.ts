import type { HWND } from 'gui'

interface WStyle {
  width?: number | 'auto'; height?: number | 'auto'
  flexDirection?: 'row' | 'column'
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly'
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap?: number
  padding?: number
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  flexGrow?: number
}

interface WEvent {
  hwnd: HWND; msg: number; wParam: number; lParam: number
}
interface WOnEventObj {
  fn: (e: WEvent & {callOldWndProc: () => number}) => number
}
interface WIntrinsicProps {
  key?: string | number; type: string; text?: string; ws?: number
  disabled?: boolean; visible?: boolean; hidden?: boolean; style?: WStyle
  onEvent?: ((e: WEvent) => number | void) | WOnEventObj
  children?: React.ReactNode
  ref?: React.Ref<HWND>
}
declare module 'react' {
  namespace JSX { interface IntrinsicElements { w: WIntrinsicProps } }
}
export type { WEvent, WIntrinsicProps, WStyle }
