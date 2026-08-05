/// <reference path="quickwin_const.d.ts" />
interface ImportMeta {
    url: string
}

/** Provides the command line arguments. The first argument is the script name. */
declare var scriptArgs: string[];
/** Print the arguments separated by spaces and a trailing newline. */
declare function print(...args: unknown[]): void;
/** Same as print(). */
declare const console: Console

declare const navigator: {
    appVersion: string
    userAgent: string
}

interface Console {
    /** Same as print(). */
    log: (...args: unknown[]) => void
}


type UnknownRecord = Record<string, unknown>

declare namespace WebAssembly {
    interface Module { }
    interface Instance<E extends UnknownRecord = UnknownRecord> {
        exports: E
    }
    interface Global {
        value: unknown
        valueOf(): unknown
    }
    interface GlobalDescriptor {
        value: 'i32' | 'i64' | 'f32' | 'f64'
        mutable?: boolean
    }
    interface Memory {
        readonly buffer: ArrayBuffer
        grow(delta: number): number
    }
    interface MemoryDescriptor {
        initial: number
        maximum?: number
    }
}

declare const WebAssembly: {
    validate(buffer: ArrayBuffer): boolean
    compile(buffer: ArrayBuffer): Promise<WebAssembly.Module>
    instantiate<E extends UnknownRecord = UnknownRecord>(buffer: ArrayBuffer, importObject?: unknown): Promise<{ module: WebAssembly.Module; instance: WebAssembly.Instance<E> }>
    instantiate<E extends UnknownRecord = UnknownRecord>(module: WebAssembly.Module, importObject?: unknown): Promise<WebAssembly.Instance<E>>
    Module: {
        new(buffer: ArrayBuffer): WebAssembly.Module
        exports(module: WebAssembly.Module): { name: string; kind: string }[]
        imports(module: WebAssembly.Module): { module: string; name: string; kind: string }[]
    }
    Instance: {
        /**
         * WAMR 限制：
         * - 导入的 Global 在实例化时会 snapshot 值，之后无法与宿主或其他实例共享
         * - 不支持 mutable imported global 的实时同步
         */
        new<E extends UnknownRecord = UnknownRecord>(module: WebAssembly.Module, importObject?: unknown): WebAssembly.Instance<E>
    }
    Global: {
        new(descriptor: WebAssembly.GlobalDescriptor, value?: unknown): WebAssembly.Global
    }
    Memory: {
        new(descriptor: WebAssembly.MemoryDescriptor): WebAssembly.Memory
    }
}

interface Event {
    readonly type: string;
}

interface MessageEvent {
    readonly type: string;
    readonly data: unknown;
}

interface CloseEvent {
    readonly type: string;
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
}

declare module "std" {
    interface FILE {
        /** Close the file. Return 0 if OK or `-errno` in case of I/O error. */
        close(): number;
        /** Outputs the string with the UTF-8 encoding. */
        puts(str: string): void;
        /**
         * Formatted printf.
         * The same formats as the standard C library `printf` are supported.
         * Integer format types (e.g. `%d`) truncate the Numbers or BigInts to 32 bits.
         * Use the `l` modifier (e.g. `%ld`) to truncate to 64 bits.
         */
        printf(fmt: string, ...args: unknown[]): void;
        /** Flush the buffered file. */
        flush(): void;
        /** Seek to a give file position (whence is `std.SEEK_*`). `offset` can be a number or a bigint. Return 0 if OK or `-errno` in case of I/O error. */
        seek(offset: number | bigint, whence: number): number;
        /** Return the current file position. */
        tell(): number;
        /** Return the current file position as a bigint. */
        tello(): bigint;
        /** Return true if end of file. */
        eof(): boolean;
        /** Return the associated OS handle. */
        fileno(): import("os").Fd;
        /** Return true if there was an error. */
        error(): boolean;
        /** Clear the error indication. */
        clearerr(): void;
        /** Read `length` bytes from the file to the ArrayBuffer `buffer` at byte position `position` (wrapper to the libc `fread`). */
        read(buffer: ArrayBuffer, position: number, length: number): number;
        /** Write `length` bytes to the file from the ArrayBuffer `buffer` at byte position `position` (wrapper to the libc `fwrite`). */
        write(buffer: ArrayBuffer, position: number, length: number): number;
        /** Return the next line from the file, assuming UTF-8 encoding, excluding the trailing line feed. */
        getline(): string | null;
        /** Read `max_size` bytes from the file and return them as a string assuming UTF-8 encoding. If `max_size` is not present, the file is read up its end. */
        readAsString(max_size?: number): string | null;
        /** Return the next byte from the file. Return -1 if the end of file is reached. */
        getByte(): number;
        /** Write one byte to the file. */
        putByte(c: number): void;
    }

