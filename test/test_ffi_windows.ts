import { Tester } from './test_helper.js'
import { NULL, PTR_SIZE, PtrArrayBuffer } from '../lib/ffi/ctype.js'
import {
    GetDesktopWindow, CreatePopupMenu, DestroyMenu, GetDC, ReleaseDC,
    LoadImage, LoadImageOrdinal, SetScrollInfo, GetScrollInfo,
} from '../lib/windows/user32.js'
import {
    GetDeviceCaps, CreateSolidBrush, DeleteObject, CreateFontIndirect, GetObject, SelectObject, CreateCompatibleDC, CreateCompatibleBitmap, DeleteDC, GetDIBits, SetBrushOrgEx,
} from '../lib/windows/gdi32.js'
import { CloseHandle, CreateMutex, GetLastError, ReleaseMutex } from '../lib/windows/kernel32.js'
import { ImageListCreate, ImageListAdd, ImageListDestroy } from '../lib/windows/comctl32.js'
import { ShellNotifyIcon } from '../lib/windows/shell32.js'
import { BITMAPINFOHEADER, DOCINFOW, LOGFONTW, NONCLIENTMETRICSW, NOTIFYICONDATAW, POINT, SCROLLINFO } from '../lib/windows/structs.js'
import { ColorUse, DeviceCap, IDI, ImageListFlag, ImageType, LoadImageFlag, NotifyIconCmd, NotifyIconFlag } from '../constants'
import { createSystemDpiFont, getScaleFactor } from '../lib/dpi.js'
import { createBitmapFromPixels } from '../lib/bitmap.js'

