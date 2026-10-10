import { Tester } from './test_helper.js'
import * as gui from 'gui'
import { NULL, PtrArrayBuffer, type Ptr } from '../lib/ffi/ctype.js'
import { FrameRect, GetDC, InvertRect, ReleaseDC } from '../lib/windows/user32.js'
import {
    Arc, Chord, CreateBitmap, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontIndirect,
    CreateHatchBrush, CreatePatternBrush, CreatePen, CreateSolidBrush, DeleteDC,
    DeleteObject, Ellipse, ExtTextOut, GetArcDirection, GetDIBits, GetStockObject,
    GetStretchBltMode, GetTextExtentPoint32, GetTextMetrics, LineTo, MaskBlt, MoveToEx,
    PatBlt, Pie, PlgBlt, Polygon, Polyline, Rectangle, RestoreDC, RoundRect, SaveDC,
    SelectObject, SetArcDirection, SetBkColor, SetBkMode, SetDIBitsToDevice,
    SetPolyFillMode, SetROP2,
    SetStretchBltMode, SetTextAlign, SetTextColor, TextOut, StretchBlt, StretchDIBits,
} from '../lib/windows/gdi32.js'
import { TransparentBlt } from '../lib/windows/msimg32.js'
import { BITMAPINFOHEADER, POINT, SIZE, TEXTMETRICW } from '../lib/windows/structs.js'

// 像素比较统一用 COLORREF 形（0x00BBGGRR）—— 与画图入参同形，读回直接对比。
const RED = 0x000000ff
const GREEN = 0x0000ff00
const BLUE = 0x00ff0000
const WHITE = 0x00ffffff
const BLACK = 0x00000000
const W = 320
const H = 240

