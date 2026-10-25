> [中文文档](README.md) · **English**

# QuickWin

QuickJS runtime for Windows, with native GUI, networking, WASM, FFI and more.

Supports Windows XP+ (32/64-bit) with a minimal binary size (~1.5MB). The 32-bit build is CI-tested in a QEMU Windows XP VM.

## Quick Start

Scaffold a desktop app with [quickwin-starter](https://github.com/quickwinlabs/quickwin-starter):

```bash
npm create -y quickwin@latest myapp
cd myapp
npm install
npm run build        # produces dist\app.exe
```

The default template is React (JSX + system tray); `-- --template=minimal` starts from a bare skeleton.

## Features

- **Win32 GUI** — native windows, buttons, edit boxes, list boxes, tray icons, popup menus
- **React renderer** — declarative GUI in JSX with `useState`/`useEffect`, diff updates ([react-qw](lib/react-qw/))
- **HTTP/HTTPS** — `fetch()` API, Brotli decompression, chunked transfer, conditional caching
- **WebSocket** — full RFC 6455 implementation, ws:// + wss://
- **WebAssembly** — WAMR-based, supports `WebAssembly.*` standard API
- **FFI** — call any DLL function via a built-in asm stub and declarative `bind()` signatures (no third-party dependency, [usage guide](docs/usage/ffi.md))
- **Polyfills** — `TextEncoder`, `URL`, `URLSearchParams`, `btoa`/`atob`, `crypto.subtle`, `setTimeout`
- **Dynamic import** — `import('https://esm.sh/...')`, no dependency installation needed

## CLI

The runtime itself: install with `npm install quickwin`, or download `qwin.exe` and `main.js` from [Releases](https://github.com/quickwinlabs/quickwin/releases). The npm package ships 4 executables: `qwin.exe` (64-bit) / `qwin-x86.exe` (32-bit, XP-compatible) plus their no-WASM variants `qwin-nowasm.exe` / `qwin-nowasm-x86.exe`.

```bash
npx quickwin node_modules/quickwin/main.js   # run the bundled demo to see it working
quickwin script.js                  # run a script
quickwin -o CON script.js           # run with console (AllocConsole)
quickwin -o LOG script.js           # run with auto-generated log file
quickwin -e "console.log('hi')"     # execute expression
quickwin script.js --flag           # everything after the script goes to it
```

### Options

| Flag | Description |
|------|-------------|
| `-e <expr>` | Execute expression instead of a file |
| `-o CON` | Allocate console (`AllocConsole`); only needed for GUI-subsystem builds |
| `-o LOG` | Redirect stdout+stderr to `log_YYYY_MM_DD_HH_MM_SS.txt` (exe directory) |
| `-o <file>` | Redirect stdout+stderr to specified file |
| `-d` | Enable HTTP debug logging |

The command line parses in fixed slots: `exe [-d] [-o target] [-e code | file]`;
everything past the slots reaches `scriptArgs` untouched — no error, no
consumption. The file slot rejects `-`-leading names (run those as `./-name.js`).

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

# Embed a script brotli-compressed (smaller exe, decompressed at runtime)
node scripts/embed-js.mjs --exe _build/qwin.exe --js script.js --compress

# Bundle examples/execd/main.tsx and brotli-embed into execd.exe
make execd

# Run it (no file argument needed)
_build/execd.exe
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
| `ffi` | built-in | foreign function interface, low level (`LoadLibrary`, `GetProcAddress`, `ffiCall`) |
| `lib/ffi` | `import './lib/ffi/index.js'` | declarative FFI: `bind()` / `bindLib()` / `closure()` / `struct()` ([usage guide](docs/usage/ffi.md)) |
| `brotli` | built-in | Brotli decompression |
| `wamr` | built-in | low-level WAMR API |
| `fetch` | `import './lib/fetch.js'` | adds `fetch()`, `Request`/`Response`/`Headers` and their type declarations to globalThis |
| `websocket` | `import './lib/websocket.js'` | adds `WebSocket` to globalThis |
| `polyfill` | `import './lib/polyfill.js'` | adds `TextEncoder`, `URL`, `btoa`/`atob`, `setTimeout` to globalThis |
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

The example scripts live in the repository (**not shipped in the npm package**,
which only carries the exes, main.js, lib and the type declarations):

```bash
.\qwin.exe examples/tray_demo.js     # system tray app
.\qwin.exe examples/pdf_preview2.js  # PDF reader with mupdf
.\qwin.exe examples/test_tab.js      # tabbed GUI with JSX
```

## Build from Source

### Prerequisites

- **podman** (dev container; build/test/QEMU verification all run inside the container, consistent with CI)
- Git (for submodules)

### Build

```bash
git clone --recursive https://github.com/quickwinlabs/quickwin.git
cd quickwin

./docker/dev-podman.sh up      # start dev container (reuses ghcr.io/quickwinlabs/quickwin-dev)
podman exec quickwin-dev bash -lc 'cd /workspace && make js && make cc64 && make test TEST=-net'
```

`make cc64` produces `_build/qwin.exe`. `cc64-nowasm` produces a smaller
`_build/qwin-nowasm.exe` without WASM/WAMR (no `WebAssembly` global); for
that build run `make test TEST=-wasm` to skip WASM tests.

### Build Targets

| Target | Description |
|--------|-------------|
| `make cc64` | cross-compile x86_64 → `_build/qwin.exe` (default target, `BUILD=fast`) |
| `make cc32` | cross-compile i686/XP → `_build/qwin-x86.exe` |
| `make cc64-nowasm` / `cc32-nowasm` | no WASM/WAMR builds |
| `BUILD=fast\|small\|debug` | build flavor: `make cc64 BUILD=small` = `-Os`+LTO (~1.5MB, used by CI) |
| `make js` | compile TypeScript via tsc |
| `make wasm` | compile `test/*.wat` → WASM fixtures |
| `make test` | run all tests |
| `make test TEST=-net` | skip network tests (fast) |
| `make test TEST=wasm` | run WASM tests only |
| `make execd` | bundle `examples/execd/main.tsx` and brotli-embed into `_build/execd.exe` |
| `make npm-pkg` | package into `dist/quickwin/` |
| `make gen-const` | regenerate `constants.ts` (run `_build/gen_const.exe` in the VM) |
| `make clean` / `distclean` | clean (wipes all of `_build/`; afterwards run `make js wasm`) |

Build and troubleshooting details: `.agents/skills/workflow/SKILL.md`.

## License

MIT