    interface UrlGetOptions {
        /** Boolean (default = false). If true, the response is an ArrayBuffer instead of a string. */
        binary?: boolean;
        /** Boolean (default = false). If true, return the an object contains the properties `response`, `responseHeaders`, `status`. */
        full?: boolean;
    }

    interface UrlGetFullResult {
        response: string | ArrayBuffer | null;
        responseHeaders: string;
        status: number;
    }

    interface EvalScriptOptions {
        /** Boolean (default = false). If true, error backtraces do not list the stack frames below the evalScript. */
        backtrace_barrier?: boolean;
        /** Boolean (default = false). If true, `await` is accepted in the script and a promise is returned. */
        async?: boolean;
    }

    /** Exit the process. */
    function exit(n: number): never;
    /** Evaluate the string `str` as a script (global eval). */
    function evalScript(str: string, options?: EvalScriptOptions): unknown;
    /** Evaluate the file `filename` as a script (global eval). */
    function loadScript(filename: string): unknown;
    /** Load the file `filename` and return it as a string assuming UTF-8 encoding. Return `null` in case of I/O error. */
    function loadFile(filename: string): string | null;
    /** Open a file (wrapper to the libc `fopen()`). Return the FILE object or `null` in case of I/O error. If `errorObj` is not undefined, set its `errno` property to the error code or to 0 if no error occured. */
    function open(filename: string, flags: string, errorObj?: { errno: number }): FILE | null;
    /** Open a process by creating a pipe (wrapper to the libc `popen()`). Return the FILE object or `null` in case of I/O error. If `errorObj` is not undefined, set its `errno` property to the error code or to 0 if no error occured. */
    function popen(command: string, flags: string, errorObj?: { errno: number }): FILE | null;
    /** Open a file from a file handle (wrapper to the libc `fdopen()`). Return the FILE object or `null` in case of I/O error. If `errorObj` is not undefined, set its `errno` property to the error code or to 0 if no error occured. */
    function fdopen(fd: number, flags: string, errorObj?: { errno: number }): FILE | null;
    /** Open a temporary file. Return the FILE object or `null` in case of I/O error. If `errorObj` is not undefined, set its `errno` property to the error code or to 0 if no error occured. */
    function tmpfile(errorObj?: { errno: number }): FILE | null;
    /** Equivalent to `std.out.puts(str)`. */
    function puts(str: string): void;
    /** Equivalent to `std.out.printf(fmt, ...args)`. */
    function printf(fmt: string, ...args: unknown[]): void;
    /** Equivalent to the libc sprintf(). */
    function sprintf(fmt: string, ...args: unknown[]): string;

    /** Wrappers to the libc file `stdout`. */
    const out: FILE;
    /** Wrappers to the libc file `stderr`. */
    const err: FILE;

    /**
     * Enumeration object containing the integer value of common errors
     * (additional error codes may be defined):
     */
    namespace Error {
        const EINVAL: number;
        const EIO: number;
        const EACCES: number;
        const EEXIST: number;
        const ENOSPC: number;
        const ENOSYS: number;
        const EBUSY: number;
        const ENOENT: number;
        const EPERM: number;
        const EPIPE: number;
        const EBADF: number;
    }