export const suite = {
    name: 'gdi-draw',
    run: (t: Tester) => {
        // —— 基座：屏幕 DC → 内存 DC + 32bpp 位图（与 exec_server_worker 截屏同型）——
        t.section('setup: memory DC + 32bpp bitmap')
        const screen = GetDC(NULL)
        const mem = CreateCompatibleDC(screen)
        const bmp = screen ? CreateCompatibleBitmap(screen, W, H) : 0
        if (!screen || !mem || !bmp) {
            t.checkTrue('GDI setup (GetDC / CreateCompatibleDC / CreateCompatibleBitmap)', false)
            return
        }
        const oldBmp = SelectObject(mem, bmp)
        const pxB = new PtrArrayBuffer(W * H * 4)
        const pxU8 = new Uint8Array(pxB)
        const bmi = BITMAPINFOHEADER.encode({
            biSize: BITMAPINFOHEADER.size,
            biWidth: W,
            biHeight: -H,                // 负 = 顶向下
            biPlanes: 1,
            biBitCount: 32,
            biSizeImage: W * H * 4,
        })
        // 读回当前位图像素（emitDib 同模式：32bpp BI_RGB = [B,G,R,x] 字节序）。
        // 失败置哨兵（px() 返回 -1）—— 像素断言 FAIL 出可诊断值，不炸整个 suite。
        let pxOk = true
        const readPx = (): void => {
            pxOk = GetDIBits(mem, bmp, 0, H, pxB, bmi.ptr, 0) === H
        }
        const px = (x: number, y: number): number => {
            if (!pxOk) return -1
            const i = (y * W + x) * 4
            return (pxU8[i]! << 16) | (pxU8[i + 1]! << 8) | pxU8[i + 2]!   // B,G,R → COLORREF
        }
        const clearWhite = (): void => {
            PatBlt(mem, 0, 0, W, H, gui.RasterOp.WHITENESS)   // 与画刷无关的整白
            readPx()
        }
        clearWhite()
        t.check('baseline = white', WHITE, px(5, 5))
        t.checkTrue('GetDIBits full read', pxOk)

        t.section('state: return-previous semantics')
        t.check('fresh DC default bkMode = OPAQUE',
            gui.BackgroundMode.OPAQUE, SetBkMode(mem, gui.BackgroundMode.OPAQUE))
        t.check('SetBkMode returns previous', gui.BackgroundMode.OPAQUE,
            SetBkMode(mem, gui.BackgroundMode.TRANSPARENT))
        SetBkMode(mem, gui.BackgroundMode.OPAQUE)
        SetTextColor(mem, RED)                                    // 返回默认色（不假设）
        t.check('SetTextColor returns previous', RED, SetTextColor(mem, BLUE))
        SetTextColor(mem, 0)
        SetBkColor(mem, RED)
        t.check('SetBkColor returns previous', RED, SetBkColor(mem, WHITE))

        t.section('type layer: enum nominal + position forms')
        // 类型专用块（只过 tsc、不执行）
        const typeOnly: unknown = () => {
            // @ts-expect-error 跨枚举 nominal：BackgroundMode 成员进不了 PenStyle 位
            CreatePen(gui.BackgroundMode.TRANSPARENT, 1, 0)
            // @ts-expect-error '<HDC>ptr!' 禁空位不收 NULL
            Rectangle(NULL, 0, 0, 1, 1)
            // @ts-expect-error <POINT*>ptr 数组位不收裸对象（单对象对 C 是越界基址）
            Polyline(0 as Ptr<'HDC'>, { x: 1, y: 2 }, 1)
            // @ts-expect-error MoveToEx 出参位刻意不注册 encoder：只收 .ptr / NULL，不收对象形
            MoveToEx(0 as Ptr<'HDC'>, 0, 0, { x: 1, y: 2 })
            // @ts-expect-error <WCHAR>ptr 文本位收 string / NULL，不收裸数字
            TextOut(0 as Ptr<'HDC'>, 0, 0, 123, 1)
            // @ts-expect-error 跨枚举 nominal：PenStyle 成员进不了 StockObject 位
            GetStockObject(gui.PenStyle.SOLID)
            // @ts-expect-error 跨枚举 nominal：HatchStyle 成员进不了 PolyFillMode 位
            SetPolyFillMode(0 as Ptr<'HDC'>, gui.HatchStyle.CROSS)
            // @ts-expect-error u32@RasterOp 标注拦枚举外光栅码（字面量不匹配成员值）
            PatBlt(0 as Ptr<'HDC'>, 0, 0, 1, 1, 0x123456)
            // @ts-expect-error '<SIZE>ptr!' 出参位不收 NULL
            GetTextExtentPoint32(0 as Ptr<'HDC'>, 'x', 1, NULL)
            // @ts-expect-error 跨枚举 nominal：StretchBltMode 成员进不了 ArcDirection 位
            SetArcDirection(0 as Ptr<'HDC'>, gui.StretchBltMode.HALFTONE)
        }
        t.checkTrue('type-only block wired', typeof typeOnly === 'function')

        t.section('SaveDC/RestoreDC: state stack rollback')
        // 先定基态（断言不依赖前面 section 的收尾值）
        SetTextColor(mem, 0)
        SetBkMode(mem, gui.BackgroundMode.OPAQUE)
        SetBkColor(mem, WHITE)
        const saved = SaveDC(mem)
        t.checkTrue(`SaveDC state id ≠ 0 (${saved})`, saved !== 0)
        // 打乱：三项绘图状态 + 换一支笔
        SetTextColor(mem, RED)
        SetBkMode(mem, gui.BackgroundMode.TRANSPARENT)
        SetBkColor(mem, BLUE)
        const junkPen = CreatePen(gui.PenStyle.DASH, 1, GREEN)
        SelectObject(mem, junkPen)
        t.checkTrue('RestoreDC ok', RestoreDC(mem, saved) !== 0)
        DeleteObject(junkPen)                    // 恢复后已卸下，可安全删
        // 逐项回滚断言：各 Set 返回的就是回滚后的当前值
        t.check('text color rolled back', 0, SetTextColor(mem, RED))
        SetTextColor(mem, 0)
        t.check('bkMode rolled back', gui.BackgroundMode.OPAQUE,
            SetBkMode(mem, gui.BackgroundMode.TRANSPARENT))
        SetBkMode(mem, gui.BackgroundMode.OPAQUE)
        t.check('bkColor rolled back', WHITE, SetBkColor(mem, RED))
        SetBkColor(mem, WHITE)

        t.section('Rectangle: brush fill (inside/outside pixels)')
        clearWhite()
        const brush = CreateSolidBrush(RED)
        t.checkTrue('brush created', !!brush)
        const oldBrush = SelectObject(mem, brush)
        Rectangle(mem, 10, 10, 50, 30)
        readPx()
        t.check('inside = red', RED, px(20, 20))
        t.check('outside left-top = white', WHITE, px(9, 9))
        t.check('outside right-bottom = white', WHITE, px(60, 40))
        SelectObject(mem, oldBrush)
        DeleteObject(brush)

        t.section('Polyline: <POINT*>ptr position + empty array → NULL')
        clearWhite()
        const pen = CreatePen(gui.PenStyle.SOLID, 1, GREEN)
        t.checkTrue('pen created', !!pen)
        const oldPen = SelectObject(mem, pen)
        t.checkTrue('Polyline success',
            Polyline(mem, [{ x: 0, y: 100 }, { x: 100, y: 100 }], 2) !== 0)
        readPx()
        t.check('on-line = green', GREEN, px(50, 100))
        t.check('row above = white', WHITE, px(50, 99))
        t.check('row below = white', WHITE, px(50, 101))
        // 空数组 → 引擎单点确定性编 NULL（0 元素 = 缓冲不存在），C 拒收返回 0 ——
        // 若走 PAB(0)（非 0 的 1 字节堆指针）GDI 不会因 NULL 失败。
        t.check('empty array encodes NULL (C returns 0)', 0, Polyline(mem, [], 0))

        t.section('MoveToEx/LineTo: out-param + line pixels')
        t.checkTrue('MoveToEx NULL lppt ok', MoveToEx(mem, 10, 10, NULL) !== 0)
        t.checkTrue('LineTo ok', LineTo(mem, 10, 50) !== 0)   // 竖线，不含端点 → 行 10..49
        readPx()
        t.check('on-line = green', GREEN, px(10, 30))
        t.check('col-1 = white', WHITE, px(9, 30))
        t.check('col+1 = white', WHITE, px(11, 30))
        // 当前位置现为 (10,50)：MoveToEx 落新位 (77,88)，旧位置写进出参（.ptr 直通通路）
        const prev = POINT.alloc()
        t.checkTrue('MoveToEx out slot ok', MoveToEx(mem, 77, 88, prev.ptr) !== 0)
        const oldPos = POINT.decode(prev.ptr)
        t.check('MoveToEx out.x', 10, oldPos.x)
        t.check('MoveToEx out.y', 50, oldPos.y)
        LineTo(mem, 77, 120)                                     // 从 (77,88) 起画 → 列 77
        readPx()
        t.check('current position moved', GREEN, px(77, 100))
        SelectObject(mem, oldPen)
        DeleteObject(pen)

        t.section('SetROP2: R2_XORPEN reversible')
        PatBlt(mem, 0, 0, W, H, gui.RasterOp.BLACKNESS)     // 黑底：黑^绿=绿，绿^绿=黑
        t.check('default raster mode = R2_COPYPEN', gui.RasterMode.R2_COPYPEN,
            SetROP2(mem, gui.RasterMode.R2_XORPEN))         // 返回旧值 = 默认，同时设为 XOR
        const xorPen = CreatePen(gui.PenStyle.SOLID, 1, GREEN)
        const xorOld = SelectObject(mem, xorPen)
        MoveToEx(mem, 10, 200, NULL)
        LineTo(mem, 100, 200)
        readPx()
        t.check('first pass = green (black XOR green)', GREEN, px(50, 200))
        MoveToEx(mem, 10, 200, NULL)
        LineTo(mem, 100, 200)                             // 同路径重画 → XOR 抵消
        readPx()
        t.check('second pass cancels back to black', BLACK, px(50, 200))
        SelectObject(mem, xorOld)
        DeleteObject(xorPen)
        SetROP2(mem, gui.RasterMode.R2_COPYPEN)           // 恢复

        t.section('Polygon: fill + outline (auto-close)')
        clearWhite()
        const pBrush = CreateSolidBrush(BLUE)
        const oldPB = SelectObject(mem, pBrush)
        t.checkTrue('Polygon success',
            Polygon(mem, [{ x: 200, y: 20 }, { x: 260, y: 20 }, { x: 230, y: 70 }], 3) !== 0)
        readPx()
        t.check('inside triangle = blue', BLUE, px(230, 40))
        t.check('above triangle = white', WHITE, px(230, 10))
        t.check('left of triangle = white', WHITE, px(180, 40))
        SelectObject(mem, oldPB)
        DeleteObject(pBrush)

        t.section('Ellipse / RoundRect: fill')
        clearWhite()
        const sBrush = CreateSolidBrush(RED)
        const oldSB = SelectObject(mem, sBrush)
        Ellipse(mem, 100, 100, 140, 140)
        readPx()
        t.check('ellipse center = red', RED, px(120, 120))
        t.check('ellipse corner = white', WHITE, px(101, 101))
        RoundRect(mem, 200, 100, 240, 140, 10, 10)
        readPx()
        t.check('roundrect center = red', RED, px(220, 120))
        t.check('rounded corner cut = white', WHITE, px(201, 101))
        SelectObject(mem, oldSB)
        DeleteObject(sBrush)

        t.section('Arc/Chord/Pie: angular shapes')
        // 圆 (100,100)-(200,200) 心 (150,150) r=50；起 12 点 (150,100) → 终 9 点 (100,150)：
        // GDI 默认逆时针 12→11→10→9 = 左上 90° 弧（SetArcDirection 可改，见 MSDN Arc）
        clearWhite()
        const arcPen = CreatePen(gui.PenStyle.SOLID, 1, RED)
        const arcOldPen = SelectObject(mem, arcPen)
        Arc(mem, 100, 100, 200, 200, 150, 100, 100, 150)
        readPx()
        let arcRed = 0                                  // 扫圆环带（圆心距 48..52）数红 = 弧存在
        for (let y = 98; y < 203; y++) {
            for (let x = 98; x < 203; x++) {
                const dx = x - 150
                const dy = y - 150
                const d2 = dx * dx + dy * dy
                if (d2 >= 48 * 48 && d2 <= 52 * 52 && px(x, y) === RED) arcRed++
            }
        }
        t.checkTrue(`arc ring pixels (${arcRed})`, arcRed > 20)
        t.check('arc interior untouched', WHITE, px(150, 150))
        SelectObject(mem, arcOldPen)
        DeleteObject(arcPen)

        clearWhite()
        const pieBrush = CreateSolidBrush(RED)
        const pieOldB = SelectObject(mem, pieBrush)
        Pie(mem, 100, 100, 200, 200, 150, 100, 100, 150)
        readPx()
        t.check('pie sector filled near apex', RED, px(140, 140)) // 45° 夹角内部（顶点 (150,150)
        t.check('pie swept quadrant filled', RED, px(118, 128))   // 恰在半径边界行上不填——挪开）
        t.check('pie opposite side empty', WHITE, px(180, 180))
        SelectObject(mem, pieOldB)
        DeleteObject(pieBrush)

        clearWhite()
        const chBrush = CreateSolidBrush(RED)
        const chOldB = SelectObject(mem, chBrush)
        Chord(mem, 100, 100, 200, 200, 150, 100, 100, 150)
        readPx()
        // 弦 (150,100)-(100,150)：直线 x+y=250；左上小弧侧 = x+y < 250 一侧
        t.check('chord band filled (arc side)', RED, px(118, 128))  // 246 < 250、圆内
        t.check('chord excludes center side', WHITE, px(150, 150))  // 300 > 250 → 弦另一侧
        SelectObject(mem, chOldB)
        DeleteObject(chBrush)

        t.section('SetArcDirection/GetArcDirection: sweep flip')
        clearWhite()
        const dirBrush = CreateSolidBrush(RED)
        const dirOldB = SelectObject(mem, dirBrush)
        t.check('default arc direction = counterclockwise', gui.ArcDirection.COUNTERCLOCKWISE,
            GetArcDirection(mem))
        t.check('SetArcDirection returns previous', gui.ArcDirection.COUNTERCLOCKWISE,
            SetArcDirection(mem, gui.ArcDirection.CLOCKWISE))
        Pie(mem, 100, 100, 200, 200, 150, 100, 100, 150)          // 起 12 点终 9 点：顺时针 → 右下 270°
        readPx()
        t.check('clockwise sweep fills opposite side', RED, px(180, 180))
        t.check('clockwise sweep skips upper-left', WHITE, px(118, 128))
        SetArcDirection(mem, gui.ArcDirection.COUNTERCLOCKWISE)    // 恢复默认
        SelectObject(mem, dirOldB)
        DeleteObject(dirBrush)

        t.section('SetPolyFillMode: ALTERNATE vs WINDING (pentagram)')
        clearWhite()
        // 5 外顶点按 {5/2} 跳连（P0→P2→P4→P1→P3）= 真自相交五角星
        const V: { x: number, y: number }[] = []
        for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5
            V.push({ x: Math.round(150 + 55 * Math.cos(a)), y: Math.round(150 + 55 * Math.sin(a)) })
        }
        const star = [V[0]!, V[2]!, V[4]!, V[1]!, V[3]!]
        t.check('default fill mode = ALTERNATE', gui.PolyFillMode.ALTERNATE,
            SetPolyFillMode(mem, gui.PolyFillMode.ALTERNATE))
        const starBrush = CreateSolidBrush(RED)
        const starOldB = SelectObject(mem, starBrush)
        Polygon(mem, star, 5)
        readPx()
        let starRed = 0
        for (let y = 90; y < 210; y++) {
            for (let x = 90; x < 210; x++) {
                if (px(x, y) === RED) starRed++
            }
        }
        t.checkTrue(`ALTERNATE: star drawn (${starRed}px)`, starRed > 200)
        t.check('ALTERNATE: center hollow (even-odd)', WHITE, px(150, 150))
        SetPolyFillMode(mem, gui.PolyFillMode.WINDING)
        clearWhite()
        Polygon(mem, star, 5)
        readPx()
        t.check('WINDING: center filled (nonzero)', RED, px(150, 150))
        SelectObject(mem, starOldB)
        DeleteObject(starBrush)
        SetPolyFillMode(mem, gui.PolyFillMode.ALTERNATE)   // 恢复默认

        t.section('GetStockObject: stock objects, outline-only shape')
        clearWhite()
        const hollow = GetStockObject(gui.StockObject.NULL_BRUSH)
        const stkPen = GetStockObject(gui.StockObject.BLACK_PEN)
        t.checkTrue(`stock handles non-zero (0x${hollow.toString(16)}, 0x${stkPen.toString(16)})`,
            hollow !== 0 && stkPen !== 0)
        const stockOldBrush = SelectObject(mem, hollow)
        const stockOldPen = SelectObject(mem, stkPen)
        Rectangle(mem, 100, 100, 150, 140)          // NULL_BRUSH → 只描边不填充
        readPx()
        let innerNz = 0                              // 内部远离边线，应全白
        for (let y = 105; y < 135; y++) {
            for (let x = 105; x < 145; x++) {
                if (px(x, y) !== WHITE) innerNz++
            }
        }
        t.check('outline-only: interior untouched', 0, innerNz)
        // 边界带扫描黑像素（不猜具体哪列——右/下边的 off-by-one 交给扫描容错）
        let edgeBlack = 0
        for (let y = 100; y < 140; y++) {
            for (let x = 100; x < 150; x++) {
                if ((x === 100 || y === 100 || x === 149 || y === 139) && px(x, y) === BLACK) edgeBlack++
            }
        }
        t.checkTrue(`stock pen outline drawn (${edgeBlack}px)`, edgeBlack > 20)
        SelectObject(mem, stockOldBrush)
        SelectObject(mem, stockOldPen)
        // stock 对象是系统共享的，不 DeleteObject

        t.section('CreateHatchBrush: textured fill')
        clearWhite()
        SetBkMode(mem, gui.BackgroundMode.TRANSPARENT)      // 间隙透底 = 白
        const hatch = CreateHatchBrush(gui.HatchStyle.HORIZONTAL, RED)
        t.checkTrue('hatch brush created', hatch !== 0)
        const hatchOldB = SelectObject(mem, hatch)
        Rectangle(mem, 20, 20, 120, 60)
        readPx()
        let hRed = 0
        let hWhite = 0
        let hOther = 0
        for (let y = 30; y < 50; y++) {
            for (let x = 30; x < 110; x++) {
                const c = px(x, y)
                if (c === RED) hRed++
                else if (c === WHITE) hWhite++
                else hOther++
            }
        }
        t.checkTrue(`hatch lines present (red=${hRed})`, hRed > 50)
        t.checkTrue(`transparent gaps (white=${hWhite})`, hWhite > 50)
        t.check('no other colors in hatch', 0, hOther)
        SelectObject(mem, hatchOldB)
        DeleteObject(hatch)
        SetBkMode(mem, gui.BackgroundMode.OPAQUE)

        t.section('FrameRect/InvertRect: border and invert (user32)')
        clearWhite()
        const frBrush = CreateSolidBrush(RED)
        FrameRect(mem, { left: 10, top: 10, right: 50, bottom: 40 }, frBrush)
        readPx()
        t.check('frame top edge red', RED, px(30, 10))
        t.check('frame left edge red', RED, px(10, 25))
        t.check('frame interior white', WHITE, px(30, 25))
        DeleteObject(frBrush)

        clearWhite()
        InvertRect(mem, { left: 20, top: 20, right: 60, bottom: 50 })
        readPx()
        t.check('invert white to black', BLACK, px(40, 35))
        t.check('outside rect untouched', WHITE, px(5, 5))
        InvertRect(mem, { left: 20, top: 20, right: 60, bottom: 50 })   // 再反一次可逆
        readPx()
        t.check('second invert restores white', WHITE, px(40, 35))

        t.section('StretchBlt: scaled copy + mode roundtrip')
        clearWhite()
        const stTmp = CreateCompatibleDC(mem)
        if (!stTmp) {
            t.checkTrue('CreateCompatibleDC (stretch source)', false)
            return
        }
        const stBmp = CreateCompatibleBitmap(mem, 4, 4)
        const stOldBmp = SelectObject(stTmp, stBmp)
        const stFill = CreateSolidBrush(RED)
        SelectObject(stTmp, stFill)
        PatBlt(stTmp, 0, 0, 4, 4, gui.RasterOp.PATCOPY)              // 源 4×4 全红
        t.checkTrue('StretchBlt ok',
            StretchBlt(mem, 10, 10, 40, 40, stTmp, 0, 0, 4, 4, gui.RasterOp.SRCCOPY) !== 0)
        readPx()
        t.check('scaled center red', RED, px(30, 30))
        t.check('scaled near-origin red', RED, px(11, 11))
        t.check('outside target untouched', WHITE, px(60, 30))
        const stMode0 = GetStretchBltMode(mem)
        t.check('SetStretchBltMode returns current', stMode0,
            SetStretchBltMode(mem, gui.StretchBltMode.HALFTONE))
        t.check('GetStretchBltMode = HALFTONE', gui.StretchBltMode.HALFTONE, GetStretchBltMode(mem))
        SelectObject(stTmp, stOldBmp)
        DeleteObject(stFill)
        DeleteObject(stBmp)
        DeleteDC(stTmp)

        t.section('CreatePatternBrush: tiled bitmap fill')
        clearWhite()
        const pkTmp = CreateCompatibleDC(mem)
        if (!pkTmp) {
            t.checkTrue('CreateCompatibleDC (pattern source)', false)
            return
        }
        const pkBmp = CreateCompatibleBitmap(mem, 4, 4)
        const pkOldBmp = SelectObject(pkTmp, pkBmp)
        const pkRed = CreateSolidBrush(RED)
        SelectObject(pkTmp, pkRed)
        PatBlt(pkTmp, 0, 0, 4, 4, gui.RasterOp.PATCOPY)              // 红底
        const pkWhite = CreateSolidBrush(WHITE)
        SelectObject(pkTmp, pkWhite)
        PatBlt(pkTmp, 2, 0, 2, 2, gui.RasterOp.PATCOPY)              // 挖两白角 = 2×2 棋盘
        PatBlt(pkTmp, 0, 2, 2, 2, gui.RasterOp.PATCOPY)
        SelectObject(pkTmp, pkOldBmp)                                // 位图退出选入状态
        const pkPat = CreatePatternBrush(pkBmp)
        t.checkTrue('pattern brush created', pkPat !== 0)
        const pkPatOld = SelectObject(mem, pkPat)
        Rectangle(mem, 20, 20, 120, 120)
        readPx()
        t.check('tile (0,0) cell red', RED, px(24, 24))              // 平铺按 (x%4, y%4) 棋盘
        t.check('tile (2,0) cell white', WHITE, px(26, 24))
        t.check('tile (0,2) cell white', WHITE, px(24, 26))
        t.check('tile (2,2) cell red', RED, px(26, 26))
        t.check('tiled far cell red (25 cycles)', RED, px(100, 100)) // 100%4=0
        SelectObject(mem, pkPatOld)
        DeleteObject(pkPat)
        DeleteObject(pkBmp)
        DeleteObject(pkRed)
        DeleteObject(pkWhite)
        DeleteDC(pkTmp)

        t.section('SetDIBitsToDevice/StretchDIBits: raw DIB buffer blit')
        clearWhite()
        // 4×4 RGBA 缓冲：上 2 行红、下 2 行蓝（biHeight<0 顶向下——专测行序不颠倒）
        const dibBits = new PtrArrayBuffer(4 * 4 * 4)
        const dibU8 = new Uint8Array(dibBits)
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const i = (y * 4 + x) * 4                    // 32bpp BI_RGB = [B,G,R,x]
                dibU8[i] = y < 2 ? 0 : 255                   // B：下半蓝
                dibU8[i + 1] = 0
                dibU8[i + 2] = y < 2 ? 255 : 0               // R：上半红
            }
        }
        const dibBmi = BITMAPINFOHEADER.encode({
            biSize: BITMAPINFOHEADER.size, biWidth: 4, biHeight: -4,
            biPlanes: 1, biBitCount: 32, biSizeImage: 4 * 4 * 4,
        })
        t.checkTrue('SetDIBitsToDevice ok',
            SetDIBitsToDevice(mem, 20, 20, 4, 4, 0, 0, 0, 4, dibBits, dibBmi, 0) === 4)
        readPx()
        t.check('dib top rows red (top-down)', RED, px(21, 21))
        t.check('dib bottom rows blue', BLUE, px(21, 23))
        t.check('dib outside untouched', WHITE, px(30, 21))
        clearWhite()
        t.checkTrue('StretchDIBits ok',
            StretchDIBits(mem, 20, 20, 40, 40, 0, 0, 4, 4, dibBits, dibBmi, 0,
                gui.RasterOp.SRCCOPY) === 4)
        readPx()
        t.check('stretched top half red', RED, px(40, 30))
        t.check('stretched bottom half blue', BLUE, px(40, 50))
        t.check('stretched outside untouched', WHITE, px(65, 30))

        t.section('PlgBlt: parallelogram mapping')
        clearWhite()
        const plgTmp = CreateCompatibleDC(mem)
        if (!plgTmp) { t.checkTrue('CreateCompatibleDC (plg src)', false); return }
        const plgBmp = CreateCompatibleBitmap(mem, 40, 40)
        const plgOldB = SelectObject(plgTmp, plgBmp)
        const plgRed = CreateSolidBrush(RED)
        SelectObject(plgTmp, plgRed)
        PatBlt(plgTmp, 0, 0, 40, 40, gui.RasterOp.PATCOPY)      // 源 40×40 全红
        // 三点 TL(40,60) TR(160,60) BL(70,160) → 方向 s(120,0)+t(30,100)，中心 (115,110)
        t.checkTrue('PlgBlt ok',
            PlgBlt(mem, [{ x: 40, y: 60 }, { x: 160, y: 60 }, { x: 70, y: 160 }],
                plgTmp, 0, 0, 40, 40, NULL, 0, 0) !== 0)
        readPx()
        t.check('parallelogram center red', RED, px(115, 110))
        t.check('left of slanted edge white', WHITE, px(40, 160))
        SelectObject(plgTmp, plgOldB)
        DeleteObject(plgRed)
        DeleteObject(plgBmp)
        DeleteDC(plgTmp)

        t.section('CreateBitmap + MaskBlt: monochrome row mask')
        clearWhite()
        const mkTmp = CreateCompatibleDC(mem)
        if (!mkTmp) { t.checkTrue('CreateCompatibleDC (mask src)', false); return }
        const mkBmp = CreateCompatibleBitmap(mem, 4, 4)
        const mkOldB = SelectObject(mkTmp, mkBmp)
        const mkRed = CreateSolidBrush(RED)
        SelectObject(mkTmp, mkRed)
        PatBlt(mkTmp, 0, 0, 4, 4, gui.RasterOp.PATCOPY)         // 源 4×4 全红
        // 1bpp 掩码 4×4：行按 word(2B) 对齐（CreateBitmap 惯例，非 DIB 的 4B）——
        // 行 0/2 = 0xFF（白）、行 1/3 = 0x00（黑）
        const mkBits = new PtrArrayBuffer(8)
        const mkU8 = new Uint8Array(mkBits)
        mkU8[0] = 0xFF
        mkU8[4] = 0xFF
        const mask = CreateBitmap(4, 4, 1, 1, mkBits)
        t.checkTrue('CreateBitmap(1bpp) ok', mask !== 0)
        PatBlt(mem, 30, 30, 4, 4, gui.RasterOp.BLACKNESS)       // 目标底黑 → back 白可辨
        // MAKEROP4(fore=SRCCOPY 取源, back=WHITENESS 画白)：back 码在 bit31..24、fore 在 bit23..16
        const rop4 = (((gui.RasterOp.WHITENESS << 8) & 0xFF000000) | gui.RasterOp.SRCCOPY) >>> 0
        t.checkTrue('MaskBlt ok',
            MaskBlt(mem, 30, 30, 4, 4, mkTmp, 0, 0, mask, 0, 0, rop4) !== 0)
        readPx()
        t.check('mask row0 = fore (red)', RED, px(31, 30))
        t.check('mask row1 = back (white)', WHITE, px(31, 31))
        t.check('mask row2 = fore (red)', RED, px(31, 32))
        t.check('mask row3 = back (white)', WHITE, px(31, 33))
        SelectObject(mkTmp, mkOldB)
        DeleteObject(mask)
        DeleteObject(mkRed)
        DeleteObject(mkBmp)
        DeleteDC(mkTmp)

        t.section('TransparentBlt: color-key transparency (msimg32)')
        clearWhite()
        const trTmp = CreateCompatibleDC(mem)
        if (!trTmp) { t.checkTrue('CreateCompatibleDC (tr src)', false); return }
        const trBmp = CreateCompatibleBitmap(mem, 40, 16)
        const trOldB = SelectObject(trTmp, trBmp)
        const trRed = CreateSolidBrush(RED)
        SelectObject(trTmp, trRed)
        PatBlt(trTmp, 0, 0, 20, 16, gui.RasterOp.PATCOPY)       // 左半红
        const trBlue = CreateSolidBrush(BLUE)
        SelectObject(trTmp, trBlue)
        PatBlt(trTmp, 20, 0, 20, 16, gui.RasterOp.PATCOPY)      // 右半蓝 = 键色
        t.checkTrue('TransparentBlt ok',
            TransparentBlt(mem, 20, 20, 40, 16, trTmp, 0, 0, 40, 16, BLUE) !== 0)
        readPx()
        t.check('non-key pixels copied (red)', RED, px(25, 25))
        t.check('key pixels transparent (white shows through)', WHITE, px(55, 25))
        SelectObject(trTmp, trOldB)
        DeleteObject(trRed)
        DeleteObject(trBlue)
        DeleteObject(trBmp)
        DeleteDC(trTmp)

        t.section('TextOut: transparent background + text color')
        clearWhite()
        SetBkColor(mem, BLUE)        // 衬底设蓝：若 TRANSPARENT 未生效，字底必现蓝块
        SetBkMode(mem, gui.BackgroundMode.TRANSPARENT)
        SetTextColor(mem, RED)
        t.checkTrue('TextOut success', TextOut(mem, 20, 100, 'Hello GDI', 9) !== 0)
        readPx()
        let redPx = 0
        let bluePx = 0
        // 扫描框放宽：对齐默认形（TA_TOP 或 TA_BASELINE）都能罩住字形
        for (let y = 84; y < 124; y++) {
            for (let x = 16; x < 150; x++) {
                const c = px(x, y)
                if (c === RED) redPx++
                else if (c === BLUE) bluePx++
            }
        }
        t.checkTrue(`glyph pixels rendered (red=${redPx})`, redPx > 20)
        t.checkTrue(`transparent bg: zero blue backdrop (blue=${bluePx})`, bluePx === 0)
        SetBkMode(mem, gui.BackgroundMode.OPAQUE)
        SetBkColor(mem, WHITE)
        SetTextColor(mem, 0)

        t.section('text metrics/align: extent + SetTextAlign + ExtTextOut')
        clearWhite()
        // (a) 量字：出参 SIZE（alloc().ptr 进、decode 出）
        const sz = SIZE.alloc()
        t.checkTrue('GetTextExtentPoint32 ok',
            GetTextExtentPoint32(mem, 'Hello GDI', 9, sz.ptr) !== 0)
        const ext = SIZE.decode(sz.ptr)
        t.checkTrue(`extent cx sane (${ext.cx})`, (ext.cx ?? 0) >= 30 && (ext.cx ?? 0) <= 300)
        t.checkTrue(`extent cy sane (${ext.cy})`, (ext.cy ?? 0) >= 8 && (ext.cy ?? 0) <= 64)

        // (b) 行高度量（出参 TEXTMETRICW，与 (a) 同一默认字体）
        const tmSlot = TEXTMETRICW.alloc()
        t.checkTrue('GetTextMetrics ok', GetTextMetrics(mem, tmSlot.ptr) !== 0)
        const tmv = TEXTMETRICW.decode(tmSlot.ptr)
        t.checkTrue(`tmHeight sane (${tmv.tmHeight})`,
            (tmv.tmHeight ?? 0) >= 8 && (tmv.tmHeight ?? 0) <= 64)
        t.checkTrue(`tmAscent/descent sane (${tmv.tmAscent}/${tmv.tmDescent})`,
            (tmv.tmAscent ?? 0) > 0 && (tmv.tmDescent ?? 0) >= 0)
        t.checkTrue(`tmAveCharWidth sane (${tmv.tmAveCharWidth})`,
            (tmv.tmAveCharWidth ?? 0) >= 4 && (tmv.tmAveCharWidth ?? 0) <= 48)

        // (c) SetTextAlign 右对齐：字形全部落在锚点左侧
        SetTextColor(mem, RED)
        t.check('default align = 0 (LEFT|TOP|NOUPDATECP)', 0,
            SetTextAlign(mem, gui.TextAlign.TA_RIGHT))
        TextOut(mem, 200, 100, 'Right', 5)
        readPx()
        let rRight = 0
        let rWrong = 0
        for (let y = 96; y < 116; y++) {
            for (let x = 140; x < 260; x++) {
                const c = px(x, y)
                if (c === RED) {
                    if (x < 200) rRight++
                    else if (x > 200) rWrong++
                }
            }
        }
        t.checkTrue(`right-aligned glyphs left of anchor (red=${rRight})`, rRight > 10)
        t.check('no glyphs right of anchor', 0, rWrong)
        SetTextAlign(mem, gui.TextAlign.TA_LEFT)           // 恢复 0
        SetTextColor(mem, 0)

        // (d) ExtTextOut ETO_OPAQUE 衬底（lprc 对象形直传 = encoder 入参位）
        SetTextColor(mem, RED)
        SetBkColor(mem, BLUE)
        t.checkTrue('ExtTextOut ETO_OPAQUE ok',
            ExtTextOut(mem, 20, 100, gui.TextOutOptions.ETO_OPAQUE,
                { left: 18, top: 98, right: 100, bottom: 118 }, 'Opaque', 6, NULL) !== 0)
        readPx()
        let oBlue = 0
        let oRed = 0
        for (let y = 99; y < 117; y++) {
            for (let x = 19; x < 99; x++) {
                const c = px(x, y)
                if (c === BLUE) oBlue++
                else if (c === RED) oRed++
            }
        }
        t.checkTrue(`opaque backdrop painted (blue=${oBlue})`, oBlue > 500)
        t.checkTrue(`glyphs over backdrop (red=${oRed})`, oRed > 10)
        SetBkColor(mem, WHITE)
        SetTextColor(mem, 0)

        t.section('CreateFontIndirect: scaled glyphs')
        clearWhite()
        SetTextColor(mem, RED)
        TextOut(mem, 20, 40, 'Big', 3)
        readPx()
        let smPx = 0
        for (let y = 35; y < 95; y++) {
            for (let x = 15; x < 150; x++) {
                if (px(x, y) === RED) smPx++
            }
        }
        const bigFont = CreateFontIndirect({ lfHeight: -48, lfFaceName: 'Arial' })
        t.checkTrue('scaled font created', bigFont !== 0)
        const bigOld = SelectObject(mem, bigFont)
        clearWhite()
        TextOut(mem, 20, 40, 'Big', 3)
        readPx()
        let bgPx = 0
        for (let y = 35; y < 95; y++) {
            for (let x = 15; x < 150; x++) {
                if (px(x, y) === RED) bgPx++
            }
        }
        t.checkTrue(`scaled glyphs bigger (${bgPx} vs ${smPx})`, bgPx > smPx * 2)
        SelectObject(mem, bigOld)
        DeleteObject(bigFont)
        SetTextColor(mem, 0)

        t.section('cleanup')
        SelectObject(mem, oldBmp)
        t.checkTrue('DeleteObject(bitmap)', DeleteObject(bmp) !== 0)
        t.checkTrue('DeleteDC', DeleteDC(mem) !== 0)
        t.checkTrue('ReleaseDC', ReleaseDC(NULL, screen) !== 0)
    }
}
