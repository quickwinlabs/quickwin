import '../lib/polyfill.js'
import * as sock from 'sock'
import * as wolfssl from 'wolfssl'
import * as os from 'os'

// ── Constants ──

const MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

enum State {
    CONNECTING = 0,
    OPEN = 1,
    CLOSING = 2,
    CLOSED = 3,
}

enum Opcode {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA,
}

// ── Random key generation ──

function generateKey(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return btoa(String.fromCharCode(...bytes))
}

async function computeAccept(key: string): Promise<string> {
    const data = new TextEncoder().encode(key + MAGIC_GUID)
    const hash = await crypto.subtle.digest('SHA-1', data)
    const hashBytes = new Uint8Array(hash)
    return btoa(String.fromCharCode(...hashBytes))
}

// ── Frame helpers ──

function createFrame(opcode: number, payload: Uint8Array): ArrayBuffer {
    const maskingKey = new Uint8Array(4)
    for (let i = 0; i < 4; i++) maskingKey[i] = (Math.random() * 256) | 0

    let headerSize: number
    if (payload.length < 126) {
        headerSize = 6
    } else if (payload.length < 65536) {
        headerSize = 8
    } else {
        headerSize = 14
    }

    const buf = new ArrayBuffer(headerSize + payload.length)
    const view = new Uint8Array(buf)
    let off = 0

    view[off++] = 0x80 | opcode
    view[off++] = 0x80 | (payload.length < 126 ? payload.length :
                          payload.length < 65536 ? 126 : 127)

    if (payload.length >= 126 && payload.length < 65536) {
        view[off++] = (payload.length >> 8) & 0xFF
        view[off++] = payload.length & 0xFF
    } else if (payload.length >= 65536) {
        const len = payload.length
        const hi = Math.floor(len / 0x100000000) >>> 0
        const lo = len >>> 0
        view[off++] = (hi >> 24) & 0xFF
        view[off++] = (hi >> 16) & 0xFF
        view[off++] = (hi >> 8) & 0xFF
        view[off++] = hi & 0xFF
        view[off++] = (lo >> 24) & 0xFF
        view[off++] = (lo >> 16) & 0xFF
        view[off++] = (lo >> 8) & 0xFF
        view[off++] = lo & 0xFF
    }

    view[off++] = maskingKey[0]
    view[off++] = maskingKey[1]
    view[off++] = maskingKey[2]
    view[off++] = maskingKey[3]

    for (let i = 0; i < payload.length; i++) {
        view[off++] = payload[i] ^ maskingKey[i % 4]
    }

    return buf
}

function createCloseFrame(code: number, reason: string): ArrayBuffer {
    const reasonBytes = new Uint8Array(reason.length + 2)
    reasonBytes[0] = (code >> 8) & 0xFF
    reasonBytes[1] = code & 0xFF
    for (let i = 0; i < reason.length; i++) {
        reasonBytes[i + 2] = reason.charCodeAt(i) & 0xFF
    }
    return createFrame(Opcode.CLOSE, reasonBytes)
}

// ── Frame parser (returns null if incomplete) ──

interface ParsedFrame {
    opcode: number
    payload: Uint8Array
    fin: boolean
    totalLen: number
}

