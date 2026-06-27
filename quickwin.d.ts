/// <reference path="quickwin_const.d.ts" />
interface ImportMeta {
    url: string
}

declare const console: Console

interface Console {
    log: (...args: any) => void
}

interface HeadersInit {
    [name: string]: string;
}

interface RequestInit {
    method?: string;
    headers?: HeadersInit;
    body?: string;
    timeout?: number;
    redirect?: 'follow' | 'manual' | 'error';
    maxRedirects?: number;
}

declare namespace WebAssembly {
    interface Module { }
    interface Instance {
        exports: { [key: string]: any }
    }
    interface Global {
        value: any
        valueOf(): any
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
    instantiate(buffer: ArrayBuffer, importObject?: any): Promise<{ module: WebAssembly.Module; instance: WebAssembly.Instance }>
    instantiate(module: WebAssembly.Module, importObject?: any): Promise<WebAssembly.Instance>
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
        new(module: WebAssembly.Module, importObject?: any): WebAssembly.Instance
    }
    Global: {
        new(descriptor: WebAssembly.GlobalDescriptor, value?: any): WebAssembly.Global
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
    readonly data: any;
}

interface CloseEvent {
    readonly type: string;
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
}

interface ReadableStreamReader {
    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: undefined }>;
    cancel(reason?: any): void;
    releaseLock(): void;
}

interface ReadableStream {
    readonly locked: boolean;
    getReader(): ReadableStreamReader;
    cancel(reason?: any): void;
}

declare module "std" {
    interface FILE {
        close(): number;
        puts(str: string): void;
        printf(fmt: string, ...args: any[]): void;
        flush(): void;
        seek(offset: number | bigint, whence: number): number;
        tell(): number;
        tello(): bigint;
        eof(): boolean;
        fileno(): number;
        error(): boolean;
        clearerr(): void;
        read(buffer: ArrayBuffer, position?: number, length?: number): number;
        write(buffer: ArrayBuffer, position?: number, length?: number): number;
        getline(): string | null;
        readAsString(max_size?: number): string | null;
        getByte(): number;
        putByte(c: number): void;
    }

    interface UrlGetOptions {
        binary?: boolean;
        full?: boolean;
    }

    interface UrlGetFullResult {
        response: string | ArrayBuffer | null;
        responseHeaders: string;
        status: number;
    }

    interface EvalScriptOptions {
        backtrace_barrier?: boolean;
        async?: boolean;
    }

    interface OpenOptions {
        binary?: boolean;
    }

    function exit(n: number): never;
    function evalScript(str: string, options?: EvalScriptOptions): any;
    function loadScript(filename: string): any;
    /** 只适合读取 UTF-8 文本文件，读取二进制文件用 std.open + FILE.read */
    function loadFile(filename: string, options?: OpenOptions): string | Uint8Array | null;
    function open(filename: string, flags: string, errorObj?: { errno: number }): FILE | null;
    function popen(command: string, flags: string, errorObj?: { errno: number }): FILE | null;
    function fdopen(fd: number, flags: string, errorObj?: { errno: number }): FILE | null;
    function tmpfile(errorObj?: { errno: number }): FILE | null;
    function puts(str: string): void;
    function printf(fmt: string, ...args: any[]): void;
    function sprintf(fmt: string, ...args: any[]): string;

    const out: FILE;
    const err: FILE;

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

    function parseExtJSON(str: string): any;
    function __printObject(val: any): void;
    function strerror(errno: number): string;
    function gc(): void;
    function getenv(name: string): string | undefined;
    function setenv(name: string, value: string): void;
    function unsetenv(name: string): void;
    function getenviron(): Record<string, string>;
    function urlGet(url: string, options?: UrlGetOptions): string | ArrayBuffer | UrlGetFullResult | null;

    const SEEK_SET: number;
    const SEEK_CUR: number;
    const SEEK_END: number;
}

declare module "os" {
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

    interface ExecOptions {
        block?: boolean;
        usePath?: boolean;
        file?: string;
        cwd?: string;
        stdin?: number;
        stdout?: number;
        stderr?: number;
        env?: Record<string, string>;
        uid?: number;
        gid?: number;
    }

