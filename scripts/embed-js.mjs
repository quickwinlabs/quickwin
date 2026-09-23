#!/usr/bin/env node
// Embed JS at the end of an exe. Format (see main.c load_embedded_js):
//   [exe][js bytes][uint32 LE len][magic "QWJS"|"QWBR"]
// Strips a previous payload first so re-running does not grow the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, constants as zc } from 'node:zlib'

function usage(code) {
  console.error('usage: embed-js.mjs --exe <path> --js <path> [--compress]')
  process.exit(code)
}

const args = process.argv.slice(2)
let exePath, jsPath, compress = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--exe') exePath = args[++i]
  else if (a === '--js') jsPath = args[++i]
  else if (a === '--compress') compress = true
  else if (a === '-h' || a === '--help') usage(0)
  else {
    console.error(`unknown arg: ${a}`)
    usage(1)
  }
}
if (!exePath || !jsPath) usage(1)

let exe = readFileSync(exePath)

// strip previous embedded payload if present
if (exe.length >= 8) {
  const magic = exe.subarray(exe.length - 4).toString('ascii')
  if (magic === 'QWJS' || magic === 'QWBR') {
    const len = exe.readUInt32LE(exe.length - 8)
    const start = exe.length - 8 - len
    if (start >= 0 && start < exe.length) {
      exe = exe.subarray(0, start)
      console.log(`Stripped previous ${magic} payload (${len} bytes)`)
    }
  }
}

let js = readFileSync(jsPath)
let magic = 'QWJS'
if (compress) {
  js = brotliCompressSync(js, {
    params: {
      [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
      [zc.BROTLI_PARAM_QUALITY]: zc.BROTLI_MAX_QUALITY,
      [zc.BROTLI_PARAM_LGWIN]: zc.BROTLI_MAX_WINDOW_BITS,
    },
  })
  magic = 'QWBR'
}

const out = Buffer.alloc(exe.length + js.length + 8)
exe.copy(out, 0)
js.copy(out, exe.length)
out.writeUInt32LE(js.length, exe.length + js.length)
out.write(magic, exe.length + js.length + 4, 'ascii')
writeFileSync(exePath, out)

console.log(`Embedded ${js.length} bytes of ${compress ? 'brotli-compressed' : 'raw'} JS into ${exePath}`)
