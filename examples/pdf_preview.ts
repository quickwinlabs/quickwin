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

if (!(_user32 && _gdi32 && _comdlg32)) {
    std.exit(0)
}

function loadProc(lib: win.HMODULE, name: string): number {
    const ptr = win.GetProcAddress(lib, name)
    if (!ptr) {
        std.printf('Error: cannot load %s\n', name)
        std.exit(1)
    }
    return ptr
}

const GetDC = loadProc(_user32, 'GetDC')
const ReleaseDC = loadProc(_user32, 'ReleaseDC')
const GetOpenFileNameW = loadProc(_comdlg32, 'GetOpenFileNameW')
const SetDIBitsToDevice = loadProc(_gdi32, 'SetDIBitsToDevice')
const PatBlt = loadProc(_gdi32, 'PatBlt')
const InvalidateRect = loadProc(_user32, 'InvalidateRect')
const GetSystemMetrics = loadProc(_user32, 'GetSystemMetrics')
const SetScrollInfo = loadProc(_user32, 'SetScrollInfo')

const TOP_OFFSET = 50

// FFI 类型签名快捷常量
const T_U64 = [ffi.FFI_TYPE_UINT64] as [typeof ffi.FFI_TYPE_UINT64]
const T_U64_S32_PTR_U32 = [ffi.FFI_TYPE_UINT64, FFI_S32, FFI_PTR, FFI_U32] as [typeof ffi.FFI_TYPE_UINT64, typeof ffi.FFI_TYPE_SINT32, typeof ffi.FFI_TYPE_POINTER, typeof ffi.FFI_TYPE_UINT32]
const T_U64_U64_U32 = [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64, FFI_U32] as [typeof ffi.FFI_TYPE_UINT64, typeof ffi.FFI_TYPE_UINT64, typeof ffi.FFI_TYPE_UINT32]

function clamp(v: number, max: number): number {
    return Math.max(0, Math.min(v, max))
}

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
    const buf = new ArrayBuffer((str.length + 1) * 2)
    const dv = new DataView(buf)
    for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true)
    return buf
}

function wideToStr(buf: ArrayBuffer): string {
    const dv = new DataView(buf)
    const chars: number[] = []
    for (let i = 0; i < buf.byteLength; i += 2) {
        const c = dv.getUint16(i, true)
        if (c === 0) break
        chars.push(c)
    }
    return String.fromCharCode(...chars)
}

function setPtr(dv: DataView, off: number, ptr: number): void {
    dv.setUint32(off, ptr & 0xFFFFFFFF, true)
    dv.setUint32(off + 4, Math.floor(ptr / 0x100000000), true)
}

interface PixmapInfo {
    data: ArrayBuffer
    w: number
    h: number
}

let hwndMain: gui.HWND | null = null
let hwndEdit: gui.HWND | null = null
let hwndBtnOpen: gui.HWND | null = null
let hwndBtnPrev: gui.HWND | null = null
let hwndBtnNext: gui.HWND | null = null
let currentPixmap: PixmapInfo | null = null
let currentPage = 0
let totalPages = 0
let scrollX = 0
let scrollY = 0

// PDF 文档缓存 — 翻页时不重复解析
let cachedPath = ''
let cachedDoc: Document | null = null
let cachedTotalPages = 0

function clearCachedDoc(): void {
    if (cachedDoc) { try { cachedDoc.destroy() } catch {} }
    cachedDoc = null
    cachedPath = ''
    cachedTotalPages = 0
}

async function loadMupdf(): Promise<MuPdf | null> {
    const wasmPath = './vendor/mupdf-wasm/mupdf-wasm.wasm'
    const fp = std.open(wasmPath, 'rb')
    if (!fp) { std.printf('Error: cannot open %s\n', wasmPath); return null }
    fp.seek(0, 2)
    const size = fp.tell()
    fp.seek(0, 0)
    const buf = new ArrayBuffer(size)
    fp.read(buf, 0, size)
    fp.close()
    console.log(buf.byteLength)

        ; (globalThis).$libmupdf_wasm_Module = {
            wasmBinary: buf,
            locateFile: (p: string) => p
        }
    try {
        return await import('../vendor/mupdf-wasm/mupdf.js')
    } catch (e) {
        std.printf('Error: mupdf load failed: %s\n', String(e))
        return null
    }
}