    /**
     * Parse `str` using a superset of `JSON.parse`. The superset is very close to the JSON5 specification.
     * Extensions: comments, unquoted properties, trailing comma, single quoted strings, hex/octal/binary integers, NaN, Infinity, etc.
     */
    function parseExtJSON(str: string): unknown;
    function __printObject(val: unknown): void;
    /** Return a string that describes the error `errno`. */
    function strerror(errno: number): string;
    /** Manually invoke the cycle removal algorithm. The cycle removal algorithm is automatically started when needed, so this function is useful in case of specific memory constraints or for testing. */
    function gc(): void;
    /** Return the value of the environment variable `name` or `undefined` if it is not defined. */
    function getenv(name: string): string | undefined;
    /** Set the value of the environment variable `name` to the string `value`. */
    function setenv(name: string, value: string): void;
    /** Delete the environment variable `name`. */
    function unsetenv(name: string): void;
    /** Return an object containing the environment variables as key-value pairs. */
    function getenviron(): Record<string, string>;
    /** Download `url` using the curl command line utility. */
    function urlGet(url: string, options?: UrlGetOptions): string | ArrayBuffer | UrlGetFullResult | null;

    /** Constants for seek(). */
    const SEEK_SET: number;
    const SEEK_CUR: number;
    const SEEK_END: number;
}

/** Wrappers to the libc file `stdin`. */
declare module "std" {
    const _in: FILE;
    export { _in as in };
}

declare module "os" {
    type Fd = number & { readonly __brand: unique symbol };

    interface StatResult {
        dev: number;
        ino: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        size: number;
        blocks: number;
        atime: number;
        mtime: number;
        ctime: number;
    }

    /** Open a file. Return a handle or < 0 if error. */
    function open(filename: string, flags: number, mode?: number): Fd | null;
    /** Close the file handle `fd`. */
    function close(fd: Fd): number;
    /** Seek in the file. Use `std.SEEK_*` for `whence`. `offset` is either a number or a bigint. If `offset` is a bigint, a bigint is returned too. */
    function seek(fd: Fd, offset: number | bigint, whence: number): number | bigint;
    /** Read `length` bytes from the file handle `fd` to the ArrayBuffer `buffer` at byte position `offset`. Return the number of read bytes or < 0 if error. */
    function read(fd: Fd, buffer: ArrayBuffer, offset: number, length: number): number;
    /** Write `length` bytes to the file handle `fd` from the ArrayBuffer `buffer` at byte position `offset`. Return the number of written bytes or < 0 if error. */
    function write(fd: Fd, buffer: ArrayBuffer, offset: number, length: number): number;
    /** Return `true` if `fd` is a TTY (terminal) handle. */
    function isatty(fd: Fd): boolean;
    /** Return the TTY size as `[width, height]` or `null` if not available. */
    function ttyGetWinSize(fd: Fd): [number, number] | null;
    /** Set the TTY in raw mode. */
    function ttySetRaw(fd: Fd): void;
    /** Remove a file. Return 0 if OK or `-errno`. */
    function remove(filename: string): number;
    /** Rename a file. Return 0 if OK or `-errno`. */
    function rename(oldname: string, newname: string): number;
    /** Return `[str, err]` where `str` is the canonicalized absolute pathname of `path` and `err` the error code. */
    function realpath(path: string): [string, number];
    /** Return `[str, err]` where `str` is the current working directory and `err` the error code. */
    function getcwd(): [string, number];
    /** Change the current directory. Return 0 if OK or `-errno`. */
    function chdir(path: string): number;
    /** Create a directory at `path`. Return 0 if OK or `-errno`. */
    function mkdir(path: string, mode?: number): number;
    /** Return `[obj, err]` where `obj` is an object containing the file status of `path`. `err` is the error code. */
    function stat(path: string): [StatResult, number];
    /** Change the access and modification times of the file `path`. The times are specified in milliseconds since 1970. Return 0 if OK or `-errno`. */
    function utimes(path: string, atime: number, mtime: number): number;
    /** Return `[array, err]` where `array` is an array of strings containing the filenames of the directory `path`. `err` is the error code. */
    function readdir(path: string): [string[], number];
    /** Add a read handler to the file handle `fd`. `func` is called each time there is data pending for `fd`. A single read handler per file handle is supported. Use `func = null` to remove the handler. */
    function setReadHandler(fd: Fd, func: (() => void) | null): void;
    /** Add a write handler to the file handle `fd`. `func` is called each time data can be written to `fd`. A single write handler per file handle is supported. Use `func = null` to remove the handler. */
    function setWriteHandler(fd: Fd, func: (() => void) | null): void;
    /** Call the function `func` when the signal `signal` happens. Only a single handler per signal number is supported. Use `null` to set the default handler or `undefined` to ignore the signal. Signal handlers can only be defined in the main thread. */
    function signal(signal: number, func: (() => void) | null | undefined): void;
    /** Sleep during `delay_ms` milliseconds. */
    function sleep(delay_ms: number): void;
    /** Asynchronouse sleep during `delay_ms` milliseconds. Returns a promise. */
    function sleepAsync(delay_ms: number): Promise<void>;
    /** Return a timestamp in milliseconds with more precision than `Date.now()`. */
    function now(): number;
    type TimerId = number & { readonly __brand: unique symbol };
    /** Call the function `func` after `delay` ms. Return a handle to the timer. */
    function setTimeout(func: () => void, delay: number): TimerId;
    /** Cancel a timer. */
    function clearTimeout(id: TimerId): void;