    function open(filename: string, flags: number, mode?: number): number;
    function close(fd: number): number;
    function seek(fd: number, offset: number | bigint, whence: number): number | bigint;
    function read(fd: number, buffer: ArrayBuffer, offset: number, length: number): number;
    function write(fd: number, buffer: ArrayBuffer, offset: number, length: number): number;
    function isatty(fd: number): boolean;
    function ttyGetWinSize(fd: number): [number, number] | null;
    function ttySetRaw(fd: number): void;
    function remove(filename: string): number;
    function rename(oldname: string, newname: string): number;
    function realpath(path: string): [string, number];
    function getcwd(): [string, number];
    function chdir(path: string): number;
    function mkdir(path: string, mode?: number): number;
    function stat(path: string): [StatResult, number];
    function lstat(path: string): [StatResult, number];
    function utimes(path: string, atime: number, mtime: number): number;
    function symlink(target: string, linkpath: string): number;
    function readlink(path: string): [string, number];
    function readdir(path: string): [string[], number];
    function setReadHandler(fd: number, func: (() => void) | null): void;
    function setWriteHandler(fd: number, func: (() => void) | null): void;
    function signal(signal: number, func: (() => void) | null | undefined): void;
    function kill(pid: number, sig: number): void;
    function exec(args: string[], options?: ExecOptions): number;
    function waitpid(pid: number, options: number): [number, number];
    function dup(fd: number): number;
    function dup2(oldfd: number, newfd: number): number;
    function pipe(): [number, number] | null;
    function sleep(delay_ms: number): void;
    function sleepAsync(delay_ms: number): Promise<void>;
    function setTimeout(func: () => void, delay: number): number;
    function clearTimeout(id: number): void;

    const platform: string;

    const O_RDONLY: number;
    const O_WRONLY: number;
    const O_RDWR: number;
    const O_APPEND: number;
    const O_CREAT: number;
    const O_EXCL: number;
    const O_TRUNC: number;
    const O_BINARY: number;
    const O_TEXT: number;

    const SIGINT: number;
    const SIGABRT: number;
    const SIGFPE: number;
    const SIGILL: number;
    const SIGSEGV: number;
    const SIGTERM: number;

    const WNOHANG: number;

    const S_IFMT: number;
    const S_IFIFO: number;
    const S_IFCHR: number;
    const S_IFDIR: number;
    const S_IFBLK: number;
    const S_IFREG: number;
    const S_IFSOCK: number;
    const S_IFLNK: number;
    const S_ISGID: number;
    const S_ISUID: number;

    class Worker {
        constructor(module_filename: string);
        postMessage(msg: any): void;
        onmessage: ((event: { data: any }) => void) | null;
        static parent: Worker;
    }
}

declare module "sock" {
    type SockHandle = number;

    function socket(domain?: number, type?: number, protocol?: number): SockHandle;
    function connect(sock: SockHandle, addr: string, port: number): number;
    function send(sock: SockHandle, buf: ArrayBuffer, flags?: number): number;
    function recv(sock: SockHandle, size?: number, flags?: number): ArrayBuffer | null;
    function closesocket(sock: SockHandle): void;
    function shutdown(sock: SockHandle, how: number): number;
    function set_on_event(sock: SockHandle, callback: (events: { lNetworkEvents: number; iErrorCode: number[] }) => void): void;
    function get_fd(sock: SockHandle): number;
    function resolve(hostname: string): string | null;

}

declare module "wolfssl" {
    type WOLFSSL = number;
    type WOLFSSL_CTX = number;
    type WOLFSSL_METHOD = number;

    function wolfSSL_library_init(): number;
    function wolfSSL_CTX_new(method: WOLFSSL_METHOD): WOLFSSL_CTX | null;
    function wolfSSL_CTX_free(ctx: WOLFSSL_CTX): void;
    function wolfSSL_CTX_set_verify(ctx: WOLFSSL_CTX, mode: number): number;
    function wolfSSL_CTX_use_certificate_file(ctx: WOLFSSL_CTX, file: string, format?: number): number;
    function wolfSSL_CTX_use_PrivateKey_file(ctx: WOLFSSL_CTX, file: string, format?: number): number;

    function wolfSSL_new(ctx: WOLFSSL_CTX): WOLFSSL | null;
    function wolfSSL_free(ssl: WOLFSSL): void;
    function wolfSSL_set_fd(ssl: WOLFSSL, fd: number): number;
    function wolfSSL_connect(ssl: WOLFSSL): number;
    function wolfSSL_shutdown(ssl: WOLFSSL): number;
    function wolfSSL_write(ssl: WOLFSSL, buf: ArrayBuffer): number;
    function wolfSSL_read(ssl: WOLFSSL, sz: number): ArrayBuffer | null;
    function wolfSSL_get_error(ssl: WOLFSSL, ret: number): number;
    function wolfSSL_UseSNI(ssl: WOLFSSL, type: number, name: string, len?: number): number;

    function wolfSSLv23_client_method(): WOLFSSL_METHOD;
    function wolfTLSv1_2_client_method(): WOLFSSL_METHOD;
    function wolfTLSv1_3_client_method(): WOLFSSL_METHOD;

}

declare module "win" {
    type HMODULE = number & { readonly __label: unique symbol };

