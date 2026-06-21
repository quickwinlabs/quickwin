# react-qw — React Custom Renderer for Win32 GUI

A React reconciler that renders native Win32 controls (buttons, edits, list views, etc.) — no DOM, no Canvas, just Windows HWNDs.

## Quick Start

```ts
import { render, Button, Input } from '../lib/react-qw/index.js'

gui.RegisterClass('MyApp')
const hwnd = gui.CreateWindow('MyApp', 'Hello', gui.WindowStyle.OVERLAPPEDWINDOW, 100, 100, 400, 300, null, null)

render(
  <w ws={gui.WindowStyle.VISIBLE} style={{flexDirection:'column', gap:4, width:380, height:260}}>
    <Button onClick={() => alert('clicked')}>Click me</Button>
    <Input placeholder="type something" />
  </w>,
  hwnd
)

gui.ShowWindow(hwnd)
```

## API

### render(element, containerHwnd, callback?)

```ts
function render(element: React.ReactElement, container: gui.HWND, callback?: () => void): void
```

### createRoot(containerHwnd)

```ts
function createRoot(containerHwnd: gui.HWND): { render(element: any): void; unmount(): void }
```

---

## JSX

### `<w>` element

The only intrinsic element. Maps to a Win32 window of the class specified by `type`.

| Prop | Type | Description |
|------|------|-------------|
| `type` | `string` | Win32 class name (`BUTTON`, `EDIT`, `STATIC`, `LISTBOX`, etc.) |
| `text` | `string` | Window text / control label |
| `ws` | `number` | Window style flags (OR-ed constants like `gui.WindowStyle.VISIBLE`) |
| `style` | `WStyle` | Position/size/flexbox properties |
| `disabled` | `boolean` | Calls `EnableWindow` |
| `hidden` | `boolean` | Shows/hides the window |
| `visible` | `boolean` | Shows/hides the window |
| `onEvent` | `(e: WEvent) => number \| void` | Raw Win32 message callback |
| `ref` | `React.Ref<gui.HWND>` | Receives the HWND |
| `children` | `string \| number \| ReactNode` | Text content or child elements |

### WStyle

```ts
interface WStyle {
  x?: number; y?: number                     // absolute position
  width?: number; height?: number            // size
  flexDirection?: 'row' | 'column'           // flexbox direction
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly'
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch'
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch'
  gap?: number                               // spacing between children
  flexGrow?: number                          // proportional grow in flex container
}
```

When `x`/`y`/`width`/`height` are set, the window is positioned absolutely relative to its parent. Otherwise flexbox layout is used when the parent has flexbox properties.

### WEvent

```ts
interface WEvent {
  hwnd: gui.HWND
  msg: number          // WM_* message constant
  wParam: number
  lParam: number
}
```

Return a number to override the window's default processing, or `undefined` to let the default handler run.

---

## Components

### Button

Simple clickable button.

```ts
interface ButtonProps {
  children?: string | number | (string | number)[]
  onClick?: () => void
  style?: WStyle
  disabled?: boolean
}
```

### CheckBox

Checkbox with optional controlled/uncontrolled mode.

```ts
interface CheckBoxProps {
  checked?: boolean            // controlled mode
  defaultChecked?: boolean     // initial state (uncontrolled)
  onChange?: (checked: boolean) => void
  label?: string
  style?: WStyle
  disabled?: boolean
}
```

### ComboBox

Dropdown list.

```ts
interface ComboBoxProps {
  items: string[]
  selectedIndex?: number       // controlled mode
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
  disabled?: boolean
}
```

### DateTimePicker

Date/time picker control.

```ts
interface DateTimePickerProps {
  value?: Date | null          // controlled mode; null = none
  onChange?: (date: Date | null) => void
  defaultValue?: Date
  format?: 'short' | 'long' | 'time'
  allowNone?: boolean          // DTS_SHOWNONE
  updown?: boolean             // DTS_UPDOWN
  style?: WStyle
}
```