function tryParseFrame(buffer: Uint8Array): ParsedFrame | null {
    if (buffer.length < 2) return null

    const b0 = buffer[0]
    const b1 = buffer[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0F
    const masked = (b1 & 0x80) !== 0
    let payloadLen = b1 & 0x7F
    let offset = 2

    if (payloadLen === 126) {
        if (buffer.length < 4) return null
        payloadLen = (buffer[2] << 8) | buffer[3]
        offset = 4
    } else if (payloadLen === 127) {
        if (buffer.length < 10) return null
        let hi = 0, lo = 0
        for (let i = 0; i < 4; i++) hi = (hi * 256 + buffer[offset + i]) >>> 0
        for (let i = 4; i < 8; i++) lo = (lo * 256 + buffer[offset + i]) >>> 0
        payloadLen = hi * 0x100000000 + lo
        offset = 10
    }

    if (masked) offset += 4

    const totalLen = offset + payloadLen
    if (buffer.length < totalLen) return null

    let payload: Uint8Array
    if (masked) {
        const maskKey = buffer.slice(offset - 4, offset)
        payload = new Uint8Array(payloadLen)
        for (let i = 0; i < payloadLen; i++) {
            payload[i] = buffer[offset + i] ^ maskKey[i % 4]
        }
    } else {
        payload = buffer.slice(offset, offset + payloadLen)
    }

    return { opcode, payload, fin, totalLen }
}

// ── WebSocket class ──

interface WSEventMap {
    open: Event
    message: MessageEvent
    close: CloseEvent
    error: Event
}

class WebSocket {
    readonly url: string
    readyState: number = State.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null

    private _sock: number | null = null
    private _ssl: number | null = null
    private _ctx: number | null = null
    private _readBuffer: Uint8Array = new Uint8Array(0)
    private _state: State = State.CONNECTING
    private _resolveOpen: (() => void) | null = null
    private _processingHandshake: boolean = false
    static readonly CONNECTING = State.CONNECTING
    static readonly OPEN = State.OPEN
    static readonly CLOSING = State.CLOSING
    static readonly CLOSED = State.CLOSED

    private _closeCode: number = 1005
    private _closeReason: string = ''
    private _requestKey: string = ''

    constructor(url: string) {
        this.url = url
        this._connect()
    }

    send(data: string | ArrayBuffer | Uint8Array): void {
        if (this._state !== State.OPEN) return

        let payload: Uint8Array
        if (typeof data === 'string') {
            const bytes: number[] = []
            for (let i = 0; i < data.length; i++) {
                const c = data.charCodeAt(i)
                if (c < 0x80) {
                    bytes.push(c)
                } else if (c < 0x800) {
                    bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F))
                } else {
                    bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F))
                }
            }
            payload = new Uint8Array(bytes)
            const frame = createFrame(Opcode.TEXT, payload)
            this._sendRaw(frame)
        } else if (data instanceof ArrayBuffer) {
            payload = new Uint8Array(data)
            const frame = createFrame(Opcode.BINARY, payload)
            this._sendRaw(frame)
        } else if (data instanceof Uint8Array) {
            const frame = createFrame(Opcode.BINARY, data)
            this._sendRaw(frame)
        }
    }

    close(code?: number, reason?: string): void {
        if (this._state === State.CLOSED || this._state === State.CLOSING) return
        this._state = State.CLOSING

        const closeCode = code || 1000
        const closeReason = reason || ''
        this._closeCode = closeCode
        this._closeReason = closeReason
        const frame = createCloseFrame(closeCode, closeReason)
        this._sendRaw(frame)

        this._cleanup()
        this._setState(State.CLOSED)
    }

    private _connect(): void {
        let url: URL
        try { url = new URL(this.url) } catch {
            const self = this
            os.setTimeout(() => {
                self._fireError(new Error('Invalid WebSocket URL: ' + self.url))
                self._setState(State.CLOSED)
            }, 0)
            return
        }
        const host = url.hostname
        const isWSS = url.protocol === 'wss:'
        const port = url.port ? parseInt(url.port, 10) : (isWSS ? 443 : 80)
        const path = url.pathname

        const requestKey = generateKey()
        this._requestKey = requestKey

        const request = (
            'GET ' + path + ' HTTP/1.1\r\n' +
            'Host: ' + host + ':' + port + '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + requestKey + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n'
        )

        let state: 'resolve' | 'connect' | 'handshake' | 'request' | 'open' = 'resolve'
        let headerBuffer = ''
        let resolved = false

        const cleanup = (): void => {
            if (this._ssl) { wolfssl.wolfSSL_free(this._ssl); this._ssl = null }
            if (this._ctx) { wolfssl.wolfSSL_CTX_free(this._ctx); this._ctx = null }
            if (this._sock) { sock.closesocket(this._sock); this._sock = null }
        }

        const doError = (err: Error): void => {
            if (resolved) return
            resolved = true
            cleanup()
            this._fireError(err)
            if (this._state !== State.CLOSED) this._setState(State.CLOSED)
        }

        this._sock = sock.socket()
        if (!this._sock) {
            const self = this
            os.setTimeout(() => {
                self._fireError(new Error('Failed to create socket'))
                if (self._state !== State.CLOSED) self._setState(State.CLOSED)
            }, 0)
            return
        }
        const fd = this._sock

        sock.set_on_event(fd, async (event: { lNetworkEvents: number; iErrorCode: number[] }) => {
            if (this._processingHandshake) return
            if (resolved && state === 'open') {
                if (event.lNetworkEvents & sock.FdEvent.FD_READ) {
                    this._onData()
                }
                if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                    this._cleanup()
                    this._setState(State.CLOSED)
                }
                return
            }

            if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                const errCode = event.iErrorCode[0]
                if (errCode !== 0) {
                    doError(new Error('Connection failed: ' + errCode))
                    return
                }
                if (isWSS) {
                    const method = wolfssl.wolfTLSv1_2_client_method()
                    this._ctx = wolfssl.wolfSSL_CTX_new(method)
                    wolfssl.wolfSSL_CTX_set_verify(this._ctx, wolfssl.VerifyMode.SSL_VERIFY_NONE)
                    this._ssl = wolfssl.wolfSSL_new(this._ctx)
                    if (!this._ssl) {
                        doError(new Error('SSL_new failed'))
                        return
                    }
                    wolfssl.wolfSSL_set_fd(this._ssl, sock.get_fd(fd))
                    const sniHost = host
                    if (sniHost) wolfssl.wolfSSL_UseSNI(this._ssl, wolfssl.SniType.WOLFSSL_SNI_HOST_NAME, sniHost)
                    state = 'handshake'
                } else {
                    this._sendRawStr(request)
                    state = 'request'
                }
            }

            if ((event.lNetworkEvents & sock.FdEvent.FD_READ) || (event.lNetworkEvents & sock.FdEvent.FD_WRITE)) {
                if (state === 'handshake') {
                    if (!this._ssl) { doError(new Error('TLS not initialized')); return }
                    const ret = wolfssl.wolfSSL_connect(this._ssl)
                    if (ret === wolfssl.ReturnCode.SSL_SUCCESS) {
                        this._sendRawStr(request)
                        state = 'request'
                    } else {
                        const err = wolfssl.wolfSSL_get_error(this._ssl, ret)
                        if (err !== wolfssl.ErrorCode.WOLFSSL_ERROR_WANT_READ &&
                            err !== wolfssl.ErrorCode.WOLFSSL_ERROR_WANT_WRITE) {
                            doError(new Error('TLS handshake failed: ' + err))
                        }
                    }
                }
                else if (state === 'request') {
                    while (true) {
                        let data: ArrayBuffer | null
                        if (isWSS && this._ssl) {
                            data = wolfssl.wolfSSL_read(this._ssl, 8192)
                        } else if (this._sock) {
                            data = sock.recv(this._sock, 8192)
                        } else { break }
                        if (!data || data.byteLength === 0) break
                        headerBuffer += _ab2str(data)
                        const headerEnd = headerBuffer.indexOf('\r\n\r\n')
                        if (headerEnd >= 0) {
                            const headerPart = headerBuffer.slice(0, headerEnd)
                            const lines = headerPart.split('\r\n')
                            const statusLine = lines[0]
                            const statusParts = statusLine.split(' ')
                            const statusCode = parseInt(statusParts[1], 10)
                            if (statusCode !== 101) {
                                doError(new Error('WebSocket handshake failed: HTTP ' + statusCode))
                                return
                            }

                            let acceptHeader = ''
                            for (let i = 1; i < lines.length; i++) {
                                const line = lines[i]
                                const colonIdx2 = line.indexOf(':')
                                if (colonIdx2 >= 0) {
                                    const name = line.slice(0, colonIdx2).toLowerCase().trim()
                                    if (name === 'sec-websocket-accept') {
                                        acceptHeader = line.slice(colonIdx2 + 1).trim()
                                        break
                                    }
                                }
                            }
                            if (!acceptHeader) {
                                doError(new Error('WebSocket handshake missing Sec-WebSocket-Accept'))
                                return
                            }

                            this._processingHandshake = true
                            const expectedAccept = await computeAccept(requestKey)
                            if (acceptHeader !== expectedAccept) {
                                doError(new Error('WebSocket handshake invalid Sec-WebSocket-Accept'))
                                this._processingHandshake = false
                                return
                            }

                            state = 'open'
                            resolved = true
                            this._processingHandshake = false
                            this._setState(State.OPEN)
                            break
                        }
                    }
                }
            }

            if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                if (state !== 'open') {
                    doError(new Error('Connection closed'))
                }
            }
        })

        const ip = sock.resolve(host)
        if (!ip) {
            const self = this
            os.setTimeout(() => {
                self._fireError(new Error('DNS resolution failed for: ' + host))
                if (self._state !== State.CLOSED) self._setState(State.CLOSED)
            }, 0)
            return
        }
        sock.connect(fd, ip, port)
    }

    private _sendRaw(buf: ArrayBuffer): void {
        if (!this._sock) return
        if (this._ssl) {
            wolfssl.wolfSSL_write(this._ssl, buf)
        } else {
            sock.send(this._sock, buf)
        }
    }

    private _sendRawStr(str: string): void {
        const buf = new ArrayBuffer(str.length)
        const view = new Uint8Array(buf)
        for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i) & 0xFF
        this._sendRaw(buf)
    }

    private _onData(): void {
        while (true) {
            let data: ArrayBuffer | null
            if (this._ssl) {
                data = wolfssl.wolfSSL_read(this._ssl, 8192)
            } else if (this._sock) {
                data = sock.recv(this._sock, 8192)
            } else { break }
            if (!data || data.byteLength === 0) break

            const newBuf = new Uint8Array(this._readBuffer.length + data.byteLength)
            newBuf.set(this._readBuffer)
            newBuf.set(new Uint8Array(data), this._readBuffer.length)
            this._readBuffer = newBuf

            while (true) {
                const frame = tryParseFrame(this._readBuffer)
                if (!frame) break

                this._readBuffer = this._readBuffer.slice(frame.totalLen)

                if (frame.opcode === Opcode.TEXT || frame.opcode === Opcode.BINARY) {
                    const event = new MessageEvent('message', { data: frame.opcode === Opcode.TEXT ? _ab2str(frame.payload.slice(0).buffer) : frame.payload.slice(0).buffer })
                    this._dispatchEvent('message', event)
                } else if (frame.opcode === Opcode.PING) {
                    const pong = createFrame(Opcode.PONG, frame.payload)
                    this._sendRaw(pong)
                } else if (frame.opcode === Opcode.PONG) {
                } else if (frame.opcode === Opcode.CLOSE) {
                    if (frame.payload.length >= 2) {
                        this._closeCode = (frame.payload[0] << 8) | frame.payload[1]
                        this._closeReason = _ab2str(frame.payload.slice(2).buffer)
                    }
                    this._cleanup()
                    this._setState(State.CLOSED)
                    return
                }
            }
        }
    }

    private _setState(state: State): void {
        if (this._state === state) return
        this.readyState = state
        this._state = state

        if (state === State.OPEN) {
            this._dispatchEvent('open', new Event('open'))
        } else if (state === State.CLOSED) {
            const event = new CloseEvent('close', { code: this._closeCode, reason: this._closeReason, wasClean: true })
            this._dispatchEvent('close', event)
        }
    }

    private _dispatchEvent(type: string, event: Event | MessageEvent | CloseEvent): void {
        if (type === 'open' && this.onopen) this.onopen(event as Event)
        else if (type === 'close' && this.onclose) this.onclose(event as CloseEvent)
        else if (type === 'error' && this.onerror) this.onerror(event as Event)
        else if (type === 'message' && this.onmessage) this.onmessage(event as MessageEvent)
    }

    private _fireError(err: Error): void {
        this._dispatchEvent('error', new Event('error'))
    }

    private _cleanup(): void {
        if (this._ssl) { wolfssl.wolfSSL_free(this._ssl); this._ssl = null }
        if (this._ctx) { wolfssl.wolfSSL_CTX_free(this._ctx); this._ctx = null }
        if (this._sock) { sock.closesocket(this._sock); this._sock = null }
    }
}