    function LoadLibrary(libName: string): HMODULE | null;
    function GetProcAddress(hModule: HMODULE, procName: string): number | null;
    function FreeLibrary(hModule: HMODULE): boolean;
}

declare module "gui" {
    type HWND = number & { readonly __label: unique symbol };
    type HMENU = number & { readonly __label: unique symbol };
    type HFONT = number & { readonly __label: unique symbol };
    type WNDPROC = number & { readonly __label: unique symbol };

    function RegisterClass(className: string, wndProc?: (hwnd: HWND, msg: number, wParam: number, lParam: number) => number): number;
    function CreateWindow(className: string, title: string, style: number, x: number, y: number, width: number, height: number, parent: HWND | null, menu: HMENU | null): HWND | null;
    // 销毁窗口及其所有子窗口，自动清理 WNDPROC 和 JS 引用
    function DestroyWindow(hwnd: HWND): boolean;
    function GetWindow(hwnd: HWND, cmd: number): HWND;

    function ShowWindow(hwnd: HWND, nCmdShow?: number): void;
    function SetWindowProc(hwnd: HWND, wndProc: (hwnd: HWND, msg: number, wParam: number, lParam: number) => number): void;
    function DefWindowProc(hwnd: HWND, msg: number, wParam: number, lParam: number): number;
    function PostQuitMessage(exitCode: number): void;
    function SendMessage(hwnd: HWND, msg: number, wParam: number, lParam: number | string): number;
    function MessageBox(message: string): void;
    function SetWindowText(hwnd: HWND, text: string): void;
    function GetWindowText(hwnd: HWND): string;
    function GetScaleFactor(): number;
    function CreateSystemDpiFont(): HFONT | null;
    function GetWindowLongPtr(hwnd: HWND, nIndex: number): number;
    function SetWindowLongPtr(hwnd: HWND, nIndex: number, newLong: number): number;
    function UnsetWindowProc(hwnd: HWND): boolean;
    function CallWindowProc(wndProc: WNDPROC, hwnd: HWND, msg: number, wParam: number, lParam: number): number;
    function SetParent(hwnd: HWND, parent: HWND | null): void;
    function EnableWindow(hwnd: HWND, enable: boolean): void;
    function SetWindowPos(hwnd: HWND, insertAfter: number, x: number, y: number, width: number, height: number, flags: number): void;



    interface NotifyIconData {
        hwnd: number
        uID?: number
        flags?: number
        callbackMessage?: number
        hIcon?: number
        tip?: string
    }

    function ShellNotifyIcon(cmd: number, nid: NotifyIconData): boolean;
    function LoadIcon(name: string): number | null;


    function CreatePopupMenu(): number | null;
    function AppendMenu(menu: number, flags: number, id: number, text: string): boolean;
    function TrackPopupMenu(menu: number, x: number, y: number, flags?: number, hwnd?: number): number;
    function DestroyMenu(menu: number): boolean;
    function SetForegroundWindow(hwnd: number): boolean;
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
    function SetScrollInfo(hwnd: HWND, bar: number, info: { pos?: number; page?: number; min?: number; max?: number }, redraw?: boolean): number;

    /** Gets scroll info. Signature matches Win32 GetScrollInfo. */
    function GetScrollInfo(hwnd: HWND, bar: number): { pos: number; page: number; min: number; max: number; trackPos: number };

    /** Shows or hides a scroll bar. Signature matches Win32 ShowScrollBar. */
    function ShowScrollBar(hwnd: HWND, bar: number, show: boolean): boolean;


























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
}

declare module "wamr" {
    interface WAMRExport {
        name: string;
        kind: 'function' | 'table' | 'memory' | 'global';
    }

    interface WAMRImport {
        module: string;
        name: string;
        kind: 'function' | 'table' | 'memory' | 'global';
    }

    interface WAMRModule {
        delete(): void;
        exports(): WAMRExport[];
        imports(): WAMRImport[];
        instantiate(imports?: { [moduleName: string]: { [funcName: string]: Function } }): WAMRInstance;
    }

    interface WAMRInstance {
        delete(): void;
        exports(): { [funcName: string]: (...args: number[]) => number };
    }

    function validate(buffer: ArrayBuffer): boolean;
    function compile(buffer: ArrayBuffer): WAMRModule;
}

interface HttpCache {
    readMeta(url: string): string | null;
    readBody(url: string): ArrayBuffer | null;
    writeCache(url: string, maxAge: number, body: string | ArrayBuffer): void;
    writeMeta(url: string, json: string): void;
    cacheKey(url: string): string;
}

declare var __httpCache__: HttpCache;

declare module "brotli" {
    function decompress(data: ArrayBufferLike): ArrayBuffer;
}

