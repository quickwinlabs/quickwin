import '../lib/polyfill.js'
import * as std from 'std'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'
import type { Document, Page, Pixmap } from '../vendor/mupdf-wasm/mupdf.js'

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_S32 = ffi.FFI_TYPE_SINT32

const _user32 = win.LoadLibrary('user32.dll')
const _gdi32 = win.LoadLibrary('gdi32.dll')
const _comdlg32 = win.LoadLibrary('comdlg32.dll')

type MuPdf = typeof import('../vendor/mupdf-wasm/mupdf.js')
if (!(_user32 && _gdi32 && _comdlg32)) std.exit(0)

function loadProc(lib: win.HMODULE, name: string): number {
    const ptr = win.GetProcAddress(lib, name)
    if (!ptr) { std.printf('Error: cannot load %s\n', name); std.exit(1) }
    return ptr
}

const GetOpenFileNameW = loadProc(_comdlg32, 'GetOpenFileNameW')
const SetDIBitsToDevice = loadProc(_gdi32, 'SetDIBitsToDevice')
const GetDC = loadProc(_user32, 'GetDC')
const ReleaseDC = loadProc(_user32, 'ReleaseDC')
const PatBlt = loadProc(_gdi32, 'PatBlt')
const WHITENESS = 0x00FF0062

function makeBitmapInfo(w: number, h: number): ArrayBuffer {
    const bmi = new ArrayBuffer(40)
    const bv = new DataView(bmi)
    bv.setUint32(0, 40, true)
    bv.setInt32(4, w, true)
    bv.setInt32(8, -h, true)
    bv.setUint16(12, 1, true)
    bv.setUint16(14, 24, true)
    return bmi
}

function strToWide(str: string): ArrayBuffer {
    return new TextEncoder('utf-16le').encode(str + '\0').buffer as ArrayBuffer
}

function wideToStr(buf: ArrayBuffer): string {
    const dv = new DataView(buf)
    const chars: number[] = []
    for (let i = 0; i < buf.byteLength; i += 2) {
        const c = dv.getUint16(i, true); if (c === 0) break
        chars.push(c)
    }
    return String.fromCharCode(...chars)
}

function setPtr(dv: DataView, off: number, ptr: number): void {
    dv.setUint32(off, ptr & 0xFFFFFFFF, true)
    dv.setUint32(off + 4, Math.floor(ptr / 0x100000000), true)
}

interface PixmapInfo {
    data: ArrayBuffer; w: number; h: number
}

let hwndMain: gui.HWND = null as unknown as gui.HWND
let hwndEdit: gui.HWND = null as unknown as gui.HWND
let hwndCanvas: gui.HWND = null as unknown as gui.HWND
let hwndContent: gui.HWND = null as unknown as gui.HWND
let currentPixmap: PixmapInfo | null = null
let currentPage = 0, totalPages = 0
let scrollX = 0, scrollY = 0

let cachedPath = ''
let cachedDoc: Document | null = null

function clearCachedDoc(): void {
    if (cachedDoc) { try { cachedDoc.destroy() } catch {} }
    cachedDoc = null; cachedPath = ''
}

async function loadMupdf(): Promise<MuPdf | null> {
    const wasmPath = './vendor/mupdf-wasm/mupdf-wasm.wasm'
    const fp = std.open(wasmPath, 'rb')
    if (!fp) { std.printf('Error: cannot open %s\n', wasmPath); return null }
    fp.seek(0, 2); const size = fp.tell(); fp.seek(0, 0)
    const buf = new ArrayBuffer(size); fp.read(buf, 0, size); fp.close()
    ;(globalThis).$libmupdf_wasm_Module = { wasmBinary: buf, locateFile: (p: string) => p }
    try { return await import('../vendor/mupdf-wasm/mupdf.js') }
    catch (e) { std.printf('Error: mupdf load failed: %s\n', String(e)); return null }
}

