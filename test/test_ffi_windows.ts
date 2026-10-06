import { Tester } from './test_helper.js'
import { NULL } from '../lib/ffi/ctype.js'
import {
    GetDesktopWindow, CreatePopupMenu, DestroyMenu, GetDC, ReleaseDC,
    LoadImage, LoadImageOrdinal, SetScrollInfo, GetScrollInfo,
} from '../lib/windows/user32.js'
import { GetDeviceCaps, CreateSolidBrush, DeleteObject, CreateFontIndirect } from '../lib/windows/gdi32.js'
import { ImageListCreate, ImageListDestroy } from '../lib/windows/comctl32.js'
import { SCROLLINFO } from '../lib/windows/structs.js'

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

        t.section('gdi32: GetDeviceCaps（<HDC>ptr 跨 user32 品牌互认）')
        const hdc = GetDC(NULL)
        t.checkTrue('GetDC(NULL) 非 0', hdc !== 0)
        if (hdc !== 0) t.checkTrue('GetDeviceCaps(hdc, LOGPIXELSX) > 0', GetDeviceCaps(hdc, 88) > 0)
        t.checkTrue('ReleaseDC(NULL, hdc) 成功', hdc !== 0 && ReleaseDC(NULL, hdc) !== 0)

        t.section('user32: 弹出菜单往返')
        const pm = CreatePopupMenu()
        t.checkTrue('CreatePopupMenu 非 0', pm !== 0)
        if (pm !== 0) t.checkTrue('DestroyMenu(pm) 成功', DestroyMenu(pm) !== 0)

        t.section('comctl32: ImageList 创建-销毁往返')
        const himl = ImageListCreate(16, 16, 4, 0, 0)   // ILC_COLOR32=4；initial/grow=0 默认
        t.checkTrue('ImageListCreate(16, 16, ILC_COLOR32) 非 0', himl !== 0)
        if (himl !== 0) t.checkTrue('ImageListDestroy(himl) 成功', ImageListDestroy(himl) !== 0)

        t.section('user32: LoadImage 双变体（string 自动编码 / ordinal MAKEINTRESOURCE）')
        // Win32 IMAGE_* 真值：BITMAP=0 CURSOR=1 ICON=2；LR_SHARED=0x8000（注意 gui.ImageType d.ts 当前值与此不一致）
        t.checkTrue('LoadImageOrdinal(0, IDI_APPLICATION, IMAGE_ICON, LR_SHARED) 非 0',
            LoadImageOrdinal(0, 32512, 2, 0, 0, 0x8000) !== 0)
        t.check('LoadImage(LOADFROMFILE, 不存在文件) → 0', 0,
            LoadImage(0, 'qw_no_such_icon_xyz.ico', 2, 0, 0, 0x10))

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
        // CallWindowProc / ShowScrollBar / ImageListAdd 仅由 import 的模块加载覆盖 proc 名：
        // CallWindowProc 跨线程窗口过程不安全、ShowScrollBar 有副作用、ImageListAdd 需位图源
    },
}
