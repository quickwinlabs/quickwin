import { forwardRef, useRef, useEffect, useState, type Ref } from 'react'
import * as gui from 'gui'
import * as ffi from 'ffi'
import { struct } from '../../ffi/struct.js'
import { InvalidateRect } from '../../windows/user32.js'
import { NULL } from '../../ffi/ctype.js'
import { NMHDR, nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'

const SYSTEMTIME = struct({
  wYear: 'u16',
  wMonth: 'u16',
  wDayOfWeek: 'u16',
  wDay: 'u16',
  wHour: 'u16',
  wMinute: 'u16',
  wSecond: 'u16',
  wMilliseconds: 'u16',
})
const NMDATETIMECHANGE = struct({
  hdr: NMHDR.__struct,
  dwFlags: 'u32',
  st: SYSTEMTIME.__struct,
})

export interface DateTimePickerProps {
  value?: Date | null
  onChange?: (date: Date | null) => void
  defaultValue?: Date
  format?: 'short' | 'long' | 'time'
  allowNone?: boolean
  updown?: boolean
  style?: WStyle
}

function bufPtr(buf: ArrayBuffer): number {
  return ffi.bufferPtr(buf)
}

function dateToSysTimeBuf(d: Date): ArrayBuffer {
  // wDayOfWeek 设置时被忽略，缺省跳过 = 0
  return SYSTEMTIME.encode({
    wYear: d.getFullYear(),
    wMonth: d.getMonth() + 1,
    wDay: d.getDate(),
    wHour: d.getHours(),
    wMinute: d.getMinutes(),
    wSecond: d.getSeconds(),
    wMilliseconds: d.getMilliseconds(),
  })
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
    InvalidateRect(h, NULL, 1)
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
          const code = nmCode(e.lParam)
          if (code === gui.DtNotifyCode.DATETIMECHANGE) {
            // NMDATETIMECHANGE: NMHDR + DWORD dwFlags + SYSTEMTIME st
            const { dwFlags, st } = NMDATETIMECHANGE.decode(e.lParam)
            if (dwFlags === gui.DtFlag.GDT_NONE) {
              if (!isControlled) setInternalDate(null)
              onChangeRef.current?.(null)
            } else {
              const d = new Date(st.wYear, st.wMonth - 1, st.wDay, st.wHour, st.wMinute, st.wSecond)
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