function renderPdfPage(mupdf: MuPdf, filePath: string, pageIndex: number): PixmapInfo & { totalPages: number } | null {
    if (filePath !== cachedPath) {
        clearCachedDoc()
        const fp = std.open(filePath, 'rb')
        if (!fp) { std.printf('Error: cannot open %s\n', filePath); return null }
        let buf: ArrayBuffer | null = null
        try {
            fp.seek(0, 2); const size = fp.tell(); fp.seek(0, 0)
            buf = new ArrayBuffer(size); fp.read(buf, 0, size)
        } finally { fp.close() }
        if (!buf) return null
        try {
            cachedDoc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
            cachedPath = filePath
        } catch (e) { std.printf('Error opening document: %s\n', String(e)); return null }
    }
    if (!cachedDoc) return null
    let page: Page | null = null; let pixmap: Pixmap | null = null
    try {
        page = cachedDoc.loadPage(pageIndex)
        pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false)
        if (!pixmap) return null
        const srcPixels = pixmap.getPixels()
        const srcStride = pixmap.getStride()
        const w = pixmap.getWidth(), h = pixmap.getHeight()
        const dibStride = Math.floor((w * 3 + 3) / 4) * 4
        const dib = new Uint8Array(h * dibStride)
        for (let y = 0; y < h; y++) {
            const srcOff = y * srcStride, dstOff = y * dibStride
            for (let x = 0; x < w; x++) {
                const sx = srcOff + x * 3, dx = dstOff + x * 3
                dib[dx] = srcPixels[sx + 2]; dib[dx + 1] = srcPixels[sx + 1]; dib[dx + 2] = srcPixels[sx]
            }
        }
        const totalPages = cachedDoc.countPages()
        return { data: dib.buffer, w, h, totalPages }
    } catch (e) { std.printf('Error rendering: %s\n', String(e)); clearCachedDoc(); return null }
    finally { if (pixmap) try { pixmap.destroy() } catch {}; if (page) try { page.destroy() } catch {} }
}

function openPdfFileDialog(): string | null {
    const structBuf = new ArrayBuffer(152), sv = new DataView(structBuf)
    const fileBuf = new ArrayBuffer(260 * 2)
    const filterWide = strToWide('PDF Files\0*.pdf\0All Files\0*.*\0\0')
    sv.setUint32(0, 152, true)
    sv.setUint32(8, hwndMain as unknown as number & 0xFFFFFFFF, true)
    sv.setUint32(12, Math.floor(hwndMain as unknown as number / 0x100000000), true)
    setPtr(sv, 24, ffi.bufferPtr(filterWide))
    setPtr(sv, 48, ffi.bufferPtr(fileBuf))
    sv.setUint32(56, 260, true)
    sv.setUint32(96, 0x1000 | 0x0800 | 0x0004, true)
    const ret = ffi.ffiCall(GetOpenFileNameW, [FFI_PTR], [structBuf], FFI_U32)
    return ret ? wideToStr(fileBuf) : null
}

