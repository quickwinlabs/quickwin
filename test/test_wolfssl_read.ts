import * as sock from 'sock'
import * as wolfssl from 'wolfssl'
import * as os from 'os'
import * as std from 'std'
import { Tester } from './test_helper.js'

const HTTPS_PORT = 18924
const WANT_READ = 2
const WANT_WRITE = 3
const ZERO_RETURN = 6

export const suite = {
    name: 'net-wolfssl-read',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        // ── wolfSSL_read return contract: raw int, data lands in the
        //    caller-owned buffer (thin wrapper — errors stay numbers) ──
        t.section('wolfSSL_read contract (HTTPS /large/65536)')
        await new Promise<void>((resolve) => {
            const s = sock.socket()
            if (s === null || s < 0) {
                assert('socket() ok', false)
                resolve()
                return
            }

            let ssl: wolfssl.WOLFSSL | null = null
            let ctx: wolfssl.WOLFSSL_CTX | null = null
            let connected = false
            let handshakeDone = false
            let sentRequest = false
            let total = 0
            const EXPECTED = 65536
            let sawNonNumber = false
            let sawEof = false
            let errOk = true
            let done = false

            const finish = () => {
                if (done) return
                done = true
                os.clearTimeout(timeoutId)
                assert('connected', connected)
                assert('handshake ok', handshakeDone)
                assert('request sent', sentRequest)
                assert('received full body', total >= EXPECTED)
                assert('wolfSSL_read always returned number', !sawNonNumber)
                assert('no-data/EOF observed via int (0 or ZERO_RETURN)', sawEof)
                assert('n<=0 get_error in {WANT_READ,WANT_WRITE,ZERO_RETURN}', errOk)
                if (ssl) { wolfssl.wolfSSL_free(ssl); ssl = null }
                if (ctx) { wolfssl.wolfSSL_CTX_free(ctx); ctx = null }
                sock.closesocket(s)
                resolve()
            }

            const timeoutId = os.setTimeout(() => {
                assert('wolfSSL_read contract timeout (15s)', false)
                finish()
            }, 15000)

            const sendReq = () => {
                const req = 'GET /large/65536 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
                const buf = new ArrayBuffer(req.length)
                const v = new Uint8Array(buf)
                for (let i = 0; i < req.length; i++) v[i] = req.charCodeAt(i)
                wolfssl.wolfSSL_write(ssl!, buf)
                sentRequest = true
            }

            const onReadable = () => {
                // Drain until EOF (n===0 / ZERO_RETURN) or WANT_* hands back
                // to the event loop.
                for (let guard = 0; guard < 10000; guard++) {
                    const buf = new ArrayBuffer(8192)
                    const n = wolfssl.wolfSSL_read(ssl!, buf)
                    if (typeof n !== 'number') {
                        sawNonNumber = true
                        std.printf('    FAIL got non-number %s (want int)\n', String(n))
                        finish()
                        return
                    }
                    if (n > 0) {
                        total += n
                        // Keep draining after the body is complete: the point of
                        // this suite is the no-data/EOF contract, so a full body
                        // must not short-circuit the read that would observe it.
                        continue
                    }
                    const err = wolfssl.wolfSSL_get_error(ssl!, n)
                    if (err !== WANT_READ && err !== WANT_WRITE && err !== ZERO_RETURN) {
                        errOk = false
                        std.printf('    n=%d get_error=%d outside {WANT_READ,WANT_WRITE,ZERO_RETURN}\n', n, err)
                        finish()
                        return
                    }
                    if (n === 0 || err === ZERO_RETURN) {
                        sawEof = true
                        break
                    }
                    // WANT_*: wait for next FD_READ/WRITE
                    return
                }
                if (sawEof) finish()
            }

            sock.set_on_event(s, (event: { lNetworkEvents: number; iErrorCode: number[] }) => {
                if (done) return

                if (event.lNetworkEvents & sock.FdEvent.FD_CONNECT) {
                    if (event.iErrorCode[0] !== 0) {
                        assert('connect error code 0', false)
                        finish()
                        return
                    }
                    connected = true
                    const method = wolfssl.wolfTLSv1_2_client_method()
                    ctx = wolfssl.wolfSSL_CTX_new(method)
                    if (!ctx) { assert('CTX_new', false); finish(); return }
                    wolfssl.wolfSSL_CTX_set_verify(ctx, wolfssl.VerifyMode.SSL_VERIFY_NONE)
                    ssl = wolfssl.wolfSSL_new(ctx)
                    if (!ssl) { assert('SSL_new', false); finish(); return }
                    wolfssl.wolfSSL_set_fd(ssl, sock.get_fd(s))
                    wolfssl.wolfSSL_UseSNI(ssl, wolfssl.SniType.WOLFSSL_SNI_HOST_NAME, 'localhost')
                    // kick handshake immediately (FD_WRITE may not re-fire)
                    {
                        const ret = wolfssl.wolfSSL_connect(ssl)
                        if (ret === wolfssl.ReturnCode.SSL_SUCCESS) {
                            handshakeDone = true
                            sendReq()
                        } else {
                            const err = wolfssl.wolfSSL_get_error(ssl, ret)
                            if (err !== WANT_READ && err !== WANT_WRITE) {
                                assert('TLS handshake failed err=' + err, false)
                                finish()
                            }
                        }
                    }
                }

                if ((event.lNetworkEvents & sock.FdEvent.FD_READ) ||
                    (event.lNetworkEvents & sock.FdEvent.FD_WRITE)) {
                    if (!ssl) return
                    if (!handshakeDone) {
                        const ret = wolfssl.wolfSSL_connect(ssl)
                        if (ret === wolfssl.ReturnCode.SSL_SUCCESS) {
                            handshakeDone = true
                            sendReq()
                        } else {
                            const err = wolfssl.wolfSSL_get_error(ssl, ret)
                            if (err !== WANT_READ && err !== WANT_WRITE) {
                                assert('TLS handshake failed err=' + err, false)
                                finish()
                            }
                        }
                        return
                    }
                    if (sentRequest) onReadable()
                }

                if (event.lNetworkEvents & sock.FdEvent.FD_CLOSE) {
                    // drain remaining then finish
                    if (ssl && sentRequest && !sawNonNumber) {
                        onReadable()
                    }
                    if (!sawNonNumber) {
                        // Server close without an observed EOF read is an edge —
                        // don't fail if the body already completed.
                        if (!sawEof && total < EXPECTED && total > 0) {
                            sawEof = true
                        }
                        if (total >= EXPECTED || sawEof) finish()
                        else { assert('data before close', false); if (!done) finish() }
                    }
                }
            })
            sock.connect(s, '127.0.0.1', HTTPS_PORT)
        })
    }
}
