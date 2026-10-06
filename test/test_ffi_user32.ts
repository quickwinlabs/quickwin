import { Tester } from './test_helper.js'
import { closure } from '../lib/ffi/bind.js'
import {
    GetDesktopWindow, IsWindow, IsWindowVisible, GetSystemMetrics, GetClientRect,
    GetWindowTextLength, GetClassName, FindWindow, SetTimer, KillTimer,
    GetKeyState, LoadCursor, GetMenu, GetForegroundWindow, GetDC, ReleaseDC,
    EnumWindows,
} from '../lib/user32.js'

export const suite = {
    run(t: Tester) {
        t.section('user32: 窗口 / 度量')
        const desk = GetDesktopWindow()
        t.checkTrue('GetDesktopWindow 非 null', desk !== null)
        t.check('IsWindow(desktop)', 1, IsWindow(desk))
        t.check('IsWindowVisible(desktop)', 1, IsWindowVisible(desk))
        t.checkTrue('GetSystemMetrics(SM_CXSCREEN) > 0', GetSystemMetrics(0) > 0)
        t.checkTrue('GetForegroundWindow 形态 number|null',
            GetForegroundWindow() === null || typeof GetForegroundWindow() === 'number')

        t.section('user32: RECT 出参（<BYTE>ptr 原地读回）')
        const rect = new ArrayBuffer(16)
        t.check('GetClientRect(desktop)', 1, GetClientRect(desk, rect))
        const rdv = new DataView(rect)
        t.check('客户区宽 = SM_CXSCREEN', GetSystemMetrics(0), rdv.getInt32(8, true) - rdv.getInt32(0, true))
        t.check('客户区高 = SM_CYSCREEN', GetSystemMetrics(1), rdv.getInt32(12, true) - rdv.getInt32(4, true))

        t.section('user32: 字符串出参（宽字符 buffer 读回）')
        t.checkTrue('GetWindowTextLength ≥ 0', GetWindowTextLength(desk) >= 0)
        const cls = new ArrayBuffer(64)
        const n = GetClassName(desk, cls, 32)
        t.checkTrue('GetClassName 写入长度 > 0', n > 0)
        const cdv = new DataView(cls)
        let clsName = ''
        for (let i = 0; i < n; i++) clsName += String.fromCharCode(cdv.getUint16(i * 2, true))
        t.checkTrue('类名非空', clsName.length > 0)

        t.section('user32: FindWindow（<WCHAR>ptr 的 null 与 string 双形态）')
        const fw = FindWindow(null, null)
        t.checkTrue('FindWindow(null, null) 形态 number|null（NULL 实参不 throw）',
            fw === null || typeof fw === 'number')
        t.check('FindWindow(不存在类名, null)', null, FindWindow('qw_no_such_class_xyz', null))

        t.section('user32: 计时器')
        const tid = SetTimer(null, 0, 50, null)
        t.checkTrue('SetTimer 返回非 null id', tid !== null)
        if (tid !== null) t.checkTrue('KillTimer 成功', KillTimer(null, tid) !== 0)

        t.section('user32: 输入 / 光标 / 菜单')
        t.checkTrue('GetKeyState 返回整数', Number.isInteger(GetKeyState(0x1b)))
        t.checkTrue('LoadCursor(0, IDC_ARROW=32512) 非 null', LoadCursor(0, 32512) !== null)
        t.check('GetMenu(desktop) 无菜单 → null', null, GetMenu(desk))

        t.section('user32: GetDC / ReleaseDC 配对')
        const hdc = GetDC(null)
        t.checkTrue('GetDC(null) 非 null', hdc !== null)
        t.checkTrue('ReleaseDC(null, hdc) 成功', ReleaseDC(null, hdc) !== 0)

        // 仅类型层反例（不执行）：<>ptr（普通 number，如 HWND）不能传给 <HDC>ptr 归还位
        const _typeOnly = () => {
            // @ts-expect-error Ptr<>（number）不是 Ptr<'HDC'>，误传桌面句柄应编译不过
            ReleaseDC(null, GetDesktopWindow())
        }
        void _typeOnly

        t.section('user32: EnumWindows（<>ptr 回调端到端）')
        let count = 0
        const enumClos = closure('<>ptr <>ptr -> i32', () => { count++; return 1 })
        t.check('EnumWindows 返回 1（枚举完成）', 1, EnumWindows(enumClos.ptr, null))
        t.checkTrue('回调计数 ≥ 1', count >= 1)
        enumClos.dispose()
    },
}