    /** POSIX open flags. */
    const O_RDONLY: number;
    const O_WRONLY: number;
    const O_RDWR: number;
    const O_APPEND: number;
    const O_CREAT: number;
    const O_EXCL: number;
    const O_TRUNC: number;
    /** (Windows specific). Open the file in text mode. The default is binary mode. */
    const O_BINARY: number;
    /** (Windows specific). Open the file in text mode. The default is binary mode. */
    const O_TEXT: number;

    /** POSIX signal numbers. */
    const SIGINT: number;
    const SIGABRT: number;
    const SIGFPE: number;
    const SIGILL: number;
    const SIGSEGV: number;
    const SIGTERM: number;

    /** Constants to interpret the `mode` property returned by `stat()`. They have the same value as in the C system header `sys/stat.h`. */
    const S_IFMT: number;
    const S_IFIFO: number;
    const S_IFCHR: number;
    const S_IFDIR: number;
    const S_IFBLK: number;
    const S_IFREG: number;

    class Worker {
        /** Constructor to create a new thread (worker) with an API close to the `WebWorkers`. `module_filename` is a string specifying the module filename which is executed in the newly created thread. */
        constructor(module_filename: string);
        /** Send a message to the corresponding worker. `msg` is cloned in the destination worker using an algorithm similar to the `HTML` structured clone algorithm. */
        postMessage(msg: unknown): void;
        /** Getter and setter. Set a function which is called each time a message is received. The function is called with a single argument. It is an object with a `data` property containing the received message. */
        onmessage: ((event: { data: unknown }) => void) | null;
        /** In the created worker, `Worker.parent` represents the parent worker and is used to send or receive messages. */
        static parent: Worker;
    }

    /** Return a string representing the platform: `"linux"`, `"darwin"`, `"win32"` or `"js"`. */
    const platform: string;
}

declare module "sock" {
    type SockHandle = number & { readonly __brand: unique symbol };
    type SockFd = number & { readonly __brand: unique symbol };

    function socket(domain?: AddrFamily, type?: SockType, protocol?: Protocol): SockHandle;
    function connect(sock: SockHandle, addr: string, port: number): number;
    function send(sock: SockHandle, buf: ArrayBuffer, flags?: number): number;
    function recv(sock: SockHandle, size?: number, flags?: number): ArrayBuffer | null;
    function closesocket(sock: SockHandle): void;
    function shutdown(sock: SockHandle, how: Shutdown): number;
    function set_on_event(sock: SockHandle, callback: (events: { lNetworkEvents: number; iErrorCode: number[] }) => void): void;
    function get_fd(sock: SockHandle): SockFd;
    function resolve(hostname: string): string | null;

}

declare module "wolfssl" {
    type WOLFSSL = number & { readonly __brand: unique symbol };
    type WOLFSSL_CTX = number & { readonly __brand: unique symbol };
    type WOLFSSL_METHOD = number & { readonly __brand: unique symbol };

