import '../lib/polyfill.js'
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

export const suite = {
    name: 'mupdf-twice',
    run: async (t: Tester): Promise<void> => {
        try {
            console.log('  Loading WASM binary...')
            const wasmBinary = loadWasmBytes('./vendor/mupdf-wasm/mupdf-wasm.wasm')
            console.log('  WASM binary loaded, size:', wasmBinary.byteLength)

            ;(globalThis as any)["$libmupdf_wasm_Module"] = {
                wasmBinary,
                locateFile: (p: string) => p
            }

            console.log('  Importing mupdf module...')
            const mupdf: typeof import('../vendor/mupdf-wasm/mupdf.js') = await import('../vendor/mupdf-wasm/mupdf.js')
            console.log('  mupdf module imported ok')

            const fp = std.open('./example.pdf', 'rb')
            if (!fp) { console.log('SKIP: no example.pdf'); return }
            fp.seek(0, 2)
            const size = fp.tell()
            fp.seek(0, 0)
            const pdfBuf = new ArrayBuffer(size)
            fp.read(pdfBuf, 0, size)
            fp.close()
            console.log('  PDF loaded, size:', size)

            t.section('Test 1: two toPixmap on same page (no destroy)')
            try {
                const doc = mupdf.Document.openDocument(new Uint8Array(pdfBuf), "application/pdf")
                const page = doc.loadPage(0)

                console.log('  1: toPixmap #1...')
                const pm1 = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false)
                console.log('  1: toPixmap #1 done:', pm1.getWidth(), 'x', pm1.getHeight())
                t.check('toPixmap #1 ok', true, pm1 !== null)

                console.log('  1: toPixmap #2...')
                const pm2 = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false)
                console.log('  1: toPixmap #2 done:', pm2.getWidth(), 'x', pm2.getHeight())
                t.check('toPixmap #2 ok', true, pm2 !== null)
            } catch (e: any) {
                console.log('  1: ERROR:', e instanceof Error ? e.message : String(e))
            }

            t.section('Test 2: second openDocument + toPixmap (no destroy of first)')
            try {
                console.log('  2: openDocument #2...')
                const doc2 = mupdf.Document.openDocument(new Uint8Array(pdfBuf), "application/pdf")
                console.log('  2: loadPage #2...')
                const page2 = doc2.loadPage(0)
                console.log('  2: toPixmap #3...')
                const pm3 = page2.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false)
                console.log('  2: toPixmap #3 done:', pm3.getWidth(), 'x', pm3.getHeight())
                t.check('toPixmap #3 ok', true, pm3 !== null)
            } catch (e: any) {
                console.log('  2: ERROR:', e instanceof Error ? e.message : String(e))
            }

            console.log('All mupdf-twice tests done')
        } catch (e: any) {
            console.log('TOP-LEVEL ERROR:', e instanceof Error ? e.message : String(e))
        }
    }
}
