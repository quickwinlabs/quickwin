> [中文文档](README.md) · **English**

# QuickWin

QuickJS runtime for Windows, with native GUI, networking, WASM, FFI and more.

Supports Windows XP+ (32/64-bit) with a minimal binary size (~1.5MB). The 32-bit build is CI-tested in a QEMU Windows XP VM.

Early-stage project with known bugs.

Install:

```bash
# Option 1: npm local install (recommended)
npm install quickwin
npx quickwin script.js

# Option 2: download directly from GitHub Release
iwr https://github.com/xna00/quickwin/releases/latest/download/qwin.exe -OutFile qwin.exe
.\qwin.exe main.js
```

The npm package ships 4 executables: `qwin.exe` (64-bit) / `qwin-x86.exe` (32-bit, XP-compatible) plus their no-WASM variants `qwin-nowasm.exe` / `qwin-nowasm-x86.exe`.

## Features

- **Win32 GUI** — native windows, buttons, edit boxes, list boxes, tray icons, popup menus
- **React renderer** — declarative GUI in JSX with `useState`/`useEffect`, diff updates ([react-qw](lib/react-qw/))
- **HTTP/HTTPS** — `fetch()` API, Brotli decompression, chunked transfer, conditional caching
- **WebSocket** — full RFC 6455 implementation, ws:// + wss://
- **WebAssembly** — WAMR-based, supports `WebAssembly.*` standard API
- **FFI** — call any DLL function via libffi
- **Polyfills** — `TextEncoder`, `URL`, `URLSearchParams`, `btoa`/`atob`, `crypto.subtle`, `setTimeout`
- **Dynamic import** — `import('https://esm.sh/...')`, no dependency installation needed

## CLI

```bash
quickwin script.js                  # run a script
quickwin -o CON script.js           # run with console (AllocConsole)
quickwin -o LOG script.js           # run with auto-generated log file
quickwin -e "console.log('hi')"     # execute expression
quickwin -- script.js --flag        # -- stops option parsing
```

### Options

| Flag | Description |
|------|-------------|
| `-e <expr>` | Execute expression instead of a file |
| `-o CON` | Allocate console (`AllocConsole`); only needed for GUI-subsystem builds |
| `-o LOG` | Redirect stdout+stderr to `log_YYYY_MM_DD_HH_MM_SS.txt` (exe directory) |
| `-o <file>` | Redirect stdout+stderr to specified file |
| `-d` | Enable HTTP debug logging |
| `--` | Stop option parsing, remaining args passed to script |

All unknown flags are transparently forwarded to `scriptArgs` — no error,
no consumption. Script file is the first non-flag argument after option parsing.

## Embedded Script

You can embed a JS script directly into the `qwin.exe` binary — no recompilation needed.

### Format (appended to exe)

```
[JS bytes (N)] [N: uint32 LE] [magic "QWJS"]
```

### Usage

```bash
# Embed a script
node scripts/embed-js.mjs --exe _build/qwin.exe --js script.js

# Or via make
make embed-js JS_EMBED=script.js

# Embed a script brotli-compressed (smaller exe, decompressed at runtime)
make embed-js-br JS_EMBED=script.js

# Bundle examples/exec_server.ts and brotli-embed into exec_server.exe
make exec_server

# Run it (no file argument needed)
_build/exec_server.exe
```

When run without a script file argument, `qwin.exe` checks for embedded JS at the end of itself. If found, it executes the embedded code. If not, it falls back to `main.js`. Both raw (`QWJS`) and brotli-compressed (`QWBR`) embedded payloads are supported; the compressed form is decompressed at startup.

## Modules

| Module | Import | Description |
|--------|--------|-------------|
| `std` | built-in | file I/O, environment, URL download |
| `os` | built-in | filesystem, process, Worker, timer |
| `gui` | built-in | Win32 window/control/message/tray API |
| `sock` | built-in | socket networking (`AddrFamily`, `FdEvent` etc.) |
| `wolfssl` | built-in | TLS/SSL (`VerifyMode`, `ReturnCode` etc.) |
| `ffi` | built-in | foreign function interface |
| `win` | built-in | DLL loading (`LoadLibrary`, `GetProcAddress`) |
| `brotli` | built-in | Brotli decompression |
| `wamr` | built-in | low-level WAMR API |
| `fetch` | `import './lib/fetch.js'` | adds `fetch()`, `Response`, `Headers` to globalThis |
| `websocket` | `import './lib/websocket.js'` | adds `WebSocket` to globalThis |
| `polyfill` | `import './lib/polyfill.js'` | adds `TextEncoder`, `URL`, `btoa`/`atob`, `setTimeout` to globalThis |
| `preact` | `lib/preact/...` | JSX → Win32 renderer (`render`, `useState`, `useEffect`) |
| `react-qw` | `lib/react-qw/` | React Custom Renderer for Win32 GUI ([docs](lib/react-qw/)) |

