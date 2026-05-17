import '../lib/polyfill.js'
import * as std from 'std'
import * as os from 'os'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'

const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_U32 = ffi.FFI_TYPE_UINT32
const FFI_S32 = ffi.FFI_TYPE_SINT32

const _user32 = win.LoadLibrary('user32.dll')
const _gdi32 = win.LoadLibrary('gdi32.dll')
const _comdlg32 = win.LoadLibrary('comdlg32.dll')

type MuPdf = typeof import('../vendor/mupdf-wasm/mupdf.js')

if (
    !(_user32 && _gdi32 && _comdlg32)
) {
    std.exit(0)
}

const GetDC = win.GetProcAddress(_user32, 'GetDC')
const ReleaseDC = win.GetProcAddress(_user32, 'ReleaseDC')
const GetOpenFileNameW = win.GetProcAddress(_comdlg32, 'GetOpenFileNameW')
const SetDIBitsToDevice = win.GetProcAddress(_gdi32, 'SetDIBitsToDevice')
const InvalidateRect = win.GetProcAddress(_user32, 'InvalidateRect')
const ValidateRect = win.GetProcAddress(_user32, 'ValidateRect')
const BeginPaint = win.GetProcAddress(_user32, 'BeginPaint')
const EndPaint = win.GetProcAddress(_user32, 'EndPaint')

const WM_SIZE = 0x0003

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
let hwndBtnRender: gui.HWND | null = null
let currentPixmap: PixmapInfo | null = null

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

        ; (globalThis as any)['$libmupdf_wasm_Module'] = {
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

    if (!GetOpenFileNameW) return null

    const ret = ffi.ffiCall(GetOpenFileNameW, [FFI_PTR], [structBuf], FFI_U32)
    if (!ret) return null

    const path = wideToStr(fileBuf)
    return path.length > 0 ? path : null
}

function renderPdfPage(mupdf: MuPdf, filePath: string): PixmapInfo | null {
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

    if (!mupdf) { std.printf('Error: mupdf not loaded\n'); return null }

    let doc: any = null
    let page: any = null
    let pixmap: any = null

    try {
        doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
        const np = doc.countPages()
        std.printf('Pages: %d\n', np)
        if (np < 1) { return null }

        page = doc.loadPage(0)
        console.log("loadPages done")

        const scale = 1.5
        pixmap = page.toPixmap(
            mupdf.Matrix.scale(scale, scale),
            mupdf.ColorSpace.DeviceRGB,
            false
        )
        console.log('toPixmap done')
        if (!pixmap) { return null }

        const srcPixels = pixmap.getPixels()
        const srcStride = pixmap.getStride()
        const w = pixmap.getWidth()
        const h = pixmap.getHeight()
        const dibStride = Math.floor((w * 3 + 3) / 4) * 4
        std.printf('Pixmap: %dx%d srcStride=%d dibStride=%d\n', w, h, srcStride, dibStride)

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

        pixmap.destroy()
        pixmap = null
        page.destroy()
        page = null
        doc.destroy()
        doc = null

        return { data: dibBuffer, w, h }
    } catch (e) {
        std.printf('Error rendering: %s\n', String(e))
        return null
    } finally {
        if (pixmap) { try { pixmap.destroy() } catch { } }
        if (page) { try { page.destroy() } catch { } }
        if (doc) { try { doc.destroy() } catch { } }
    }
}