function openPdfFileDialog(): string | null {
    const structBuf = new ArrayBuffer(152)
    const sv = new DataView(structBuf)
    const fileBuf = new ArrayBuffer(260 * 2)
    const filterWide = strToWide('PDF Files\0*.pdf\0All Files\0*.*\0\0')

    sv.setUint32(0, 152, true)
    const ownerPtr = hwndMain
    if (!ownerPtr) return null
    sv.setUint32(8, ownerPtr & 0xFFFFFFFF, true)
    sv.setUint32(12, Math.floor(ownerPtr / 0x100000000), true)

    setPtr(sv, 24, ffi.bufferPtr(filterWide))
    setPtr(sv, 48, ffi.bufferPtr(fileBuf))
    sv.setUint32(56, 260, true)

    sv.setUint32(96, 0x1000 | 0x0800 | 0x0004, true)

    const ret = ffi.ffiCall(GetOpenFileNameW, [FFI_PTR], [structBuf], FFI_U32)
    if (!ret) return null

    const path = wideToStr(fileBuf)
    return path.length > 0 ? path : null
}

function renderPdfPage(mupdf: MuPdf, filePath: string, pageIndex: number): PixmapInfo & { totalPages: number } | null {
    if (filePath !== cachedPath) {
        clearCachedDoc()
        const fp = std.open(filePath, 'rb')
        if (!fp) { std.printf('Error: cannot open %s\n', filePath); return null }
        let buf: ArrayBuffer | null = null
        try {
            fp.seek(0, 2)
            const size = fp.tell()
            fp.seek(0, 0)
            buf = new ArrayBuffer(size)
            fp.read(buf, 0, size)
        } finally {
            fp.close()
        }
        if (!buf) return null
        try {
            cachedDoc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
            cachedTotalPages = cachedDoc.countPages()
            std.printf('Pages: %d\n', cachedTotalPages)
            cachedPath = filePath
        } catch (e) {
            std.printf('Error opening document: %s\n', String(e))
            return null
        }
    }

    if (!cachedDoc) return null
    if (pageIndex >= cachedTotalPages) return null

    let page: Page | null = null
    let pixmap: Pixmap | null = null
    try {
        page = cachedDoc.loadPage(pageIndex)

        const scale = 1.5
        pixmap = page.toPixmap(
            mupdf.Matrix.scale(scale, scale),
            mupdf.ColorSpace.DeviceRGB,
            false
        )
        if (!pixmap) return null

        const srcPixels = pixmap.getPixels()
        const srcStride = pixmap.getStride()
        const w = pixmap.getWidth()
        const h = pixmap.getHeight()
        const dibStride = Math.floor((w * 3 + 3) / 4) * 4

        const dibSize = h * dibStride
        const dibBuffer = new ArrayBuffer(dibSize)
        const dib = new Uint8Array(dibBuffer)

        for (let y = 0; y < h; y++) {
            const srcOff = y * srcStride
            const dstOff = y * dibStride
            for (let x = 0; x < w; x++) {
                const sx = srcOff + x * 3
                const dx = dstOff + x * 3
                dib[dx] = srcPixels[sx + 2]
                dib[dx + 1] = srcPixels[sx + 1]
                dib[dx + 2] = srcPixels[sx]
            }
        }

        return { data: dibBuffer, w, h, totalPages: cachedTotalPages }
    } catch (e) {
        std.printf('Error rendering: %s\n', String(e))
        clearCachedDoc()
        return null
    } finally {
        if (pixmap) { try { pixmap.destroy() } catch {} }
        if (page) { try { page.destroy() } catch {} }
    }
}


function getClientSize(h: number): { w: number, h: number } {
    const r = gui.GetClientRect(h as gui.HWND)
    if (!r) return { w: 0, h: 0 }
    return { w: r.right - r.left, h: r.bottom - r.top }
}

function setScrollPos(h: number, bar: number, pos: number): void {
    const si = new ArrayBuffer(28)
    const dv = new DataView(si)
    dv.setUint32(0, 28, true)
    dv.setUint32(4, gui.ScrollInfoFlag.POS, true)
    dv.setInt32(20, pos, true)
    ffi.ffiCall(SetScrollInfo, T_U64_S32_PTR_U32, [h, bar, si, 1], FFI_U32)
}