// ── Event/MessageEvent/CloseEvent polyfills ──

class Event {
    readonly type: string
    constructor(type: string, _init?: any) { this.type = type }
}

class MessageEvent {
    readonly type: string
    readonly data: any
    constructor(type: string, init: { data: any }) {
        this.type = type
        this.data = init.data
    }
}

class CloseEvent {
    readonly type: string
    readonly code: number
    readonly reason: string
    readonly wasClean: boolean
    constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean }) {
        this.type = type
        this.code = init.code || 0
        this.reason = init.reason || ''
        this.wasClean = init.wasClean || false
    }
}

// ── Utility ──

function _ab2str(buf: ArrayBuffer): string {
    const view = new Uint8Array(buf)
    let str = ''
    for (let i = 0; i < view.length; i++) str += String.fromCharCode(view[i])
    return str
}

// ── Global declarations ──

declare global {
    interface WebSocket {
        url: string
        readyState: number
        onopen: ((event: Event) => void) | null
        onclose: ((event: CloseEvent) => void) | null
        onerror: ((event: Event) => void) | null
        onmessage: ((event: MessageEvent) => void) | null
        send(data: string | ArrayBuffer | Uint8Array): void
        close(code?: number, reason?: string): void
    }

    var WebSocket: {
        new(url: string): WebSocket
        readonly CONNECTING: number
        readonly OPEN: number
        readonly CLOSING: number
        readonly CLOSED: number
    }
}

// ── Register globals ──

globalThis.WebSocket = WebSocket