function updateScrollRange(): void {
    if (!currentPixmap) return
    const cr = gui.GetClientRect(hwndCanvas)
    if (!cr) return
    const cw = cr.right - cr.left, ch = cr.bottom - cr.top
    const maxX = Math.max(0, currentPixmap.w - cw)
    const maxY = Math.max(0, currentPixmap.h - ch)
    scrollX = Math.min(scrollX, maxX)
    scrollY = Math.min(scrollY, maxY)
    if (currentPixmap.w > cw) {
        const style = gui.GetWindowLongPtr(hwndCanvas, gui.Gwlp.STYLE) | 0
        if (!(style & gui.WindowStyle.HSCROLL)) {
            gui.SetWindowLongPtr(hwndCanvas, gui.Gwlp.STYLE, style | gui.WindowStyle.HSCROLL)
            gui.SetWindowPos(hwndCanvas, 0, 0, 0, 0, 0,
                gui.SetWindowPosFlag.SWP_NOMOVE | gui.SetWindowPosFlag.SWP_NOSIZE |
                gui.SetWindowPosFlag.SWP_NOZORDER | gui.SetWindowPosFlag.SWP_FRAMECHANGED)
        }
        gui.SetScrollInfo(hwndCanvas, gui.ScrollBar.HORZ, { min: 0, max: currentPixmap.w - 1, page: cw, pos: scrollX }, true)
        gui.ShowScrollBar(hwndCanvas, gui.ScrollBar.HORZ, true)
    } else {
        scrollX = 0
        const style = gui.GetWindowLongPtr(hwndCanvas, gui.Gwlp.STYLE) | 0
        if (style & gui.WindowStyle.HSCROLL) {
            gui.SetWindowLongPtr(hwndCanvas, gui.Gwlp.STYLE, style & ~gui.WindowStyle.HSCROLL)
            gui.SetWindowPos(hwndCanvas, 0, 0, 0, 0, 0,
                gui.SetWindowPosFlag.SWP_NOMOVE | gui.SetWindowPosFlag.SWP_NOSIZE |
                gui.SetWindowPosFlag.SWP_NOZORDER | gui.SetWindowPosFlag.SWP_FRAMECHANGED)
        }
        gui.ShowScrollBar(hwndCanvas, gui.ScrollBar.HORZ, false)
    }
    if (currentPixmap.h > ch) {
        gui.SetScrollInfo(hwndCanvas, gui.ScrollBar.VERT, { min: 0, max: currentPixmap.h - 1, page: ch, pos: scrollY }, true)
        gui.ShowScrollBar(hwndCanvas, gui.ScrollBar.VERT, true)
    } else { scrollY = 0; gui.ShowScrollBar(hwndCanvas, gui.ScrollBar.VERT, false) }
    gui.SetWindowPos(hwndContent, 0, -scrollX, -scrollY, 0, 0,
        gui.SetWindowPosFlag.SWP_NOSIZE | gui.SetWindowPosFlag.SWP_NOZORDER)
}

function showPdf(mupdf: MuPdf, path: string, pageIdx: number): void {
    const pix = renderPdfPage(mupdf, path, pageIdx)
    if (!pix) { gui.MessageBox('渲染 PDF 失败'); return }
    currentPixmap = pix; currentPage = pageIdx; totalPages = pix.totalPages
    gui.SetWindowText(hwndMain, 'PDF 预览 - 第 ' + (pageIdx + 1) + '/' + totalPages + ' 页')
    scrollX = 0; scrollY = 0
    gui.SetWindowPos(hwndContent, 0, 0, 0, pix.w, pix.h,
        gui.SetWindowPosFlag.SWP_NOZORDER | gui.SetWindowPosFlag.SWP_NOMOVE)
    updateScrollRange()
    gui.InvalidateRect(hwndContent, null, true)
}

function doScroll(dx: number, dy: number): void {
    const cr = gui.GetClientRect(hwndCanvas)
    if (!cr || !currentPixmap) return
    const cw = cr.right - cr.left, ch = cr.bottom - cr.top
    const maxX = Math.max(0, currentPixmap.w - cw)
    const maxY = Math.max(0, currentPixmap.h - ch)
    scrollX = Math.max(0, Math.min(maxX, scrollX + dx))
    scrollY = Math.max(0, Math.min(maxY, scrollY + dy))
    gui.SetWindowPos(hwndContent, 0, -scrollX, -scrollY, 0, 0,
        gui.SetWindowPosFlag.SWP_NOSIZE | gui.SetWindowPosFlag.SWP_NOZORDER)
    gui.SetScrollInfo(hwndCanvas, gui.ScrollBar.HORZ, { pos: scrollX }, true)
    gui.SetScrollInfo(hwndCanvas, gui.ScrollBar.VERT, { pos: scrollY }, true)
}