function updateScrollRange(h: number): void {
    if (!currentPixmap) return
    const client = getClientSize(h)
    const viewH = client.h - TOP_OFFSET
    const maxX = Math.max(0, currentPixmap.w - client.w)
    const maxY = Math.max(0, currentPixmap.h - viewH)
    scrollX = Math.min(scrollX, maxX)
    scrollY = Math.min(scrollY, maxY)

    const si = new ArrayBuffer(28)
    const dv = new DataView(si)
    dv.setUint32(0, 28, true)

    dv.setUint32(4, gui.ScrollInfoFlag.RANGE | gui.ScrollInfoFlag.PAGE, true)
    dv.setInt32(8, 0, true)
    dv.setInt32(12, currentPixmap.w - 1, true)
    dv.setUint32(16, client.w, true)
    ffi.ffiCall(SetScrollInfo, T_U64_S32_PTR_U32, [h, gui.ScrollBar.HORZ, si, 1], FFI_U32)

    dv.setInt32(8, 0, true)
    dv.setInt32(12, currentPixmap.h - 1, true)
    dv.setUint32(16, viewH, true)
    ffi.ffiCall(SetScrollInfo, T_U64_S32_PTR_U32, [h, gui.ScrollBar.VERT, si, 1], FFI_U32)

    setScrollPos(h, gui.ScrollBar.HORZ, scrollX)
    setScrollPos(h, gui.ScrollBar.VERT, scrollY)
}

function doScroll(h: number, dx: number, dy: number): void {
    const client = getClientSize(h)
    scrollX = clamp(scrollX + dx, currentPixmap ? Math.max(0, currentPixmap.w - client.w) : 0)
    scrollY = clamp(scrollY + dy, currentPixmap ? Math.max(0, currentPixmap.h - (client.h - TOP_OFFSET)) : 0)
    setScrollPos(h, gui.ScrollBar.HORZ, scrollX)
    setScrollPos(h, gui.ScrollBar.VERT, scrollY)
    ffi.ffiCall(InvalidateRect, T_U64_U64_U32, [h, 0, 1], FFI_U32)
}

function renderAndDisplay(mupdf: MuPdf, path: string, pageIndex: number): void {
    const edit = hwndEdit
    const hMain = hwndMain
    if (!edit || !hMain) return
    gui.SetWindowText(edit, path)
    const pix = renderPdfPage(mupdf, path, pageIndex)
    if (pix) {
        currentPixmap = pix
        currentPage = pageIndex
        totalPages = pix.totalPages
        gui.SetWindowText(hMain, 'PDF 预览 - 第 ' + (pageIndex + 1) + '/' + totalPages + ' 页')
        scrollX = 0
        scrollY = 0
        updateScrollRange(hMain)
        ffi.ffiCall(InvalidateRect, T_U64_U64_U32, [hMain, 0, 1], FFI_U32)
    } else {
        gui.MessageBox('渲染 PDF 失败')
    }
}