    function wolfSSL_library_init(): number;
    function wolfSSL_CTX_new(method: WOLFSSL_METHOD): WOLFSSL_CTX | null;
    function wolfSSL_CTX_free(ctx: WOLFSSL_CTX): void;
    function wolfSSL_CTX_set_verify(ctx: WOLFSSL_CTX, mode: VerifyMode): number;
    function wolfSSL_CTX_use_certificate_file(ctx: WOLFSSL_CTX, file: string, format?: FileType): number;
    function wolfSSL_CTX_use_PrivateKey_file(ctx: WOLFSSL_CTX, file: string, format?: FileType): number;

    function wolfSSL_new(ctx: WOLFSSL_CTX): WOLFSSL | null;
    function wolfSSL_free(ssl: WOLFSSL): void;
    function wolfSSL_set_fd(ssl: WOLFSSL, fd: import("sock").SockFd): number;
    function wolfSSL_connect(ssl: WOLFSSL): number;
    function wolfSSL_shutdown(ssl: WOLFSSL): number;
    function wolfSSL_write(ssl: WOLFSSL, buf: ArrayBuffer): number;
    function wolfSSL_read(ssl: WOLFSSL, sz: number): ArrayBuffer | null;
    function wolfSSL_get_error(ssl: WOLFSSL, ret: number): number;
    function wolfSSL_UseSNI(ssl: WOLFSSL, type: SniType, name: string, len?: number): number;

    function wolfSSLv23_client_method(): WOLFSSL_METHOD;
    function wolfTLSv1_2_client_method(): WOLFSSL_METHOD;
    function wolfTLSv1_3_client_method(): WOLFSSL_METHOD;

}

declare module "win" {
    type HMODULE = number & { readonly __label: unique symbol };

    function LoadLibrary(libName: string): HMODULE | null;
    function GetProcAddress(hModule: HMODULE, procName: string): number | null;
    function FreeLibrary(hModule: HMODULE): boolean;
    /** GetModuleFileName(hModule?) — 传 HMODULE 或不传（当前进程），返回模块完整路径；失败返回 undefined */
    function GetModuleFileName(hModule?: HMODULE): string | undefined;
    /** GetModuleHandle(moduleName?) — 不传返回当前 exe 的模块句柄；失败返回 null */
    function GetModuleHandle(moduleName?: string): HMODULE | null;
}

declare module "gui" {
    type HWND = number & { readonly __label: unique symbol };
    type HMENU = number & { readonly __label: unique symbol };
    type HFONT = number & { readonly __label: unique symbol };
    type HICON = number & { readonly __label: unique symbol };
    type WNDPROC = number & { readonly __label: unique symbol };

    function RegisterClass(className: string, wndProc?: (hwnd: HWND, msg: number, wParam: number, lParam: number) => number): number;
    function CreateWindow(className: string, title: string, style: number, x: number, y: number, width: number, height: number, parent: HWND | null, menu: HMENU | null): HWND | null;
    // 销毁窗口及其所有子窗口，自动清理 WNDPROC 和 JS 引用
    function DestroyWindow(hwnd: HWND): boolean;
    function GetWindow(hwnd: HWND, cmd: GetWindowCmd): HWND;

    function ShowWindow(hwnd: HWND, nCmdShow?: ShowWindowCmd): void;
    function SetWindowProc(hwnd: HWND, wndProc: (hwnd: HWND, msg: number, wParam: number, lParam: number) => number): void;
    function DefWindowProc(hwnd: HWND, msg: number, wParam: number, lParam: number): number;
    function PostQuitMessage(exitCode: number): void;
    function SendMessage(hwnd: HWND, msg: number, wParam: number, lParam: number | string): number;
    function MessageBox(message: string): void;
    function SetWindowText(hwnd: HWND, text: string): void;
    function GetWindowText(hwnd: HWND): string;
    function GetScaleFactor(): number;
    function CreateSystemDpiFont(): HFONT | null;
    type GwlpReturnType<T extends Gwlp> = T extends Gwlp.WNDPROC ? WNDPROC : number;
    function GetWindowLongPtr<T extends Gwlp>(hwnd: HWND, nIndex: T): GwlpReturnType<T>;
    function SetWindowLongPtr(hwnd: HWND, nIndex: Gwlp, newLong: number): number;
    function UnsetWindowProc(hwnd: HWND): boolean;
    function CallWindowProc(wndProc: WNDPROC, hwnd: HWND, msg: number, wParam: number, lParam: number): number;
    function SetParent(hwnd: HWND, parent: HWND | null): void;
    function EnableWindow(hwnd: HWND, enable: boolean): void;
    function SetWindowPos(hwnd: HWND, insertAfter: SetWindowPosHwnd, x: number, y: number, width: number, height: number, flags: number): void;