async function main(): Promise<void> {
    const mupdf = await loadMupdf()
    if (!mupdf) {
        gui.MessageBox('Failed to load mupdf WASM.\nMake sure vendor/mupdf-wasm/ is in the build directory.')
        return
    }
    gui.RegisterClass('PdfPreview', (hwnd, msg, wParam, lParam) => {
        if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
        const h = hwnd as number
        switch (msg) {
            case gui.WM_DESTROY:
                gui.PostQuitMessage(0)
                return 0

            case gui.WM_COMMAND: {
                const hCtrl = lParam
                if (hCtrl === (hwndBtnOpen)) {
                    const path = openPdfFileDialog()
                    if (path) gui.SetWindowText(hwndEdit!, path)
                } else if (hCtrl === (hwndBtnRender)) {
                    const pdfPath = gui.GetWindowText(hwndEdit!)
                    if (!pdfPath) {
                        gui.MessageBox('Please select a PDF file first')
                        return 0
                    }
                    const pix = renderPdfPage(mupdf, pdfPath)
                    console.log(pix)
                    if (pix) {
                        currentPixmap = pix
                       InvalidateRect && ffi.ffiCall(InvalidateRect, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT32], [h, 0, 1], FFI_U32)
                    } else {
                        gui.MessageBox('Failed to render PDF')
                    }
                }
                return 0
            }

            case gui.WM_PAINT: {
                const hdc = ffi.ffiCall(GetDC!, [ffi.FFI_TYPE_UINT64], [h], ffi.FFI_TYPE_UINT64)
                if (hdc) {
                    if (currentPixmap) {
                        const bmi = new ArrayBuffer(40)
                        const bv = new DataView(bmi)
                        bv.setUint32(0, 40, true)
                        bv.setInt32(4, currentPixmap.w, true)
                        bv.setInt32(8, -(currentPixmap.h), true)
                        bv.setUint16(12, 1, true)
                        bv.setUint16(14, 24, true)
                        bv.setUint32(16, 0, true)
                        bv.setUint32(20, 0, true)
                        bv.setInt32(24, 0, true)
                        bv.setInt32(28, 0, true)
                        bv.setUint32(32, 0, true)
                        bv.setUint32(36, 0, true)

                        ffi.ffiCall(SetDIBitsToDevice!, [
                            ffi.FFI_TYPE_UINT64, FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                            FFI_S32, FFI_S32, FFI_U32, FFI_U32,
                            FFI_PTR, FFI_PTR, FFI_U32
                        ], [
                            hdc, 15, 50,
                            currentPixmap.w, currentPixmap.h,
                            0, 0, 0, currentPixmap.h,
                            currentPixmap.data, bmi, 0
                        ], FFI_S32)
                    }
                    ffi.ffiCall(ReleaseDC!, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64], [h, hdc], FFI_S32)
                }
                return gui.DefWindowProc(hwnd, msg, wParam, lParam)
            }

            case WM_SIZE: {
                ffi.ffiCall(InvalidateRect!, [ffi.FFI_TYPE_UINT64, ffi.FFI_TYPE_UINT64, FFI_U32], [h, 0, 1], FFI_U32)
                return 0
            }

            default:
                return gui.DefWindowProc(hwnd, msg, wParam, lParam)
        }
    })

    const ctrlY = 12
    const ctrlH = 26
    const gap = 4
    const btnOpenW = 80
    const btnRenderW = 80

    hwndMain = gui.CreateWindow(
        'PdfPreview', 'PDF Preview',
        gui.WS_OVERLAPPEDWINDOW,
        100, 100, 960, 720,
        null, null
    )
    if (!hwndMain) {
        gui.MessageBox('Failed to create main window')
        return
    }

    hwndBtnRender = gui.CreateWindow(
        'BUTTON', 'Render',
        gui.WS_CHILD | gui.WS_VISIBLE | gui.WM_COMMAND,
        ctrlY, ctrlY, btnRenderW, ctrlH, hwndMain, null
    )
    hwndBtnOpen = gui.CreateWindow(
        'BUTTON', 'Open PDF',
        gui.WS_CHILD | gui.WS_VISIBLE | gui.WM_COMMAND,
        ctrlY + btnRenderW + gap, ctrlY, btnOpenW, ctrlH, hwndMain, null
    )
    hwndEdit = gui.CreateWindow(
        'EDIT', '',
        gui.WS_CHILD | gui.WS_VISIBLE | gui.WS_BORDER,
        ctrlY + btnRenderW + btnOpenW + gap * 2, ctrlY, 500, ctrlH, hwndMain, null
    )

    gui.ShowWindow(hwndMain)
}

main()