async function main(): Promise<void> {
    const mupdf = await loadMupdf()
    if (!mupdf) {
        gui.MessageBox('加载 mupdf WASM 失败。\n请确保 vendor/mupdf-wasm/ 在构建目录中。')
        return
    }
    gui.RegisterClass('PdfPreview', (hwnd, msg, wParam, lParam) => {
        if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
        const h = hwnd as number
        switch (msg) {
            case gui.WmMsg.DESTROY:
                gui.PostQuitMessage(0)
                return 0

            case gui.WmMsg.COMMAND: {
                const hCtrl = lParam
                const btnOpen = hwndBtnOpen as number | null
                const btnPrev = hwndBtnPrev as number | null
                const btnNext = hwndBtnNext as number | null
                if (hCtrl === btnOpen) {
                    const path = openPdfFileDialog()
                    if (path) renderAndDisplay(mupdf, path, 0)
                } else if (hCtrl === btnPrev && currentPage > 0) {
                    const path = gui.GetWindowText(hwndEdit!)
                    if (path) renderAndDisplay(mupdf, path, currentPage - 1)
                } else if (hCtrl === btnNext && currentPage < totalPages - 1) {
                    const path = gui.GetWindowText(hwndEdit!)
                    if (path) renderAndDisplay(mupdf, path, currentPage + 1)
                }
                return 0
            }

            case gui.WmMsg.PAINT: {
                const hdc = ffi.ffiCall(GetDC, [ffi.FFI_TYPE_UINT64], [h], ffi.FFI_TYPE_UINT64)
                if (hdc) {
                    ffi.ffiCall(PatBlt, [ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_S32, FFI_S32, FFI_U32], [hdc, 0, 0, 32767, TOP_OFFSET, 0x00FF0062], FFI_U32)
                    if (currentPixmap) {
                        const bmi = makeBitmapInfo(currentPixmap.w, currentPixmap.h)
                        ffi.ffiCall(SetDIBitsToDevice, [
                            ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                            FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                            FFI_PTR, FFI_PTR, FFI_U32
                        ], [
                            hdc, -scrollX, TOP_OFFSET - scrollY,
                            currentPixmap.w, currentPixmap.h,
                            0, 0, 0, currentPixmap.h,
                            currentPixmap.data, bmi, 0
                        ], FFI_S32)
                    }
                    ffi.ffiCall(ReleaseDC, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [h, hdc], FFI_S32)
                }
                return gui.DefWindowProc(hwnd, msg, wParam, lParam)
            }

            case gui.WmMsg.HSCROLL: {
                if (wParam === 0) return 0
                const code = wParam & 0xFFFF
                const thumb = (wParam >> 16) & 0xFFFF
                let dx = 0
                if (code === gui.ScrollCmd.LINEUP) dx = -20
                else if (code === gui.ScrollCmd.LINEDOWN) dx = 20
                else if (code === gui.ScrollCmd.PAGEUP) dx = -60
                else if (code === gui.ScrollCmd.PAGEDOWN) dx = 60
                else if (code === gui.ScrollCmd.THUMBTRACK) dx = thumb - scrollX
                if (dx) doScroll(h, dx, 0)
                return 0
            }

            case gui.WmMsg.VSCROLL:
            case gui.WmMsg.MOUSEWHEEL: {
                let dy = 0
                if (msg === gui.WmMsg.VSCROLL) {
                    if (wParam === 0) return 0
                    const code = wParam & 0xFFFF
                    const thumb = (wParam >> 16) & 0xFFFF
                    if (code === gui.ScrollCmd.LINEUP) dy = -20
                    else if (code === gui.ScrollCmd.LINEDOWN) dy = 20
                    else if (code === gui.ScrollCmd.PAGEUP) dy = -60
                    else if (code === gui.ScrollCmd.PAGEDOWN) dy = 60
                    else if (code === gui.ScrollCmd.THUMBTRACK) dy = thumb - scrollY
                } else {
                    const raw = (wParam >>> 16) & 0xFFFF
                    const wheel = raw >= 0x8000 ? raw - 0x10000 : raw
                    dy = -Math.round(wheel * 40 / 120)
                }
                if (dy) doScroll(h, 0, dy)
                return 0
            }

            case gui.WmMsg.SIZE: {
                if (currentPixmap) updateScrollRange(h)
                ffi.ffiCall(InvalidateRect, T_U64_U64_U32, [h, 0, 1], FFI_U32)
                return 0
            }

            default:
                return gui.DefWindowProc(hwnd, msg, wParam, lParam)
        }
    })

    const winW = 960, winH = 720
    const screenW = ffi.ffiCall(GetSystemMetrics, [FFI_S32], [gui.SysMetrics.CXSCREEN], FFI_S32) as number
    const screenH = ffi.ffiCall(GetSystemMetrics, [FFI_S32], [gui.SysMetrics.CYSCREEN], FFI_S32) as number
    const winX = Math.max(0, (screenW - winW) >> 1)
    const winY = Math.max(0, (screenH - winH) >> 1)

    const ctrlY = 12
    const ctrlH = 26
    const gap = 4
    const btnOpenW = 80

    hwndMain = gui.CreateWindow(
        'PdfPreview', 'PDF 预览',
        gui.WindowStyle.OVERLAPPEDWINDOW | gui.WindowStyle.HSCROLL | gui.WindowStyle.VSCROLL | gui.WindowStyle.CLIPCHILDREN,
        winX, winY, winW, winH,
        null, null
    )
    if (!hwndMain) {
        gui.MessageBox('创建主窗口失败')
        return
    }

    hwndBtnOpen = gui.CreateWindow(
        'BUTTON', '打开 PDF',
        gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WmMsg.COMMAND,
        ctrlY, ctrlY, btnOpenW, ctrlH, hwndMain, null
    )
    const editW = 480
    const btnPageW = 72
    const editX = ctrlY + btnOpenW + gap
    hwndEdit = gui.CreateWindow(
        'EDIT', '',
        gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WindowStyle.BORDER,
        editX, ctrlY, editW, ctrlH, hwndMain, null
    )
    hwndBtnPrev = gui.CreateWindow(
        'BUTTON', '上一页',
        gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WmMsg.COMMAND,
        editX + editW + gap, ctrlY, btnPageW, ctrlH, hwndMain, null
    )
    hwndBtnNext = gui.CreateWindow(
        'BUTTON', '下一页',
        gui.WindowStyle.CHILD | gui.WindowStyle.VISIBLE | gui.WmMsg.COMMAND,
        editX + editW + gap + btnPageW + gap, ctrlY, btnPageW, ctrlH, hwndMain, null
    )

    gui.ShowWindow(hwndMain)

    const test = std.open('example.pdf', 'rb')
    if (test) {
        test.close()
        renderAndDisplay(mupdf, 'example.pdf', 0)
    }
}

main()