    interface NotifyIconData {
        hwnd: HWND
        uID?: number
        flags?: number
        callbackMessage?: number
        hIcon?: HICON
        tip?: string
    }

    function ShellNotifyIcon(cmd: NotifyIconCmd, nid: NotifyIconData): boolean;
    /**
     * Thin wrapper around LoadImageW. Parameter order matches Win32 LoadImageW: (hinst, name, uType?, cx?, cy?, fuLoad?).
     * hinst: null for system resources/file path, number for module handle;
     * name: when hinst=null, a system icon IDI or .ico file path; when hinst=module handle, a resource ID (number) or resource name (string);
     * uType: gui.ImageType constant, default IMAGE_ICON (returns HICON), pass BITMAP/CURSOR for number return;
     * cx/cy: target size (0 for default, use gui.LoadImageFlag.DEFAULTSIZE for system default size);
     * fuLoad: gui.LoadImageFlag constants. Note: loading system icons (IDI_*, hinst=null) requires gui.LoadImageFlag.SHARED.
     * Example: gui.LoadImage(null, "app.ico", gui.ImageType.ICON, 32, 32, gui.LoadImageFlag.LOADFROMFILE)
     *          gui.LoadImage(null, gui.IDI.APPLICATION, gui.ImageType.ICON, 0, 0, gui.LoadImageFlag.SHARED)
     */
    function LoadImage<H extends (import("win").HMODULE) | null, T extends ImageType = ImageType.ICON>(
        hinst: H,
        name: H extends null ? string | IDI : string | number,
        uType?: T,
        cx?: number,
        cy?: number,
        fuLoad?: number
    ): T extends ImageType.ICON ? HICON | null : number | null;
    /** 从 BGRA 像素数据创建 32bpp top-down DIB，data 为 length >= width*height*4 的 ArrayBuffer，返回 HBITMAP */
    function CreateBitmapFromPixels(width: number, height: number, data: ArrayBuffer): number | null;
    function DeleteObject(hObject: number): boolean;
    function ImageListCreate(cx: number, cy: number, flags?: number, initial?: number, grow?: number): number | null;
    function ImageListAdd(himl: number, hBitmap: number): number;
    function ImageListDestroy(himl: number): boolean;


    function CreatePopupMenu(): HMENU | null;
    function AppendMenu(menu: HMENU, flags: number, id: number, text: string): boolean;
    function TrackPopupMenu(menu: HMENU, x: number, y: number, flags?: number, hwnd?: HWND): number;
    function DestroyMenu(menu: HMENU): boolean;
    function SetForegroundWindow(hwnd: HWND): boolean;
    /** Returns [x, y] or null */
    function GetCursorPos(): [number, number] | null;
    /** Returns [width, height] of the primary monitor */
    function GetScreenSize(): [number, number];
    /** Client-area/mouse rect: { left, top, right, bottom } */
    type RECT = { left: number; top: number; right: number; bottom: number };
    /** Returns { left, top, right, bottom } of client area, or null if invalid */
    function GetClientRect(hwnd: HWND): RECT | null;
    
    function GetWindowRect(hwnd: HWND): RECT | null;
    /** Invalidates client area (rect can be null/undefined for full window) */
    function InvalidateRect(hwnd: HWND, rect?: RECT | null, erase?: boolean): void;
    /** Forces immediate repaint of invalidated area */
    function UpdateWindow(hwnd: HWND): void;
    /** Checks if the window handle is valid */
    function IsWindow(hwnd: HWND): boolean;
    /** Sets scroll info; returns current scroll box position. Signature matches Win32 SetScrollInfo. */
    function SetScrollInfo(hwnd: HWND, bar: ScrollBar, info: { pos?: number; page?: number; min?: number; max?: number }, redraw?: boolean): number;

