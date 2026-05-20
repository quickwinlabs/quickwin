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
        write(buffer: ArrayBuffer | string, position?: number, length?: number): number;
        getline(): string | null;
        readAsArrayBuffer(max_size?: number): ArrayBuffer | null;
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
    function writeFile(filename: string, data: string | ArrayBuffer | Uint8Array): void;
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
    }

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
        groups?: number[];
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
    function exePath(): string | undefined;
    function chdir(path: string): number;
    function mkdir(path: string, mode?: number): number;
    function mkdtemp(pattern?: string): [string, number];
    function mkstemp(pattern?: string): [string, number];
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
    function bind(sock: SockHandle, addr: string, port: number): number;
    function listen(sock: SockHandle, backlog: number): number;
    function accept(sock: SockHandle): SockHandle;
    function connect(sock: SockHandle, addr: string, port: number): number;
    function send(sock: SockHandle, buf: ArrayBuffer, flags?: number): number;
    function recv(sock: SockHandle, buf: ArrayBuffer, flags?: number): number;
    function recv(sock: SockHandle, size: number, flags?: number): ArrayBuffer | null;
    function closesocket(sock: SockHandle): void;
    function shutdown(sock: SockHandle, how: number): number;
    function setsockopt(sock: SockHandle, level: number, optname: number, optval: number): number;
    function ioctlsocket(sock: SockHandle, cmd: number, argp: number): number;
    function set_on_event(sock: SockHandle, callback: (events: { lNetworkEvents: number; iErrorCode: number[] }) => void): void;
    function get_fd(sock: SockHandle): number;
    function resolve(hostname: string): string | null;

    const AF_INET: number;
    const AF_INET6: number;
    const SOCK_STREAM: number;
    const SOCK_DGRAM: number;
    const IPPROTO_TCP: number;
    const IPPROTO_UDP: number;
    const SD_RECEIVE: number;
    const SD_SEND: number;
    const SD_BOTH: number;
    const FD_READ: number;
    const FD_WRITE: number;
    const FD_ACCEPT: number;
    const FD_CONNECT: number;
    const FD_CLOSE: number;
}

declare module "wolfssl" {
    type WOLFSSL = number;
    type WOLFSSL_CTX = number;
    type WOLFSSL_METHOD = number;

    function wolfSSL_library_init(): number;
    function wolfSSL_CTX_new(method: WOLFSSL_METHOD): WOLFSSL_CTX;
    function wolfSSL_CTX_free(ctx: WOLFSSL_CTX): void;
    function wolfSSL_CTX_set_verify(ctx: WOLFSSL_CTX, mode: number): number;
    function wolfSSL_CTX_load_system_CA_certs(ctx: WOLFSSL_CTX): number;
    function wolfSSL_CTX_set_default_passwd_cb(ctx: WOLFSSL_CTX, cb: number): void;

    function wolfSSL_new(ctx: WOLFSSL_CTX): WOLFSSL;
    function wolfSSL_free(ssl: WOLFSSL): void;
    function wolfSSL_set_fd(ssl: WOLFSSL, fd: number): number;
    function wolfSSL_connect(ssl: WOLFSSL): number;
    function wolfSSL_accept(ssl: WOLFSSL): number;
    function wolfSSL_shutdown(ssl: WOLFSSL): number;
    function wolfSSL_write(ssl: WOLFSSL, buf: ArrayBuffer): number;
    function wolfSSL_read(ssl: WOLFSSL, sz: number): ArrayBuffer | null;
    function wolfSSL_get_error(ssl: WOLFSSL, ret: number): number;
    function wolfSSL_use_certificate_file(ssl: WOLFSSL, file: string, format: number): number;
    function wolfSSL_use_PrivateKey_file(ssl: WOLFSSL, file: string, format: number): number;
    function wolfSSL_UseSNI(ssl: WOLFSSL, type: number, name: string, len?: number): number;

    function wolfTLS_client_method(): WOLFSSL_METHOD;
    function wolfTLS_server_method(): WOLFSSL_METHOD;
    function wolfTLSv1_2_client_method(): WOLFSSL_METHOD;
    function wolfTLSv1_3_client_method(): WOLFSSL_METHOD;
    function wolfSSLv23_client_method(): WOLFSSL_METHOD;

    const SSL_VERIFY_NONE: number;
    const SSL_VERIFY_PEER: number;
    const WOLFSSL_SNI_HOST_NAME: number;
    const SSL_FILETYPE_PEM: number;
    const SSL_SUCCESS: number;
    const WOLFSSL_ERROR_WANT_READ: number;
    const WOLFSSL_ERROR_WANT_WRITE: number;
}

declare module "tls" {
    function https_get_sync(url: string): string;
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
    function CreateWindow(className: string, title: string, style: number, x: number, y: number, width: number, height: number, parent: HWND | null, menu: HMENU | null): HWND;
    function ShowWindow(hwnd: HWND): void;
    function SetWindowProc(hwnd: HWND, wndProc: (hwnd: HWND, msg: number, wParam: number, lParam: number) => number): void;
    function DefWindowProc(hwnd: HWND, msg: number, wParam: number, lParam: number): number;
    function PostQuitMessage(exitCode: number): void;
    function SendMessage(hwnd: HWND, msg: number, wParam: number, lParam: number | string): void;
    function MessageBox(message: string): void;
    function SetWindowText(hwnd: HWND, text: string): void;
    function GetWindowText(hwnd: HWND): string;
    function GetScaleFactor(): number;
    function CreateSystemDpiFont(): HFONT | null;
    function GetWindowLongPtr(hwnd: HWND, nIndex: number): number;
    function SetWindowLongPtr(hwnd: HWND, nIndex: number, newLong: number): number;
    function RemoveWindow(hwnd: HWND): boolean;
    function CallWindowProc(wndProc: WNDPROC, hwnd: HWND, msg: number, wParam: number, lParam: number): number;