export const suite = {
    run(t: Tester) {
        // 本文件 import 三个 dll 模块即在加载时执行全部 bind：proc 名错误 → GetProcAddress 失败 →
        // 模块加载 throw → run.ts 静默跳过本 suite → 总计数低于基线（判据链对比计数即暴露）
        t.section('gdi32: 画刷 / 字体 创建-删除往返（LOGFONTW 对象直传）')
        const brush = CreateSolidBrush(0x3366ff)
        t.checkTrue('CreateSolidBrush 非 0', brush !== 0)
        if (brush !== 0) t.checkTrue('DeleteObject(brush) 成功', DeleteObject(brush) !== 0)

        // DeepPartial 缺省字段跳过：lfHeight + lfFaceName 必给，其余标量保持 0（FW_DONTCARE 等合法零值）
        const font = CreateFontIndirect({ lfHeight: -16, lfWeight: 400, lfCharSet: 1, lfFaceName: 'Arial' })
        t.checkTrue('CreateFontIndirect(DeepPartial LOGFONTW) 非 0', font !== 0)
        if (font !== 0) t.checkTrue('DeleteObject(font) 成功', DeleteObject(font) !== 0)

        // react-qw ListView.getCellFont 的流程：GetObject 读出现有字体 → decode → 叠加粗/斜/下划线 → 重建 → 回读
        t.section('gdi32: 字体读出-改写-重建往返（GetObject → decode → CreateFontIndirect → GetObject）')
        const base = CreateFontIndirect({ lfHeight: -18, lfWeight: 400, lfCharSet: 1, lfFaceName: 'Arial' })
        if (base !== 0) {
            const lf0 = LOGFONTW.alloc()
            t.checkTrue('GetObject(font) 写入 LOGFONTW.size 字节', GetObject(base, LOGFONTW.size, lf0) === LOGFONTW.size)
            const b0 = LOGFONTW.decode(lf0)
            t.check('读出 lfHeight', -18, b0.lfHeight)
            t.check('读出 lfWeight', 400, b0.lfWeight)
            t.check('读出 lfItalic（未设）', 0, b0.lfItalic)
            const styled = CreateFontIndirect({ ...b0, lfWeight: 700, lfItalic: 1, lfUnderline: 1 })
            t.checkTrue('叠加样式后重建非 0', styled !== 0)
            if (styled !== 0) {
                const lf1 = LOGFONTW.alloc()
                GetObject(styled, LOGFONTW.size, lf1)
                const b1 = LOGFONTW.decode(lf1)
                t.check('重建后 lfWeight', 700, b1.lfWeight)
                t.check('重建后 lfItalic', 1, b1.lfItalic)
                t.check('重建后 lfUnderline', 1, b1.lfUnderline)
                t.check('底字体的 lfHeight 保留', -18, b1.lfHeight)
                t.check('底字体的 lfCharSet 保留', 1, b1.lfCharSet)
                t.check('底字体的字体名保留', b0.lfFaceName, b1.lfFaceName)
                t.checkTrue('DeleteObject(styled) 成功', DeleteObject(styled) !== 0)
            }
            t.checkTrue('DeleteObject(base) 成功', DeleteObject(base) !== 0)
        }

        // 内存 DC 选入字体：SelectObject 返回被替换的旧对象，选回后可删除新对象（截屏与 ListView 自绘共用）
        t.section('gdi32: CreateCompatibleDC / SelectObject 往返')
        const memDc = CreateCompatibleDC(NULL)
        t.checkTrue('CreateCompatibleDC(NULL) 非 0', memDc !== 0)
        if (memDc !== 0) {
            const f2 = CreateFontIndirect({ lfHeight: -12, lfFaceName: 'Arial' })
            if (f2 !== 0) {
                const old = SelectObject(memDc, f2)
                t.checkTrue('SelectObject 返回旧对象非 0', old !== 0)
                t.check('再选回旧对象，返回刚选入的字体', f2, SelectObject(memDc, old))
                t.checkTrue('DeleteObject(f2) 成功', DeleteObject(f2) !== 0)
            }
            t.checkTrue('DeleteDC 成功', DeleteDC(memDc) !== 0)
        }

        t.section('gdi32: GetDeviceCaps（<HDC>ptr 跨 user32 品牌互认）')
        const hdc = GetDC(NULL)
        t.checkTrue('GetDC(NULL) 非 0', hdc !== 0)
        if (hdc !== 0) t.checkTrue('GetDeviceCaps(hdc, LOGPIXELSX) > 0', GetDeviceCaps(hdc, DeviceCap.LOGPIXELSX) > 0)
        t.checkTrue('ReleaseDC(NULL, hdc) 成功', hdc !== 0 && ReleaseDC(NULL, hdc) !== 0)

        t.section('user32: 弹出菜单往返')
        const pm = CreatePopupMenu()
        t.checkTrue('CreatePopupMenu 非 0', pm !== 0)
        if (pm !== 0) t.checkTrue('DestroyMenu(pm) 成功', DestroyMenu(pm) !== 0)

        t.section('comctl32: ImageList 创建-加位图-销毁往返（hbmMask 位传 NULL）')
        const himl = ImageListCreate(16, 16, ImageListFlag.COLOR24, 0, 0)   // initial/grow=0 默认
        t.checkTrue('ImageListCreate(16, 16, ILC_COLOR24) 非 0', himl !== 0)
        if (himl !== 0) {
            const hdcMem = CreateCompatibleDC(NULL)
            const hbm = hdcMem !== 0 ? CreateCompatibleBitmap(hdcMem, 16, 16) : 0
            t.checkTrue('CreateCompatibleBitmap(16, 16) 非 0', hbm !== 0)
            if (hbm !== 0) t.check('ImageListAdd(himl, hbm, NULL) → 索引 0', 0, ImageListAdd(himl, hbm, NULL))
            if (hbm !== 0) DeleteObject(hbm)
            if (hdcMem !== 0) DeleteDC(hdcMem)
            t.checkTrue('ImageListDestroy(himl) 成功', ImageListDestroy(himl) !== 0)
        }

        t.section('user32: LoadImage 双变体（string 自动编码 / ordinal MAKEINTRESOURCE）')
        // Win32 IMAGE_* 真值：BITMAP=0 CURSOR=1 ICON=2；LR_SHARED=0x8000（注意 ImageType d.ts 当前值与此不一致）
        t.checkTrue('LoadImageOrdinal(NULL, IDI_APPLICATION, IMAGE_ICON, LR_SHARED) 非 0',
            LoadImageOrdinal(NULL, 32512, 2, 0, 0, 0x8000) !== 0)
        t.check('LoadImage(LOADFROMFILE, 不存在文件) → 0', 0,
            LoadImage(NULL, 'qw_no_such_icon_xyz.ico', 2, 0, 0, 0x10))

        t.section('user32: 滚动条（入参对象直传 / 出参 encode → call → decode）')
        const desk = GetDesktopWindow()
        t.checkTrue('GetDesktopWindow 非 0', desk !== 0)
        if (desk === 0) return
        // 入参位（注册 encoder）：DeepPartial 对象直传；cbSize 必须显式 = 结构自描述要求。
        // 桌面窗口无 WS_VSCROLL 样式 → Set/GetScrollInfo 返回 0 是 Win32 合法行为（.NET 的
        // WindowsScroll 包装同样先查样式再调用），故断言形态而非成功。
        t.checkTrue('SetScrollInfo 对象直传 形态 number',
            typeof SetScrollInfo(desk, 1, { cbSize: SCROLLINFO.size, fMask: 0x0001, nMin: 0, nMax: 100 }, 0) === 'number')
        // 出参位（不注册 encoder）：encode() 新建 + 初值一步 → 传 .ptr → decode 字段直读。
        // GetScrollInfo 失败（无滚动条）不写 buffer → decode 回读 = encode 初值；成功时 Win32
        // 覆写 cbSize/fMask 为同值 —— 两条路径下回环断言都稳定。
        const si = SCROLLINFO.encode({ cbSize: SCROLLINFO.size, fMask: 0x0001 })
        t.checkTrue('GetScrollInfo 调用形态 number', typeof GetScrollInfo(desk, 1, si.ptr) === 'number')
        const info = SCROLLINFO.decode(si)
        t.check('decode 回读 cbSize = encode 初值', SCROLLINFO.size, info.cbSize)
        t.check('decode 回读 fMask = encode 初值', 0x0001, info.fMask)
        t.checkTrue('读回字段为 number 形态', typeof info.nMin === 'number' && typeof info.nMax === 'number')
        // CallWindowProc / ShowScrollBar 仅由 import 的模块加载覆盖 proc 名：
        // CallWindowProc 跨线程窗口过程不安全、ShowScrollBar 有副作用

        // NONCLIENTMETRICS 的 cbSize/uiParam 随系统变（Vista+ 504 / XP·2003 500），
        // 尺寸回退逻辑在 lib/dpi；此处只锁结构布局与端到端效果（见下 section）。
        t.check('NONCLIENTMETRICSW.size == 504（4 LOGFONTW + 12 DWORD）', 504, NONCLIENTMETRICSW.size)

        t.section('lib/dpi: 下沉到 JS 的 DPI / 系统字体复合逻辑')
        t.checkTrue('getScaleFactor() ≥ 0.5', getScaleFactor() >= 0.5)
        const dpiFont = createSystemDpiFont()
        t.checkTrue('createSystemDpiFont() 非 NULL（SPI 尺寸回退后仍取到系统消息字体）', dpiFont !== 0)
        if (dpiFont) {
            const lf = LOGFONTW.alloc()
            t.checkTrue('GetObject(dpiFont, LOGFONTW.size) 回读成功', GetObject(dpiFont, LOGFONTW.size, lf) === LOGFONTW.size)
            const fo = LOGFONTW.decode(lf)
            t.checkTrue('系统消息字体 lfFaceName 非空（结构确被 SPI 填过）', typeof fo.lfFaceName === 'string' && fo.lfFaceName.length > 0)
            t.checkTrue('DeleteObject(系统字体) 成功', DeleteObject(dpiFont) !== 0)
        }

        t.section('shell32: Shell_NotifyIconW 托盘图标增删（NOTIFYICONDATAW 对象直传）')
        // 尺寸基准来自 mingw 头文件实测（x86 956 / x64 976，随 hWnd/hIcon/hBalloonIcon 位宽）
        t.check('NOTIFYICONDATAW.size == mingw sizeof（x86 956 / x64 976）',
            PTR_SIZE === 4 ? 956 : 976, NOTIFYICONDATAW.size)
        const nid = NOTIFYICONDATAW.encode({ cbSize: NOTIFYICONDATAW.size, szTip: 'quickwin', szInfoTitle: 'qw' })
        const nidBack = NOTIFYICONDATAW.decode(nid)
        t.check('宽字符串糖 szTip 编解码往返', 'quickwin', nidBack.szTip)
        t.check('宽字符串糖 szInfoTitle 编解码往返', 'qw', nidBack.szInfoTitle)

        const trayIcon = LoadImageOrdinal(NULL, IDI.APPLICATION, ImageType.ICON, 0, 0, LoadImageFlag.SHARED)
        t.checkTrue('LoadImageOrdinal(IDI.APPLICATION, SHARED) 非 0', trayIcon !== 0)
        const trayHwnd = GetDesktopWindow()
        t.checkTrue('ShellNotifyIcon(ADD) 成功（Vista+ 尺寸在 XP/Win7 均被接受）', ShellNotifyIcon(NotifyIconCmd.ADD, {
            cbSize: NOTIFYICONDATAW.size, hWnd: trayHwnd, uID: 77,
            uFlags: NotifyIconFlag.MESSAGE | NotifyIconFlag.ICON | NotifyIconFlag.TIP,
            uCallbackMessage: 0x8001, hIcon: trayIcon, szTip: 'quickwin test',
        }) !== 0)
        t.checkTrue('ShellNotifyIcon(DELETE) 成功（只需 hWnd+uID）',
            ShellNotifyIcon(NotifyIconCmd.DELETE, { cbSize: NOTIFYICONDATAW.size, hWnd: trayHwnd, uID: 77 }) !== 0)

        t.section('lib/bitmap: 按像素建 32bpp DIB 段（原 gui.CreateBitmapFromPixels）')
        const nw = 4, nh = 2
        const px = new ArrayBuffer(nw * nh * 4)
        const px8 = new Uint8Array(px)
        for (let i = 0; i < px8.length; i++) px8[i] = (i * 37 + 11) & 0xff
        const hbm = createBitmapFromPixels(nw, nh, px)
        t.checkTrue('createBitmapFromPixels(4x2) 非 NULL', hbm !== 0)
        if (hbm) {
            const bmi = BITMAPINFOHEADER.encode({
                biSize: BITMAPINFOHEADER.size, biWidth: nw, biHeight: -nh,
                biPlanes: 1, biBitCount: 32, biSizeImage: nw * nh * 4,
            })
            const back = new PtrArrayBuffer<'BYTE'>(nw * nh * 4)
            const dc = GetDC(NULL)
            const rows = dc ? GetDIBits(dc, hbm, 0, nh, back, bmi.ptr, ColorUse.RGB_COLORS) : 0
            if (dc) ReleaseDC(NULL, dc)
            t.check('GetDIBits 取回全部扫描行', nh, rows)
            const back8 = new Uint8Array(back)
            let same = rows === nh
            for (let i = 0; i < back8.length; i++) if (back8[i] !== px8[i]) same = false
            t.checkTrue('像素逐字节一致（含 alpha，与旧 C 的 memcpy 等价）', same)
            t.checkTrue('DeleteObject(位图) 成功', DeleteObject(hbm) !== 0)
        }
        t.checkTrue('非法入参 → NULL（宽/高 ≤ 0、像素缓冲不足，同旧 C 语义）',
            createBitmapFromPixels(0, nh, px) === NULL && createBitmapFromPixels(nw, nh, new ArrayBuffer(4)) === NULL)

        t.section('kernel32: 命名互斥（同名 → ERROR_ALREADY_EXISTS → Release → Close）')
        const m1 = CreateMutex(NULL, 1, 'QuickWinTestMutex')
        t.checkTrue('CreateMutex 非 0', m1 !== 0)
        if (m1 !== 0) {
            // 同名再开返回新句柄值（Windows 句柄非对象身份），判据是 last error
            const m2 = CreateMutex(NULL, 1, 'QuickWinTestMutex')
            t.check('同名对象已存在 → ERROR_ALREADY_EXISTS', 183, GetLastError())
            t.checkTrue('ReleaseMutex 成功', ReleaseMutex(m1) !== 0)
            t.checkTrue('CloseHandle(m1) 成功', CloseHandle(m1) !== 0)
            t.checkTrue('CloseHandle(m2) 成功', CloseHandle(m2) !== 0)
        }

        t.section('gdi32: 打印路径（DOCINFOW 布局 / SetBrushOrgEx 旧原点写回）')
        // 尺寸基准来自 mingw 头文件实测（x86 20 / x64 40）
        t.check('DOCINFOW.size == mingw sizeof（x86 20 / x64 40）',
            PTR_SIZE === 4 ? 20 : 40, DOCINFOW.size)
        // fwType 在 wingdi.h 是 DWORD：按 WORD 收会丢高半字（尾部 padding 让 sizeof 不变，
        // 尺寸断言抓不到），故按 32 位值往返验证
        const diProbe = DOCINFOW.encode({ cbSize: DOCINFOW.size, fwType: 0x12345678 })
        t.check('fwType 按 32 位往返（DWORD）', 0x12345678, DOCINFOW.decode(diProbe).fwType)
        const bdc = GetDC(NULL)
        if (bdc) {
            const org = POINT.alloc()
            t.checkTrue('SetBrushOrgEx 成功', SetBrushOrgEx(bdc, 17, 23, org.ptr) !== 0)
            t.check('旧原点写回 x', 0, POINT.decode(org).x)
            t.check('旧原点写回 y', 0, POINT.decode(org).y)
            t.checkTrue('SetBrushOrgEx 二次成功', SetBrushOrgEx(bdc, 5, 6, org.ptr) !== 0)
            t.check('旧原点 = 上一次设定', 17, POINT.decode(org).x)
            t.checkTrue('SetBrushOrgEx(NULL 出参) 成功', SetBrushOrgEx(bdc, 0, 0, NULL) !== 0)
            ReleaseDC(NULL, bdc)
        } else t.skipCase('GetDC(NULL) 失败')
    },
}