    /** Gets scroll info. Signature matches Win32 GetScrollInfo. */
    function GetScrollInfo(hwnd: HWND, bar: ScrollBar): { pos: number; page: number; min: number; max: number; trackPos: number };

    /** Shows or hides a scroll bar. Signature matches Win32 ShowScrollBar. */
    function ShowScrollBar(hwnd: HWND, bar: ScrollBar, show: boolean): boolean;


























}

declare module "ffi" {
    type TYPE_OF_FFI_TYPE_VOID = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_UINT8 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_SINT8 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_UINT16 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_SINT16 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_UINT32 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_SINT32 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_UINT64 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_SINT64 = number & { readonly __label: unique symbol }
    type TYPE_OF_FFI_TYPE_POINTER = number & { readonly __label: unique symbol }
    
    const FFI_TYPE_VOID: TYPE_OF_FFI_TYPE_VOID;
    const FFI_TYPE_UINT8: TYPE_OF_FFI_TYPE_UINT8;
    const FFI_TYPE_SINT8: TYPE_OF_FFI_TYPE_SINT8;
    const FFI_TYPE_UINT16: TYPE_OF_FFI_TYPE_UINT16;
    const FFI_TYPE_SINT16: TYPE_OF_FFI_TYPE_SINT16;
    const FFI_TYPE_UINT32: TYPE_OF_FFI_TYPE_UINT32;
    const FFI_TYPE_SINT32: TYPE_OF_FFI_TYPE_SINT32;
    const FFI_TYPE_UINT64: TYPE_OF_FFI_TYPE_UINT64;
    const FFI_TYPE_SINT64: TYPE_OF_FFI_TYPE_SINT64;
    const FFI_TYPE_POINTER: TYPE_OF_FFI_TYPE_POINTER;

    type FfiType = TYPE_OF_FFI_TYPE_VOID | TYPE_OF_FFI_TYPE_UINT8 | TYPE_OF_FFI_TYPE_SINT8 | TYPE_OF_FFI_TYPE_UINT16 | TYPE_OF_FFI_TYPE_SINT16 | TYPE_OF_FFI_TYPE_UINT32 | TYPE_OF_FFI_TYPE_SINT32 | TYPE_OF_FFI_TYPE_UINT64 | TYPE_OF_FFI_TYPE_SINT64 | TYPE_OF_FFI_TYPE_POINTER;
    type TypeArg<T extends FfiType> = T extends Exclude<FfiType, TYPE_OF_FFI_TYPE_VOID | TYPE_OF_FFI_TYPE_POINTER> ? number : T extends TYPE_OF_FFI_TYPE_POINTER ? (ArrayBuffer | null) : never;
    type TypeArgs<T extends FfiType[], Args extends(number | null | ArrayBuffer)[] = []> = T extends [infer T1 extends FfiType, ...infer RES extends FfiType[]] ? TypeArgs<RES, [...Args, TypeArg<T1>]> : Args;

    function ffiCall<const T extends Exclude<FfiType, TYPE_OF_FFI_TYPE_VOID>[], const R extends FfiType>(func: number, argTypes: T, args: TypeArgs<T>, retType: R): R extends TYPE_OF_FFI_TYPE_VOID ? undefined : R extends TYPE_OF_FFI_TYPE_POINTER ? number | null : TypeArg<R>;
    function bufferPtr(buf: ArrayBuffer): number;
    function readByte(ptr: number): number;
    function writeByte(ptr: number, value: number): void;
}



interface HttpCache {
    readMeta(url: string): string | null;
    readBody(url: string): ArrayBuffer | null;
    writeBodyOnly(url: string, body: string | ArrayBuffer): void;
    writeMeta(url: string, ini: string): void;
    cacheKey(url: string): string;
}

declare var __httpCache__: HttpCache;

declare module "brotli" {
    function decompress(data: ArrayBufferLike): ArrayBuffer;
}

