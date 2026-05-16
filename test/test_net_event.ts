import * as sock from "sock"
import * as std from "std"
import * as os from "os"
import { Tester } from './test_helper.js'

interface WSAEvent {
    lNetworkEvents: number;
    iErrorCode: number[];
}

export const suite = {
    name: 'net-event',
    run: async (t: Tester): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
            const s = sock.socket()
            if (!s || s === 0) { t.fail++; reject(new Error('socket() failed')); return }

            var connected = false, gotData = false

            const hostIP = sock.resolve("httpbin.org")
            if (!hostIP) { t.fail++; reject(new Error('dns failed')); return }

            const timeoutId = os.setTimeout(() => {
                if (!connected) {
                    sock.closesocket(s)
                    reject(new Error('connect timeout'))
                }
            }, 10000)

            sock.set_on_event(s, (event: WSAEvent) => {
                if (event.lNetworkEvents & sock.FD_CONNECT) {
                    if (event.iErrorCode[0] === 0) {
                        connected = true; t.ok++
                        os.clearTimeout(timeoutId)
                        const req = "GET / HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n"
                        const buf = new ArrayBuffer(req.length)
                        const v = new Uint8Array(buf)
                        for (let i = 0; i < req.length; i++) v[i] = req.charCodeAt(i)
                        sock.send(s, buf)
                    } else {
                        sock.closesocket(s)
                        reject(new Error('connect error: ' + event.iErrorCode[0]))
                    }
                }
                if (event.lNetworkEvents & sock.FD_READ && connected && !gotData) {
                    const data = sock.recv(s, 4096)
                    if (data && data.byteLength > 0) { gotData = true; t.ok++ }
                }
                if (event.lNetworkEvents & sock.FD_CLOSE) {
                    os.clearTimeout(timeoutId)
                    sock.closesocket(s)
                    if (gotData && connected) resolve()
                    else reject(new Error('test incomplete'))
                }
            })
            sock.connect(s, hostIP, 80)
        })
    }
}
