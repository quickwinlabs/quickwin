> [ä¸­æ–‡æ–‡æ¡£](README.md) Â· **English**

# QuickWin

QuickJS runtime for Windows, with native GUI, networking, WASM, FFI and more.

Goal: compatibility with Windows XP+ (32/64-bit) and a minimal binary size.

Currently: supports Windows 7+ (64-bit), ~1.5MB binary.

Early-stage project with known bugs.

Download directly from the GitHub Release:

```powershell
iwr https://github.com/xna00/quickwin/releases/latest/download/qwin.exe -OutFile qwin.exe
iwr https://github.com/xna00/quickwin/releases/latest/download/main.js -OutFile main.js
.\qwin.exe main.js
```

## Features

- **Win32 GUI** â€” native windows, buttons, edit boxes, list boxes, tray icons, popup menus
- **React renderer** â€” declarative GUI in JSX with `useState`/`useEffect`, diff updates ([react-qw](lib/react-qw/))
- **HTTP/HTTPS** â€” `fetch()` API, Brotli decompression, chunked transfer, conditional caching
- **WebSocket** â€” full RFC 6455 implementation, ws:// + wss://
- **WebAssembly** â€” WAMR-based, supports `WebAssembly.*` standard API
- **FFI** â€” call any DLL function via libffi
- **Polyfills** â€” `TextEncoder`, `URL`, `URLSearchParams`, `btoa`/`atob`, `crypto.subtle`, `setTimeout`
- **Dynamic import** â€” `import('https://esm.sh/...')`, no dependency installation needed

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

All unknown flags are transparently forwarded to `scriptArgs` â€” no error,
no consumption. Script file is the first non-flag argument after option parsing.

## Embedded Script

You can embed a JS script directly into the `qwin.exe` binary â€” no recompilation needed.

### Format (appended to exe)

```
[JS bytes (N)] [N: uint32 LE] [magic "QWJS"]
```

### Usage

```bash
# Embed a script
powershell -ExecutionPolicy Bypass -File scripts/embed-js.ps1 -ExePath _build/qwin.exe -JsFile script.js

# Or via make
make embed-js JS_EMBED=script.js

# Embed a script brotli-compressed (smaller exe, decompressed at runtime)
make embed-js-br JS_EMBED=script.js

# Run it (no file argument needed)
qwin.exe
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
| `preact` | `lib/preact/...` | JSX â†’ Win32 renderer (`render`, `useState`, `useEffect`) |
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
| `new os.Worker(specifier)` | Create worker. `specifier` is a file path or URL (supports `https://` for ESM imports) |
| `worker.postMessage(data)` | Send message (JSON-serializable) to worker |
| `worker.onmessage = fn` | Set callback for messages from worker. Set to `null` when done to release the message port |
| `os.Worker.parent` | (Worker side) reference to the parent thread |

### Cleanup

Both sides must set `onmessage = null` when communication is complete. This releases the message port so the event loop can exit cleanly. Forgetting to do so will cause the process to hang.

## Examples

```bash
.\qwin.exe examples/preact_demo.js   # counter GUI with JSX + hooks
.\qwin.exe examples/tray_demo.js     # system tray app
.\qwin.exe examples/pdf_preview.js   # PDF reader with mupdf
```

## Build from Source

### Prerequisites

- MSYS2 UCRT64 or MINGW64
- Node.js (for TypeScript compilation via tsc)
- Git (for submodules)

### Build

```bash
git clone --recursive https://github.com/anomalyco/quickwin.git
cd quickwin

.\run.ps1 "make wamr"       # build WAMR library (first time only)
.\run.ps1 "make minimal"    # build qwin.exe (-Os + LTO + UPX)
.\run.ps1 "make js"         # compile TypeScript
.\run.ps1 "make test"       # run all tests
```

`make nowasm` produces a smaller `_build/qwin-nowasm.exe` without WASM/WAMR
(no `WebAssembly` global); run `make test TEST=-wasm` to skip WASM tests on it.

### Build Targets

| Target | Description |
|--------|-------------|
| `make` / `make nodebug` | fast build |
| `make minimal` | `-Os` + LTO + `-mwindows` + UPX, no console, add `-o CON` for console |
| `make nowasm` | no WASM/WAMR build â†’ `_build/qwin-nowasm.exe` (~1.2MB, no `WebAssembly` global) |
| `make release` | `-O2` + LTO + strip, ~1.5MB |
| `make debug` | debug build with bridge logs |
| `make js` | compile TypeScript via tsc |
| `make wasm` | compile WAT â†’ WASM fixtures |
| `make test` | run all tests |
| `make test TEST=-net` | skip network tests (fast) |
| `make test TEST=wasm` | run WASM tests only |
| `make wamr` | rebuild WAMR library |
| `make embed-js` | embed `embed.js` into exe (use `JS_EMBED=file.js`) |
| `make embed-js-br` | embed brotli-compressed JS into exe |
| `make npm-pkg` | package into `dist/quickwin/` |
| `make clean` | clean build artifacts |

## License

MIT