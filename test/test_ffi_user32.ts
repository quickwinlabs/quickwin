import { Tester } from './test_helper.js'
import { closure, WCHAR } from '../lib/ffi/bind.js'
import { NULL, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import {
    GetDesktopWindow, IsWindow, IsWindowVisible, GetSystemMetrics, GetClientRect,
    GetWindowTextLength, GetClassName, FindWindow, SetTimer, KillTimer,
    GetKeyState, LoadCursor, SetCursor, GetMenu, DestroyMenu, GetForegroundWindow,
    GetDC, ReleaseDC, EnumWindows, FindWindowEx,
} from '../lib/windows/user32.js'
import { RECT } from '../lib/windows/structs.js'

export const suite = {
    run(t: Tester) {
        t.section('user32: 窗口 / 度量')
        const desk = GetDesktopWindow()
        t.checkTrue('GetDesktopWindow 非 0', desk !== 0)
        if (desk === 0) return
        t.check('IsWindow(desktop)', 1, IsWindow(desk))
        t.check('IsWindowVisible(desktop)', 1, IsWindowVisible(desk))
        t.checkTrue('GetSystemMetrics(SM_CXSCREEN) > 0', GetSystemMetrics(0) > 0)
        t.checkTrue('GetForegroundWindow 形态 number',
            typeof GetForegroundWindow() === 'number')

        t.section('user32: RECT 出参（encode → call → decode 字段直读）')
        const rectOut = RECT.alloc()
        t.check('GetClientRect(desktop)', 1, GetClientRect(desk, rectOut.ptr))
        const rect = RECT.decode(rectOut)
        t.check('客户区宽 = SM_CXSCREEN', GetSystemMetrics(0), rect.right - rect.left)
        t.check('客户区高 = SM_CYSCREEN', GetSystemMetrics(1), rect.bottom - rect.top)

        t.section('user32: 字符串出参（宽字符 buffer 读回）')
        t.checkTrue('GetWindowTextLength ≥ 0', GetWindowTextLength(desk) >= 0)
        const cls = new PtrArrayBuffer(64)
        const n = GetClassName(desk, cls, 32)
        t.checkTrue('GetClassName 写入长度 > 0', n > 0)
        const cdv = new DataView(cls)
        let clsName = ''
        for (let i = 0; i < n; i++) clsName += String.fromCharCode(cdv.getUint16(i * 2, true))
        t.checkTrue('类名非空', clsName.length > 0)
        // JSDoc 文档化流（L4）：WCHAR.alloc(n) 当 out buffer、WCHAR.decode(buf) 读回
        const clsH = WCHAR.alloc(32)
        t.checkTrue('WCHAR.alloc out 写入长度 > 0', GetClassName(desk, clsH, 32) > 0)
        t.check('WCHAR.decode(buf) 读回类名', clsName, WCHAR.decode(clsH))

        t.section('user32: FindWindow（<WCHAR>ptr 的 NULL 与 string 双形态）')
        const fw = FindWindow(NULL, NULL)
        t.checkTrue('FindWindow(NULL, NULL) 形态 number（NULL 实参不 throw）',
            typeof fw === 'number')
        t.check('FindWindow(不存在类名, NULL)', 0, FindWindow('qw_no_such_class_xyz', NULL))

        t.section('user32: 计时器')
        const tid = SetTimer(NULL, 0, 50, NULL)
        t.checkTrue('SetTimer 返回非 0 id', tid !== 0)
        if (tid !== 0) t.checkTrue('KillTimer 成功', KillTimer(NULL, tid) !== 0)

        t.section('user32: 输入 / 光标 / 菜单')
        t.checkTrue('GetKeyState 返回整数', Number.isInteger(GetKeyState(0x1b)))
        t.checkTrue('LoadCursor(NULL, IDC_ARROW=32512) 非 0', LoadCursor(NULL, 32512) !== 0)
        // 品牌流动（正例）：LoadCursor 返回 MaybePtr<'HCURSOR'> 直接喂 SetCursor 形参（先收窄空位）
        const arrow = LoadCursor(NULL, 32512)
        const prevCur = arrow !== 0 ? SetCursor(arrow) : null
        t.checkTrue('SetCursor(LoadCursor(...)) 返回句柄形态',
            arrow !== 0 && (prevCur === null || typeof prevCur === 'number'))
        t.check('GetMenu(desktop) 无菜单 → 0', 0, GetMenu(desk))

        t.section('user32: GetDC / ReleaseDC 配对')
        const hdc = GetDC(NULL)
        t.checkTrue('GetDC(NULL) 非 0', hdc !== 0)
        t.checkTrue('ReleaseDC(NULL, hdc) 成功', hdc !== 0 && ReleaseDC(NULL, hdc) !== 0)

        // 仅类型层反例（不执行）：异种句柄互传、<>ptr 误传品牌位都应编译不过
        const _typeOnly = () => {
            // @ts-expect-error Ptr<>（number）不是 Ptr<'HDC'>，误传桌面句柄应编译不过
            ReleaseDC(NULL, GetDesktopWindow())
            // @ts-expect-error Ptr<'HWND'> 不是 Ptr<'HCURSOR'>，窗口句柄喂 SetCursor 应编译不过
            SetCursor(GetDesktopWindow())
            // @ts-expect-error Ptr<'HWND'> 不是 Ptr<'HMENU'>，窗口句柄喂 DestroyMenu 应编译不过
            DestroyMenu(GetDesktopWindow())
            // @ts-expect-error Ptr<'HMENU'> 不是 Ptr<'HWND'>，菜单句柄喂 IsWindow 应编译不过
            IsWindow(GetMenu(desk))
            // @ts-expect-error 出参位未注册 encoder：<RECT>ptr 只收 MaybePtr<'RECT'>（NULL|Ptr），裸 ArrayBuffer 编译不过
            GetClientRect(desk, new ArrayBuffer(16))
            // @ts-expect-error 裸 number 缺 Ptr<'RECT'> 品牌
            GetClientRect(desk, 123)
            // 正例：同种品牌流动（GetMenu → DestroyMenu）通过——上面反例的成立依赖这层区分
            const m = GetMenu(desk)
            if (m !== 0) DestroyMenu(m)
        }
        void _typeOnly

        t.section('user32: EnumWindows（<>ptr 回调端到端）')
        let count = 0
        const enumClos = closure('<>ptr <>ptr -> i32', () => { count++; return 1 })
        t.check('EnumWindows 返回 1（枚举完成）', 1, EnumWindows(enumClos.ptr, NULL))
        t.checkTrue('回调计数 ≥ 1', count >= 1)
        enumClos.dispose()

        // EnumWindows（快照）与 FindWindowEx(NULL, prev) 链式遍历应得到同一组顶层窗口（实测两者顺序不同，
        // 所以只比集合，不比顺序）。
        // 回调只收集：回调内抛异常会被吞成返回 0（枚举静默提前结束），所以不在回调里做别的。
        t.section('user32: EnumWindows ≡ FindWindowEx 链遍历（顶层窗口集合）')
        const viaEnum: number[] = []
        const collect = closure('<HWND>ptr <>ptr -> i32', (h) => { viaEnum.push(h); return 1 })
        try { EnumWindows(collect.ptr, NULL) } finally { collect.dispose() }
        const viaChain: number[] = []
        for (let h = FindWindowEx(NULL, NULL, NULL, NULL); h && viaChain.length < 100000;
            h = FindWindowEx(NULL, h, NULL, NULL)) viaChain.push(h)
        t.checkTrue('两种遍历都非空', viaEnum.length > 0 && viaChain.length > 0)
        t.check('窗口数量一致', viaEnum.length, viaChain.length)
        const sorted = (a: number[]): string => a.slice().sort((x, y) => x - y).join(',')
        t.check('窗口集合一致（忽略顺序）', sorted(viaEnum), sorted(viaChain))
    },
}
