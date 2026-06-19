import { forwardRef, useRef, useEffect, useState, type Ref } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import type { WStyle } from '../jsx.d.ts'

export interface DateTimePickerProps {
  value?: Date | null
  onChange?: (date: Date | null) => void
  defaultValue?: Date
  format?: 'short' | 'long' | 'time'
  allowNone?: boolean
  updown?: boolean
  style?: WStyle
}

function readI16(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8)
}

function readI32(ptr: number, offset: number): number {
  return ffi.readByte(ptr + offset) | (ffi.readByte(ptr + offset + 1) << 8) |
    (ffi.readByte(ptr + offset + 2) << 16) | (ffi.readByte(ptr + offset + 3) << 24)
}

function bufPtr(buf: ArrayBuffer): number {
  return ffi.bufferPtr(buf) as number
}

function dateToSysTimeBuf(d: Date): ArrayBuffer {
  const buf = new ArrayBuffer(16)
  const dv = new DataView(buf)
  dv.setUint16(0, d.getFullYear(), true)
  dv.setUint16(2, d.getMonth() + 1, true)
  dv.setUint16(4, 0, true)            // wDayOfWeek (ignored on set)
  dv.setUint16(6, d.getDate(), true)
  dv.setUint16(8, d.getHours(), true)
  dv.setUint16(10, d.getMinutes(), true)
  dv.setUint16(12, d.getSeconds(), true)
  dv.setUint16(14, d.getMilliseconds(), true)
  return buf
}

const DateTimePicker = forwardRef(function DateTimePicker(
  { value, onChange, defaultValue, format = 'short', allowNone, updown, style }: DateTimePickerProps,
  ref: Ref<gui.HWND>
) {
  const [internalDate, setInternalDate] = useState<Date | null>(defaultValue ?? null)
  const isControlled = value !== undefined
  const effectiveDate = isControlled ? value : internalDate
  const dpRef = useRef<gui.HWND>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  let dpStyle = gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER
  if (format === 'long') dpStyle |= gui.DtStyle.LONGDATEFORMAT
  else if (format === 'time') dpStyle |= gui.DtStyle.TIMEFORMAT
  if (updown) dpStyle |= gui.DtStyle.UPDOWN
  if (allowNone) dpStyle |= gui.DtStyle.SHOWNONE

  useEffect(() => {
    const h = dpRef.current
    if (!h) return
    const d = effectiveDate
    if (d) {
      const buf = dateToSysTimeBuf(d)
      gui.SendMessage(h, gui.DtMsg.SETSYSTEMTIME, gui.DtFlag.GDT_VALID, bufPtr(buf))
    } else {
      gui.SendMessage(h, gui.DtMsg.SETSYSTEMTIME, gui.DtFlag.GDT_NONE, 0)
    }
  }, [effectiveDate])

  useEffect(() => {
    const h = dpRef.current
    if (!h) return
    gui.InvalidateRect(h, null, true)
    // 发送 WM_SIZE 让控件（尤其是 DTS_UPDOWN）重新布局内部子窗口
    const cr = gui.GetClientRect(h)
    if (cr) {
      const w = cr.right - cr.left
      const hh = cr.bottom - cr.top
      gui.SendMessage(h, gui.WmMsg.SIZE, 0, (hh << 16) | w)
    }
  }, [])

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === gui.WmMsg.NOTIFY) {
          const code = readI32(e.lParam, 16)
          if (code === gui.DtNotifyCode.DATETIMECHANGE) {
            const dwFlags = readI32(e.lParam, 24)
            if (dwFlags === gui.DtFlag.GDT_NONE) {
              if (!isControlled) setInternalDate(null)
              onChangeRef.current?.(null)
            } else {
              const year = readI16(e.lParam, 28)
              const month = readI16(e.lParam, 30)
              const day = readI16(e.lParam, 34)
              const hour = readI16(e.lParam, 36)
              const min = readI16(e.lParam, 38)
              const sec = readI16(e.lParam, 40)
              const d = new Date(year, month - 1, day, hour, min, sec)
              if (!isControlled) setInternalDate(d)
              onChangeRef.current?.(d)
            }
          }
        }
      }}
    >
      <w type="SysDateTimePick32" ws={dpStyle}
        style={{flexGrow:1}}
        ref={(h: gui.HWND) => { dpRef.current = h }}
      />
    </w>
  )
}) as (
  props: DateTimePickerProps & { ref?: React.Ref<gui.HWND> }
) => React.ReactElement

export { DateTimePicker }