async function main(): Promise<void> {
    const mupdf = await loadMupdf()
    if (!mupdf) { gui.MessageBox('加载 mupdf WASM 失败'); return }

    const WS_CHILD = gui.WindowStyle.CHILD
    const WS_VIS = gui.WindowStyle.VISIBLE
    const WS_BORDER = gui.WindowStyle.BORDER
    const ctrlY = 12, ctrlH = 26, gap = 4, btnW = 80, btnPageW = 72

    let hwndBtnOpen: gui.HWND = null as unknown as gui.HWND
    let hwndBtnPrev: gui.HWND = null as unknown as gui.HWND
    let hwndBtnNext: gui.HWND = null as unknown as gui.HWND

    gui.RegisterClass('PdfViewer2', (hwnd, msg, wParam, lParam) => {
        if (msg === gui.WmMsg.DESTROY) { gui.PostQuitMessage(0); return 0 }
        if (msg === gui.WmMsg.SIZE) {
            const cr = gui.GetClientRect(hwnd)
            if (cr) {
                const cw = cr.right - cr.left, ch = cr.bottom - cr.top
                gui.SetWindowPos(hwndCanvas, 0, 0, 50, cw, Math.max(1, ch - 50), gui.SetWindowPosFlag.SWP_NOZORDER)
                gui.SetWindowPos(hwndEdit, 0, 0, 0, Math.max(100, cw - 320), 0,
                    gui.SetWindowPosFlag.SWP_NOMOVE | gui.SetWindowPosFlag.SWP_NOZORDER)
            }
            return gui.DefWindowProc(hwnd, msg, wParam, lParam)
        }
        if (msg === gui.WmMsg.COMMAND) {
            const hCtrl = lParam
            if (hCtrl === hwndBtnOpen) {
                const path = openPdfFileDialog()
                if (path) { gui.SetWindowText(hwndEdit, path); showPdf(mupdf, path, 0) }
            } else if (hCtrl === hwndBtnPrev) {
                const path = gui.GetWindowText(hwndEdit)
                if (path && currentPage > 0) showPdf(mupdf, path, currentPage - 1)
            } else if (hCtrl === hwndBtnNext) {
                const path = gui.GetWindowText(hwndEdit)
                if (path && currentPage < totalPages - 1) showPdf(mupdf, path, currentPage + 1)
            }
            return 0
        }
        return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    })
    hwndMain = gui.CreateWindow('PdfViewer2', 'PDF 预览 2',
        gui.WindowStyle.OVERLAPPEDWINDOW | gui.WindowStyle.CLIPCHILDREN,
        100, 100, 1100, 800, null, null)!
    if (!hwndMain) { gui.MessageBox('创建主窗口失败'); return }

    // 控件直接挂在主窗口上
    hwndEdit = gui.CreateWindow('EDIT', '',
        WS_CHILD | WS_VIS | WS_BORDER,
        ctrlY + btnW + gap, ctrlY, 480, ctrlH, hwndMain, null)!
    hwndBtnOpen = gui.CreateWindow('BUTTON', '打开 PDF',
        WS_CHILD | WS_VIS,
        ctrlY, ctrlY, btnW, ctrlH, hwndMain, null)!
    hwndBtnPrev = gui.CreateWindow('BUTTON', '上一页',
        WS_CHILD | WS_VIS,
        ctrlY + btnW + gap + 480 + gap, ctrlY, btnPageW, ctrlH, hwndMain, null)!
    hwndBtnNext = gui.CreateWindow('BUTTON', '下一页',
        WS_CHILD | WS_VIS,
        ctrlY + btnW + gap + 480 + gap + btnPageW + gap, ctrlY, btnPageW, ctrlH, hwndMain, null)!

    // 画布（带滚动条）
    hwndCanvas = gui.CreateWindow('STATIC', '',
        WS_CHILD | WS_VIS | gui.WindowStyle.CLIPCHILDREN | gui.WindowStyle.VSCROLL | gui.WindowStyle.HSCROLL,
        0, 50, 1100, 750, hwndMain, null)!

    // 内容窗口（画 pixmap）
    hwndContent = gui.CreateWindow('STATIC', '',
        WS_CHILD | WS_VIS, 0, 0, 100, 100, hwndCanvas, null)!

    // 内容窗口 PAINT
    gui.SetWindowProc(hwndContent, (hwnd: gui.HWND, msg: number, wParam: number, lParam: number): number => {
        if (msg === gui.WmMsg.ERASEBKGND) return 1
        if (msg === gui.WmMsg.PAINT) {
            gui.DefWindowProc(hwnd, msg, wParam, lParam)
            const pm = currentPixmap
            if (!pm) return 0
            const hdc = ffi.ffiCall(GetDC, [ffi.FFI_TYPE_UINT64], [hwnd as unknown as number], ffi.FFI_TYPE_UINT64)
            if (hdc) {
                const bmi = makeBitmapInfo(pm.w, pm.h)
                ffi.ffiCall(SetDIBitsToDevice, [
                    ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                    FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                    FFI_PTR, FFI_PTR, FFI_U32
                ], [hdc, 0, 0, pm.w, pm.h, 0, 0, 0, pm.h, pm.data, bmi, 0], FFI_S32)
                ffi.ffiCall(ReleaseDC, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [hwnd as unknown as number, hdc], FFI_S32)
            }
            return 0
        }
        return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    })

    // 画布消息处理（PAINT 填白、滚动条、滚轮）
    gui.SetWindowProc(hwndCanvas, (hwnd: gui.HWND, msg: number, wParam: number, lParam: number): number => {
        if (msg === gui.WmMsg.ERASEBKGND) return 1
        if (msg === gui.WmMsg.PAINT) {
            const cr = gui.GetClientRect(hwnd)
            if (cr) {
                const cw = cr.right - cr.left, ch = cr.bottom - cr.top
                const hdc = ffi.ffiCall(GetDC, [ffi.FFI_TYPE_UINT64], [hwnd as unknown as number], ffi.FFI_TYPE_UINT64)
                if (hdc) {
                    ffi.ffiCall(PatBlt, [ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_S32, FFI_S32, FFI_U32],
                        [hdc, 0, 0, cw, ch, WHITENESS], FFI_U32)
                    ffi.ffiCall(ReleaseDC, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [hwnd as unknown as number, hdc], FFI_S32)
                }
            }
            gui.DefWindowProc(hwnd, msg, wParam, lParam)
            return 0
        }
        if (msg === gui.WmMsg.VSCROLL || msg === gui.WmMsg.HSCROLL) {
            const bar = msg === gui.WmMsg.VSCROLL ? gui.ScrollBar.VERT : gui.ScrollBar.HORZ
            const info = gui.GetScrollInfo(hwnd, bar)
            const maxPos = info.max - info.page + 1
            const code = wParam & 0xFFFF
            let newPos = bar === gui.ScrollBar.VERT ? scrollY : scrollX
            if (code === gui.ScrollCmd.THUMBTRACK || code === gui.ScrollCmd.THUMBPOSITION)
                newPos = Math.max(0, Math.min(maxPos, (wParam >> 16) & 0xFFFF))
            else if (code === gui.ScrollCmd.LINEUP) newPos -= 20
            else if (code === gui.ScrollCmd.LINEDOWN) newPos += 20
            else if (code === gui.ScrollCmd.PAGEUP) newPos -= info.page
            else if (code === gui.ScrollCmd.PAGEDOWN) newPos += info.page
            else return 0
            newPos = Math.max(0, Math.min(maxPos, newPos))
            if (bar === gui.ScrollBar.VERT) doScroll(0, newPos - scrollY)
            else doScroll(newPos - scrollX, 0)
            return 0
        }
        if (msg === gui.WmMsg.MOUSEWHEEL) {
            const raw = (wParam >>> 16) & 0xFFFF
            const wheel = raw >= 0x8000 ? raw - 0x10000 : raw
            const isHorz = (wParam & gui.MouseKeyFlag.MK_SHIFT) !== 0
            const bar = isHorz ? gui.ScrollBar.HORZ : gui.ScrollBar.VERT
            const info = gui.GetScrollInfo(hwnd, bar)
            const maxPos = info.max - info.page + 1
            let newPos = (isHorz ? scrollX : scrollY) - Math.round(wheel * 40 / 120)
            newPos = Math.max(0, Math.min(maxPos, newPos))
            if (isHorz) doScroll(newPos - scrollX, 0)
            else doScroll(0, newPos - scrollY)
            return 0
        }
        if (msg === gui.WmMsg.SIZE) { updateScrollRange(); return gui.DefWindowProc(hwnd, msg, wParam, lParam) }
        return gui.DefWindowProc(hwnd, msg, wParam, lParam)
    })

    gui.ShowWindow(hwndMain)

    const test = std.open('example.pdf', 'rb')
    if (test) { test.close(); showPdf(mupdf, 'example.pdf', 0) }
}

main()
