import '../lib/polyfill.js'
import * as std from 'std'
import * as gui from 'gui'
import * as win from 'win'
import * as ffi from 'ffi'
import { useState } from 'react'
import { render, Button, Input, ScrollView } from '../lib/react-qw/index.js'
import { PdfCanvas } from './PdfCanvas.js'

type MuPdf = typeof import('../vendor/mupdf-wasm/mupdf.js')

const _user32 = win.LoadLibrary('user32.dll')
const _gdi32 = win.LoadLibrary('gdi32.dll')
const _comdlg32 = win.LoadLibrary('comdlg32.dll')
if (!_user32 || !_gdi32 || !_comdlg32) {
  gui.MessageBox('Failed to load system libraries')
  std.exit(0)
}

function loadProc(lib: win.HMODULE, name: string): number {
  const ptr = win.GetProcAddress(lib, name)
  if (!ptr) throw new Error('Failed to load ' + name)
  return ptr
}

const GetOpenFileNameW_ = loadProc(_comdlg32, 'GetOpenFileNameW')
const FFI_PTR = ffi.FFI_TYPE_POINTER
const FFI_U32 = ffi.FFI_TYPE_UINT32

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

function openPdfFileDialog(owner: number): string | null {
  const structBuf = new ArrayBuffer(152)
  const sv = new DataView(structBuf)
  const fileBuf = new ArrayBuffer(260 * 2)
  const filterWide = strToWide('PDF Files\0*.pdf\0All Files\0*.*\0\0')

  sv.setUint32(0, 152, true)
  sv.setUint32(8, owner & 0xFFFFFFFF, true)
  sv.setUint32(12, Math.floor(owner / 0x100000000), true)

  setPtr(sv, 24, ffi.bufferPtr(filterWide))
  setPtr(sv, 48, ffi.bufferPtr(fileBuf))
  sv.setUint32(56, 260, true)

  sv.setUint32(96, 0x1000 | 0x0800 | 0x0004, true)

  const ret = ffi.ffiCall(GetOpenFileNameW_, [FFI_PTR], [structBuf], FFI_U32)
  if (!ret) return null

  const path = wideToStr(fileBuf)
  return path.length > 0 ? path : null
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

  ;(globalThis).$libmupdf_wasm_Module = {
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

interface PixmapInfo {
  data: ArrayBuffer
  w: number
  h: number
}

let cachedPath = ''
let cachedDoc: any = null
let cachedTotalPages = 0

function renderPdfPage(mupdf: MuPdf, filePath: string, pageIndex: number): PixmapInfo & { totalPages: number } | null {
  if (filePath !== cachedPath) {
    if (cachedDoc) { try { cachedDoc.destroy() } catch {} }
    cachedDoc = null
    cachedPath = ''
    cachedTotalPages = 0

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
      cachedPath = filePath
    } catch (e) {
      std.printf('Error opening document: %s\n', String(e))
      return null
    }
  }

  if (!cachedDoc) return null
  if (pageIndex >= cachedTotalPages) return null

  let page: any = null
  let pixmap: any = null
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
    if (cachedDoc) { try { cachedDoc.destroy() } catch {} }
    cachedDoc = null; cachedPath = ''; cachedTotalPages = 0
    return null
  } finally {
    if (pixmap) { try { pixmap.destroy() } catch {} }
    if (page) { try { page.destroy() } catch {} }
  }
}

function App({ mupdf, mainHwnd: hwnd }: { mupdf: MuPdf; mainHwnd: number }) {
  const [filePath, setFilePath] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const [pixmap, setPixmap] = useState<PixmapInfo | undefined>(undefined)
  const [totalPages, setTotalPages] = useState(0)

  function loadPage(path: string, page: number) {
    const result = renderPdfPage(mupdf, path, page)
    if (result) {
      setPixmap(result)
      setCurrentPage(page)
      setTotalPages(result.totalPages)
    } else {
      gui.MessageBox('Failed to render PDF page')
    }
  }

  function handleOpen() {
    const path = openPdfFileDialog(hwnd)
    if (path) {
      setFilePath(path)
      loadPage(path, 0)
    }
  }

  function handlePrev() {
    if (currentPage > 0) loadPage(filePath, currentPage - 1)
  }

  function handleNext() {
    if (currentPage < totalPages - 1) loadPage(filePath, currentPage + 1)
  }

  return (
    <w type="STATIC"
      ws={gui.WindowStyle.VISIBLE | gui.WindowStyle.CLIPCHILDREN}
      style={{ flexDirection: 'column', gap: 4, width: 1180, height: 720 }}
    >
      <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
        style={{ flexDirection: 'row', gap: 6, alignItems: 'stretch', height: 28 }}
      >
        <w type="STATIC" style={{ width: 6 }} />
        <Button onClick={handleOpen} style={{ width: 80 }}>Open</Button>
        <Input value={filePath} placeholder="File path..." readonly style={{ flexGrow: 1 }} />
        <Button onClick={handlePrev} disabled={currentPage <= 0} style={{ width: 60 }}>Prev</Button>
        <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
          text={totalPages > 0 ? `Page ${currentPage + 1} / ${totalPages}` : 'No file'}
          style={{ width: 120 }}
        />
        <Button onClick={handleNext} disabled={currentPage >= totalPages - 1} style={{ width: 60 }}>Next</Button>
        <w type="STATIC" style={{ width: 6 }} />
      </w>

      <ScrollView style={{ flexGrow: 1 }}>
        {pixmap ? (
          <PdfCanvas
            pixmap={pixmap}
            style={{ width: pixmap.w, height: pixmap.h }}
          />
        ) : (
          <w type="STATIC" ws={gui.WindowStyle.VISIBLE}
            text="Open a PDF file to preview"
            style={{ width: 300, height: 30 }}
          />
        )}
      </ScrollView>
    </w>
  )
}

async function main() {
  const mupdf = await loadMupdf()
  if (!mupdf) {
    gui.MessageBox('Loading mupdf WASM failed.\nEnsure vendor/mupdf-wasm/ is present.')
    return
  }

  gui.RegisterClass('PdfViewerWin')
  const hwnd = gui.CreateWindow(
    'PdfViewerWin', 'PDF Viewer',
    gui.WindowStyle.OVERLAPPEDWINDOW,
    100, 100, 1200, 800, null, null
  )

  if (hwnd) {
    render(<App mupdf={mupdf} mainHwnd={hwnd as number} />, hwnd)
    setTimeout(() => gui.ShowWindow(hwnd), 0)
  }
}

main()
