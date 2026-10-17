import type { Ptr } from '../../ffi/ctype.js'
import { forwardRef, useRef, useEffect, useState, type Ref } from 'react'
import * as gui from 'gui'
import { GetClientRect, InvalidateRect } from '../../windows/user32.js'
import { NULL } from '../../ffi/ctype.js'
import { RECT, SYSTEMTIME, NMDATETIMECHANGE } from '../../windows/structs.js'
import { nmCode } from '../nmhdr.js'
import type { WStyle } from '../jsx.d.ts'
import { DtFlag, DtMsg, DtNotifyCode, DtStyle, WindowStyle, WmMsg } from '../../../constants'

export interface DateTimePickerProps {
  value?: Date | null
  onChange?: (date: Date | null) => void
  defaultValue?: Date
  format?: 'short' | 'long' | 'time'
  allowNone?: boolean
  updown?: boolean
  style?: WStyle
}


function dateToSysTimeBuf(d: Date) {
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

  let dpStyle = WindowStyle.VISIBLE | WindowStyle.BORDER
  if (format === 'long') dpStyle |= DtStyle.LONGDATEFORMAT
  else if (format === 'time') dpStyle |= DtStyle.TIMEFORMAT
  if (updown) dpStyle |= DtStyle.UPDOWN
  if (allowNone) dpStyle |= DtStyle.SHOWNONE

  useEffect(() => {
    const h = dpRef.current
    if (!h) return
    const d = effectiveDate
    if (d) {
      const buf = dateToSysTimeBuf(d)
      gui.SendMessage(h, DtMsg.SETSYSTEMTIME, DtFlag.GDT_VALID, buf.ptr)
    } else {
      gui.SendMessage(h, DtMsg.SETSYSTEMTIME, DtFlag.GDT_NONE, 0)
    }
  }, [effectiveDate])

  useEffect(() => {
    const h = dpRef.current
    if (!h) return
    InvalidateRect(h, NULL, 1)
    // 发送 WM_SIZE 让控件（尤其是 DTS_UPDOWN）重新布局内部子窗口
    const cr = RECT.alloc()
    if (GetClientRect(h, cr.ptr)) {
      const { left, top, right, bottom } = RECT.decode(cr)
      gui.SendMessage(h, WmMsg.SIZE, 0, ((bottom - top) << 16) | (right - left))
    }
  }, [])

  return (
    <w type="STATIC"
      ws={WindowStyle.VISIBLE | WindowStyle.CLIPCHILDREN}
      style={{ ...style, flexDirection: 'column', alignItems: 'stretch' }}
      ref={ref}
      onEvent={(e) => {
        if (e.msg === WmMsg.NOTIFY) {
          const code = nmCode(e.lParam)
          if (code === DtNotifyCode.DATETIMECHANGE) {
            // NMDATETIMECHANGE: NMHDR + DWORD dwFlags + SYSTEMTIME st
            const { dwFlags, st } = NMDATETIMECHANGE.decode(e.lParam as Ptr<'NMDATETIMECHANGE'>)
            if (dwFlags === DtFlag.GDT_NONE) {
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
