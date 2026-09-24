import { build } from 'esbuild'

const nativeModules = ['gui', 'os', 'std', 'sock', 'brotli', 'ffi', 'wamr', 'win', 'tls', 'wolfssl', '../lib/polyfill.js', '../vendor/mupdf-wasm/mupdf.js', '../vendor/mupdf-wasm/mupdf-wasm.js']

async function buildExecWorkerDataUrl(): Promise<string> {
  const result = await build({
    entryPoints: ['_build/examples/exec_server_worker.js'],
    bundle: true,
    external: nativeModules,
    format: 'esm',
    minify: true,
    write: false,
    logLevel: 'warning',
  })
  const js = result.outputFiles[0].text
  const b64 = Buffer.from(js, 'utf8').toString('base64')
  return 'data:text/javascript;base64,' + b64
}

async function main() {
  const workerDataUrl = await buildExecWorkerDataUrl()
  console.log('exec_worker data URL length=' + workerDataUrl.length)

  await build({
    entryPoints: [
      '_build/test/test_react_counter.js',
      '_build/test/test_jsx.js',
      '_build/test/test_react_render.js',
      '_build/test/test_react_complex.js',
      '_build/test/test_react_flex.js',
      '_build/test/test_react_hidden.js',
      '_build/test/test_react_listview_link.js',
      '_build/examples/test_gallery.js',
      '_build/examples/test_tab.js',
      '_build/examples/test_react_listbox.js',
      '_build/examples/pdf_viewer.js',
      '_build/examples/test_root_window.js',
      '_build/examples/test_react_lazy.js',
      '_build/examples/exec_server.js',
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
    define: {
      'DEBUG': 'false',
      'WORKER_DATA_URL': JSON.stringify(workerDataUrl),
    },
    treeShaking: true,
    // minify: true
  })
  console.log('Bundles built')
}

main().catch(e => { console.error(e); process.exit(1) })
