import * as std from 'std'

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

setupMupdfModule('./vendor/mupdf-wasm/mupdf-wasm.wasm')
const mupdf = await import('../../vendor/mupdf-wasm/mupdf.js')

// Debug the instance exports
const inst = globalThis["$wasm_inst"]
const mod = globalThis["$wasm_mod"]
console.log('=== WASM Module exports (first 30) ===')
const modExports = WebAssembly.Module.exports(mod)
for (let i = 0; i < 30 && i < modExports.length; i++)
    console.log(`  ${i}: ${modExports[i].name} (${modExports[i].kind})`)

// Find Sf and Tf indices
let sf_idx = -1, tf_idx = -1
for (let i = 0; i < modExports.length; i++) {
    if (modExports[i].name === 'Sf') sf_idx = i
    if (modExports[i].name === 'Tf') tf_idx = i
}
console.log('Sf index:', sf_idx, 'Tf index:', tf_idx)
console.log('instance exports Sf:', typeof inst.exports['Sf'])
console.log('instance exports Tf:', typeof inst.exports['Tf'])

// Load a simple WASM to verify bridge works
const fp = std.open('./example.pdf', 'rb')
if (!fp) { console.log('cannot open example.pdf'); std.exit(1) }
fp.seek(0, 2)
const size = fp.tell()
fp.seek(0, 0)
const buf = new ArrayBuffer(size)
fp.read(buf, 0, size)
fp.close()
console.log('\npdf size:', size)

// Try calling lower-level functions directly
const lib = globalThis["$libmupdf_wasm_Module"]

// First open the document
const wasmMemory = inst.exports['cb']
console.log('WASM memory:', typeof wasmMemory, wasmMemory?.buffer?.byteLength)

// Create a buffer and try
const bufPtr = lib._wasm_malloc(size)
console.log('malloc buffer pointer:', bufPtr)
// Write PDF data into WASM memory at bufPtr...
const mem8 = new Uint8Array(wasmMemory.buffer)
for (let i = 0; i < size; i++) mem8[bufPtr + i] = (new Uint8Array(buf))[i]
console.log('wrote pdf data to WASM memory at', bufPtr)

// Try opening document directly with _wasm_open_document_with_buffer
// Need a string for "application/pdf"
const magicStr = "application/pdf\x00"
const magicPtr = lib._wasm_malloc(magicStr.length)
for (let i = 0; i < magicStr.length; i++) mem8[magicPtr + i] = magicStr.charCodeAt(i)
console.log('magic string at', magicPtr)

// Create a Buffer wrapper object - need to call Buffer constructor
// Actually let's just call the low-level function directly
const fz_ptr = inst.exports['Mf'](magicPtr, bufPtr) // _wasm_open_document_with_buffer
console.log('_wasm_open_document_with_buffer returned:', fz_ptr, typeof fz_ptr)

if (fz_ptr && typeof fz_ptr === 'number') {
    // Try countPages
    const count = inst.exports['Sf'](fz_ptr)
    console.log('_wasm_count_pages returned:', count, typeof count)
    
    // Try loadPage
    if (typeof fz_ptr !== 'number') {
        console.log('fz_ptr is not a number!')
    }
    const pagePtr = inst.exports['Tf'](fz_ptr, 0)
    console.log('_wasm_load_page returned:', pagePtr, typeof pagePtr)
    
    // Get bounds
    // _wasm_bound_page(Sf?) - need to find this export
    for (let i = 0; i < modExports.length; i++) {
        if (modExports[i].name.startsWith('Uf')) {
            console.log('Uf at index', i, '- likely _wasm_pdf_page_from_fz_page')
        }
        if (modExports[i].name.startsWith('Vf')) {
            console.log('Vf at index', i)
        }
    }
    
    // Try calling _wasm_pdf_page_from_fz_page (Uf)
    const pdfPtr = inst.exports['Uf'](pagePtr)
    console.log('_wasm_pdf_page_from_fz_page returned:', pdfPtr, typeof pdfPtr)
}

lib._wasm_free(magicPtr)
lib._wasm_free(bufPtr)
console.log('\ndone')