### Input

Text input field (single-line or multiline).

```ts
interface InputProps {
  value?: string               // controlled mode
  defaultValue?: string
  onChange?: (value: string) => void
  placeholder?: string
  password?: boolean
  multiline?: boolean
  readonly?: boolean
  number?: boolean
  disabled?: boolean
  style?: WStyle
}
```

### Link

SysLink hyperlink control.

```ts
interface LinkProps {
  href?: string                // default URL if children omitted
  children?: string
  onClick?: (url: string) => void
  style?: WStyle
}
```

### ListBox

Item list.

```ts
interface ListBoxProps {
  items: string[]
  selectedIndex?: number       // controlled mode
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
  disabled?: boolean
  sort?: boolean               // LBS_SORT
}
```

### ListView

Multi-column data table (report mode).

```ts
interface ListViewProps<D extends Record<string, any>> {
  columns: Column<D>[]
  data: D[]
  selectedIndex?: number       // controlled mode
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
}

interface Column<D> {
  name: string                 // column header
  dataIndex: keyof D           // key into data row
}
```

### ProgressBar

Determinate progress bar.

```ts
interface ProgressBarProps {
  value?: number               // default 0
  max?: number                 // default 100
  style?: WStyle
  smooth?: boolean             // PBS_SMOOTH
}
```

### RadioButton

Radio button with optional controlled/uncontrolled mode.

```ts
interface RadioButtonProps {
  checked?: boolean            // controlled mode
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  label?: string
  style?: WStyle
  disabled?: boolean
}
```

### ScrollView

Scrollable container. Wraps children in a STATIC with `WS_HSCROLL`/`WS_VSCROLL` and internal scroll logic.

```ts
interface ScrollViewProps {
  children?: React.ReactNode
  style?: WStyle
}
```

### Slider

Trackbar slider.

```ts
interface SliderProps {
  value: number
  onChange?: (value: number) => void
  min?: number                 // default 0
  max?: number                 // default 100
  vertical?: boolean
  disabled?: boolean
  style?: WStyle
}
```

### Tab

Tab control with per-tab content panels.

```ts
interface TabProps {
  tabs: { title: string; content: ReactNode }[]
  selectedIndex?: number       // controlled mode
  defaultSelectedIndex?: number
  onChange?: (index: number) => void
  style?: WStyle
}
```

### Tooltip

Tooltip attached to a single child element.

```ts
interface TooltipProps {
  text: string
  children: React.ReactElement  // exactly one child
  balloon?: boolean             // use balloon style
}
```

Usage: wraps its single child and shows `text` on hover.

### TreeView

Tree with expandable nodes.

```ts
interface TreeViewProps<D = any> {
  data: TreeNode<D>[]
  onSelect?: (node: TreeNode<D> | null) => void
  defaultSelectedKey?: string
  selectedKey?: string          // controlled mode
  style?: WStyle
}

interface TreeNode<D = any> {
  key?: string
  label: string
  children?: TreeNode<D>[]
}
```

---

## File Structure

```
lib/react-qw/
  index.ts         — render(), createRoot(), component re-exports
  reconciler.ts    — react-reconciler host config, flex layout, instance management
  jsx.d.ts         — JSX type declarations (WStyle, WEvent, <w> intrinsic)
  props.ts         — applyProps: applies React props to HWND (text, style, disabled, etc.)
  layout.ts        — calculateFlexLayout: simplified flexbox layout engine
  components/
    index.ts       — re-exports all components
    Button.tsx
    CheckBox.tsx
    ComboBox.tsx
    DateTimePicker.tsx
    Input.tsx
    Link.tsx
    ListBox.tsx
    ListView.tsx
    ProgressBar.tsx
    RadioButton.tsx
    ScrollView.tsx
    Slider.tsx
    Tab.tsx
    Tooltip.tsx
    TreeView.tsx
```
