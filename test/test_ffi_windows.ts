import { Tester } from './test_helper.js'
import {
    GetDesktopWindow, CreatePopupMenu, DestroyMenu, GetDC, ReleaseDC,
    LoadImage, LoadImageOrdinal, SetScrollInfo, GetScrollInfo,
} from '../lib/windows/user32.js'
import { GetDeviceCaps, CreateSolidBrush, DeleteObject, CreateFontIndirect } from '../lib/windows/gdi32.js'
import { ImageListCreate, ImageListDestroy } from '../lib/windows/comctl32.js'

export const suite = {
    run(t: Tester) {
        // 本文件 import 三个 dll 模块即在加载时执行全部 bind：proc 名错误 → GetProcAddress 失败 →
        // 模块加载 throw → run.ts 静默跳过本 suite → 总计数低于基线（判据链对比计数即暴露）
        t.section('gdi32: 画刷 / 字体 创建-删除往返')
        const brush = CreateSolidBrush(0x3366ff)
        t.checkTrue('CreateSolidBrush 非 null', brush !== null)
        if (brush !== null) t.checkTrue('DeleteObject(brush) 成功', DeleteObject(brush) !== 0)

        const lf = new ArrayBuffer(92)   // LOGFONTW：布局 ia32/x64 相同
        const lfd = new DataView(lf)
        lfd.setInt32(0, -16, true)       // lfHeight
        lfd.setInt32(16, 400, true)      // lfWeight = FW_NORMAL
        lfd.setUint8(23, 1)              // lfCharSet = DEFAULT_CHARSET
        const face = 'Arial'
        for (let i = 0; i < face.length; i++) lfd.setUint16(28 + i * 2, face.charCodeAt(i), true)
        const font = CreateFontIndirect(lf)
        t.checkTrue('CreateFontIndirect(LOGFONTW) 非 null', font !== null)
        if (font !== null) t.checkTrue('DeleteObject(font) 成功', DeleteObject(font) !== 0)

        t.section('gdi32: GetDeviceCaps（<HDC>ptr 跨 user32 品牌互认）')
        const hdc = GetDC(null)
        t.checkTrue('GetDC(null) 非 null', hdc !== null)
        if (hdc !== null) t.checkTrue('GetDeviceCaps(hdc, LOGPIXELSX) > 0', GetDeviceCaps(hdc, 88) > 0)
        t.checkTrue('ReleaseDC(null, hdc) 成功', hdc !== null && ReleaseDC(null, hdc) !== 0)

        t.section('user32: 弹出菜单往返')
        const pm = CreatePopupMenu()
        t.checkTrue('CreatePopupMenu 非 null', pm !== null)
        if (pm !== null) t.checkTrue('DestroyMenu(pm) 成功', DestroyMenu(pm) !== 0)

        t.section('comctl32: ImageList 创建-销毁往返')
        const himl = ImageListCreate(16, 16, 4, 0, 0)   // ILC_COLOR32=4；initial/grow=0 默认
        t.checkTrue('ImageListCreate(16, 16, ILC_COLOR32) 非 null', himl !== null)
        if (himl !== null) t.checkTrue('ImageListDestroy(himl) 成功', ImageListDestroy(himl) !== 0)

        t.section('user32: LoadImage 双变体（string 自动编码 / ordinal MAKEINTRESOURCE）')
        // Win32 IMAGE_* 真值：BITMAP=0 CURSOR=1 ICON=2；LR_SHARED=0x8000（注意 gui.ImageType d.ts 当前值与此不一致）
        t.checkTrue('LoadImageOrdinal(0, IDI_APPLICATION, IMAGE_ICON, LR_SHARED) 非 null',
            LoadImageOrdinal(0, 32512, 2, 0, 0, 0x8000) !== null)
        t.check('LoadImage(LOADFROMFILE, 不存在文件) → null', null,
            LoadImage(0, 'qw_no_such_icon_xyz.ico', 2, 0, 0, 0x10))

        t.section('user32: 滚动条（SCROLLINFO 28 字节 buffer）')
        const desk = GetDesktopWindow()
        const siBuf = new ArrayBuffer(28)
        const sid = new DataView(siBuf)
        sid.setUint32(0, 28, true)      // cbSize
        sid.setUint32(4, 0x0001, true)  // fMask = SIF_RANGE
        sid.setInt32(8, 0, true)        // nMin
        sid.setInt32(12, 100, true)     // nMax
        t.checkTrue('SetScrollInfo(desktop, SB_VERT) 形态 number',
            typeof SetScrollInfo(desk, 1, siBuf, 0) === 'number')
        t.checkTrue('GetScrollInfo(desktop, SB_VERT) 形态 number',
            typeof GetScrollInfo(desk, 1, siBuf) === 'number')
        // CallWindowProc / ShowScrollBar / ImageListAdd 仅由 import 的模块加载覆盖 proc 名：
        // CallWindowProc 跨线程窗口过程不安全、ShowScrollBar 有副作用、ImageListAdd 需位图源
    },
}