    // 窗口样式 (Window Styles)
    export const enum WindowStyle {
        OVERLAPPEDWINDOW = 0x00CF0000,
        CHILD = 0x40000000,
        VISIBLE = 0x10000000,
        BORDER = 0x00800000,
        HSCROLL = 0x00100000,
        VSCROLL = 0x00200000,
        CLIPCHILDREN = 0x02000000,
    }

    // 窗口消息 (Window Messages)
    export const enum WmMsg {
        CREATE = 0x0001,
        DESTROY = 0x0002,
        CLOSE = 0x0010,
        QUIT = 0x0012,
        PAINT = 0x000F,
        COMMAND = 0x0111,
        SIZE = 0x0003,
        CHAR = 0x0102,
        KEYDOWN = 0x0100,
        KEYUP = 0x0101,
        MOUSEMOVE = 0x0200,
        LBUTTONDOWN = 0x0201,
        LBUTTONUP = 0x0202,
        RBUTTONDOWN = 0x0204,
        RBUTTONUP = 0x0205,
        SETFONT = 0x0030,
        HSCROLL = 0x0114,
        VSCROLL = 0x0115,
        MOUSEWHEEL = 0x020A,
    }

    // 滚动条常量 (Scroll Bar)
    export const enum ScrollBar {
        HORZ = 0,
        VERT = 1,
    }

    // 滚动命令 (Scroll Commands)
    export const enum ScrollCmd {
        LINEUP = 0,
        LINEDOWN = 1,
        PAGEUP = 2,
        PAGEDOWN = 3,
        THUMBTRACK = 5,
    }

    // 滚动信息标志 (Scroll Info Flags)
    export const enum ScrollInfoFlag {
        RANGE = 0x0001,
        PAGE = 0x0002,
        POS = 0x0004,
        ALL = 0x0017,
    }

    // 系统度量 (System Metrics)
    export const enum SysMetrics {
        CXSCREEN = 0,
        CYSCREEN = 1,
    }

    // 按钮样式 (Button Styles)
    export const enum ButtonStyle {
        PUSHBUTTON = 0x00000000,
        GROUPBOX = 0x00000007,
        CHECKBOX = 0x00000002,
        AUTOCHECKBOX = 0x00000003,
    }

    // ListBox 消息
    export const enum LbMsg {
        ADDSTRING = 0x0180,
    }

    // 静态控件样式 (Static Control Styles)
    export const enum StaticStyle {
        LEFT = 0x00000000,
    }

    // 编辑框样式 (Edit Control Styles)
    export const enum EditStyle {
        LEFT = 0x0000,
        AUTOHSCROLL = 0x0080,
    }

    // 组合框样式 (Combo Box Styles)
    export const enum ComboBoxStyle {
        DROPDOWNLIST = 0x0003,
    }

    // 列表框样式 (List Box Styles)
    export const enum ListBoxStyle {
        NOTIFY = 0x0001,
    }

    // ShowWindow 命令 (ShowWindow nCmdShow)
    export const enum ShowWindowCmd {
        HIDE = 0,
        SHOW = 5,
    }

    // 按钮消息 (Button Control Messages)
    export const enum ButtonMsg {
        GETCHECK = 0x00F0,
        SETCHECK = 0x00F1,
    }

    // 按钮选中状态 (Button Check State)
    export const enum ButtonCheckState {
        UNCHECKED = 0,
        CHECKED = 1,
    }

    // 编辑框消息 (Edit Control Messages)
    export const enum EditMsg {
        SETCUEBANNER = 0x1501,
        SETPASSWORDCHAR = 0x00CC,
    }

    // 组合框消息 (Combo Box Messages)
    export const enum ComboBoxMsg {
        ADDSTRING = 0x0143,
    }

    // 进度条消息 (Progress Bar Messages)
    export const enum ProgressMsg {
        SETRANGE32 = 0x0406,
        SETPOS = 0x0402,
    }

    // 窗口额外数据偏移 (GetWindowLongPtr 索引)
    export const enum Gwlp {
        WNDPROC = -4,
        HINSTANCE = -6,
        HWNDPARENT = -8,
        USERDATA = -21,
        ID = -12,
    }
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
    type TypeArgs<T extends FfiType[], Args = []> = T extends [infer T1, ...infer RES] ? TypeArgs<RES, [...Args, TypeArg<T1>]> : Args;

    function ffiCall<const T extends Exclude<FfiType, TYPE_OF_FFI_TYPE_VOID>[], const R extends FfiType>(func: number, argTypes: T, args: TypeArgs<T>, retType: R): R extends TYPE_OF_FFI_TYPE_VOID ? undefined : R extends TYPE_OF_FFI_TYPE_POINTER ? number | null : TypeArg<R>;
    function bufferPtr(buf: ArrayBuffer): number;
    function readByte(ptr: number): number;
}

declare module "../lib/fetch.js" {
    export { fetch, Request, Response, Headers, RequestInit, HeadersInit };
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

