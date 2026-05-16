import * as std from 'std'
import { Tester } from './test_helper.js'

function loadWasmBytes(path: string): ArrayBuffer {
    const fp = std.open(path, 'rb')
    if (!fp) throw new Error('Cannot open: ' + path)
    fp.seek(0, 2)
    const size = fp.tell()
    fp.seek(0, 0)
    const buffer = new ArrayBuffer(size)
    fp.read(buffer, 0, size)
    fp.close()
    return buffer
}

function setupMupdfModule(wasmPath: string) {
    const wasmBinary = loadWasmBytes(wasmPath)
    ;(globalThis as any)["$libmupdf_wasm_Module"] = {
        wasmBinary,
        locateFile: (p: string) => p
    }
}

export const suite = {
    name: 'mupdf-render',
    run: async (t: Tester): Promise<void> => {
        try {
            setupMupdfModule('./mupdf-wasm/mupdf-wasm.wasm')

            const mupdf: typeof import('../mupdf-wasm/mupdf.js') = await import('../mupdf-wasm/mupdf.js')

            const fp = std.open('./example.pdf', 'rb')
            if (!fp) { console.log('SKIP: no example.pdf'); return }
            fp.seek(0, 2)
            const size = fp.tell()
            fp.seek(0, 0)
            const buf = new ArrayBuffer(size)
            fp.read(buf, 0, size)
            fp.close()
            console.log('pdf size:', size)

            const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf")
            console.log('pages:', doc.countPages())

            const page = doc.loadPage(0)
            const bounds = page.getBounds()
            if (bounds && bounds.length === 4)
                console.log('page size:', bounds[2] - bounds[0], 'x', bounds[3] - bounds[1])

            const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false)
            if (pixmap) {
                console.log('pixmap:', pixmap.getWidth(), 'x', pixmap.getHeight())
                const png = pixmap.asPNG()
                console.log('png size:', png.byteLength)
                const out = std.open('./output.png', 'wb')
                if (out) {
                    const pngBuf = new ArrayBuffer(png.byteLength)
                    new Uint8Array(pngBuf).set(png)
                    out.write(pngBuf, 0, png.byteLength)
                    out.close()
                }
                console.log('saved to output.png')
            }

            doc.destroy()
            console.log('done')
            t.ok++
        } catch (error) {
            console.log('ERROR:', error)
            t.fail++
        }
    }
}
