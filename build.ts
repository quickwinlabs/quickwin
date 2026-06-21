import { build } from 'esbuild'

const nativeModules = ['gui', 'os', 'std', 'sock', 'brotli', 'ffi', 'wamr', 'win', 'tls', 'wolfssl', '../lib/polyfill.js', '../vendor/mupdf-wasm/mupdf.js', '../vendor/mupdf-wasm/mupdf-wasm.js']

async function main() {
  await build({
    entryPoints: [
      '_build/test/test_react_counter.js',
      '_build/test/test_jsx.js',
      '_build/test/test_react_render.js',
      '_build/test/test_react_complex.js',
      '_build/test/test_react_flex.js',
      '_build/test/test_react_hidden.js',
      '_build/examples/test_gallery.js',
      '_build/examples/test_tab.js',
      '_build/examples/test_react_listbox.js',
      '_build/examples/pdf_viewer.js',
    ],
    allowOverwrite: true,
    bundle: true,
    external: nativeModules,
    format: 'esm',
    // platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'react',
    outdir: '.',
    outbase: '.',
    logLevel: 'warning',
    define: { 'DEBUG': 'false' },
    treeShaking: true,
    // minify: true
  })
  console.log('React bundles built')
}

main().catch(e => { console.error(e); process.exit(1) })