## Worker

Spawn background threads for CPU-bound or I/O-bound work. Workers run in separate QuickJS runtimes with their own event loops.

### Main Thread

```js
import * as os from 'os'

const worker = new os.Worker('./worker.js')

worker.onmessage = (e) => {
    console.log('received:', e.data)
    worker.onmessage = null  // clean up when done
}

worker.postMessage({ type: 'start', value: 42 })
```

### Worker Thread

```js
// worker.js
import * as os from 'os'

const parent = os.Worker.parent

parent.onmessage = (e) => {
    if (e.data.type === 'start') {
        parent.postMessage({ type: 'result', value: e.data.value * 2 })
    } else if (e.data.type === 'done') {
        parent.onmessage = null  // clean up to allow event loop exit
    }
}
```

### API

| API | Description |
|-----|-------------|
| `new os.Worker(specifier)` | Create worker. `specifier` is a file path or URL (supports `https://` and `data:text/javascript;base64,`) |
| `worker.postMessage(data)` | Send message (JSON-serializable) to worker |
| `worker.onmessage = fn` | Set callback for messages from worker. Set to `null` when done to release the message port |
| `os.Worker.parent` | (Worker side) reference to the parent thread |

### Cleanup

Both sides must set `onmessage = null` when communication is complete. This releases the message port so the event loop can exit cleanly. Forgetting to do so will cause the process to hang.

## Examples

```bash
.\qwin.exe examples/tray_demo.js     # system tray app
.\qwin.exe examples/pdf_preview2.js  # PDF reader with mupdf
.\qwin.exe examples/test_tab.js      # tabbed GUI with JSX
```

## Build from Source

### Prerequisites

- MSYS2 UCRT64 or MINGW64
- Node.js (for TypeScript compilation via tsc)
- Git (for submodules)

### Build

```bash
git clone --recursive https://github.com/xna00/quickwin.git
cd quickwin

.\run.ps1 "make wamr"       # build WAMR library (first time only)
.\run.ps1 "make small"      # build qwin.exe (-Os + LTO, ~1.5MB)
.\run.ps1 "make js"         # compile TypeScript
.\run.ps1 "make test"       # run all tests
```

`make nowasm` produces a smaller `_build/qwin-nowasm.exe` without WASM/WAMR
(no `WebAssembly` global); run `make test TEST=-wasm` to skip WASM tests on it.

### Build Targets

| Target | Description |
|--------|-------------|
| `make` / `make nodebug` | fast build |
| `make small` | `-Os` + LTO + strip, ~1.5MB (recommended) |
| `make minimal` | `small` + UPX compression |
| `make release` | `-O2` + LTO + strip (not `-Os` optimized) |
| `make debug` | debug build with bridge logs |
| `make nowasm` | no WASM/WAMR build → `_build/qwin-nowasm.exe` (~1.2MB, no `WebAssembly` global) |
| `make cc64-small` | cross-compile x86_64 `_build/qwin.exe` (`-Os`, used by CI) |
| `make cc32-small` | cross-compile i686 `_build/qwin-x86.exe` (`-Os`, XP-compatible, used by CI) |
| `make js` | compile TypeScript via tsc |
| `make wasm` | compile WAT → WASM fixtures |
| `make test` | run all tests |
| `make test TEST=-net` | skip network tests (fast) |
| `make test TEST=wasm` | run WASM tests only |
| `make wamr` | rebuild WAMR library |
| `make embed-js` | embed `embed.js` into exe (use `JS_EMBED=file.js`) |
| `make embed-js-br` | embed brotli-compressed JS into exe |
| `make exec_server` | Bundle `examples/exec_server.ts` and brotli-embed into `_build/exec_server.exe` |
| `make npm-pkg` | package into `dist/quickwin/` |
| `make clean` | clean build artifacts |

## License

MIT