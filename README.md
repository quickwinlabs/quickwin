# QuickWin

QuickJS Win32 runtime — run JavaScript with native Windows GUI, networking, WASM, FFI, and more.

```bash
npm i -g quickwin
quickwin script.js
```

## Features

- **Win32 GUI** — native windows, buttons, edit boxes, list boxes, tray icons, popup menus
- **Preact renderer** — declarative GUI in JSX with `useState`/`useEffect`, diff updates
- **HTTP/HTTPS** — `fetch()` API, Brotli decompression, chunked transfer, conditional caching
- **WebSocket** — full RFC 6455 implementation, ws:// + wss://
- **WebAssembly** — WAMR-based, supports `WebAssembly.*` standard API
- **FFI** — call any DLL function via libffi
- **mupdf** — embedded PDF rendering
- **Dynamic import** — `import('https://esm.sh/...')`, no npm install needed

## CLI

```bash
quickwin script.js                  # run a script
quickwin examples/preact_demo.js    # run an example
```

## Modules

| Module | Import | Description |
|--------|--------|-------------|
| `std` | built-in | file I/O, environment, URL download |
| `os` | built-in | filesystem, process, Worker, timer |
| `gui` | built-in | Win32 window/control/message/tray API |
| `sock` | built-in | socket networking |
| `wolfssl` | built-in | TLS/SSL |
| `ffi` | built-in | foreign function interface |
| `fetch` | `./lib/fetch.js` | `fetch()` API |
| `websocket` | `./lib/websocket.js` | WebSocket client |
| `polyfill` | `./lib/polyfill.js` | TextEncoder, URL, setTimeout polyfills |
| `preact` | `../lib/preact` | JSX → Win32 renderer |

## Examples

```bash
npx quickwin examples/preact_demo.js   # counter GUI with JSX + hooks
npx quickwin examples/tray_demo.js     # system tray app
npx quickwin examples/pdf_preview.js   # PDF reader with mupdf
```

## Build from Source

### Prerequisites

- MSYS2 UCRT64 or MINGW64
- Node.js (for TypeScript compilation via tsgo)
- Git (for submodules)

### Build

```bash
git clone --recursive https://github.com/anomalyco/quickwin.git
cd quickwin

.\run.ps1 "make wamr"       # build WAMR library (first time only)
.\run.ps1 "make minimal"    # build win.exe (-Os + LTO + UPX)
.\run.ps1 "make js"         # compile TypeScript
.\run.ps1 "make test"       # run all tests
```

### Build Targets

| Target | Description |
|--------|-------------|
| `make` / `make nodebug` | fast build |
| `make minimal` | `-Os` + LTO + UPX, ~1MB |
| `make release` | `-O2` + LTO + strip, ~2.5MB |
| `make debug` | debug build with bridge logs |
| `make js` | compile TypeScript via tsgo |
| `make wasm` | compile WAT → WASM fixtures |
| `make test` | run all tests |
| `make test TEST=-net` | skip network tests (fast) |
| `make test TEST=wasm` | run WASM tests only |
| `make wamr` | rebuild WAMR library |
| `make npm-pkg` | package into `dist/quickwin/` |
| `make clean` | clean build artifacts |

## License

MIT
