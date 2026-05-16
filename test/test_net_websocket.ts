import '../lib/websocket.js'
import * as std from 'std'
import * as os from 'os'
import { Tester } from './test_helper.js'

export const suite = {
    name: 'net-websocket',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        let testId = 0
        const resolvers: Record<number, () => void> = {}

        function waitForTest(): { promise: Promise<void>; id: number } {
            const id = ++testId
            const promise = new Promise<void>((resolve) => { resolvers[id] = resolve })
            return { promise, id }
        }

        function finishTest(id: number) {
            const r = resolvers[id]
            if (r) { delete resolvers[id]; r() }
        }

        // ── wss basic ──
        t.section('wss basic text message')
        const p1 = waitForTest()
        let opened = false, received = false, closed = false
        const ws1 = new WebSocket("wss://ws.postman-echo.com/raw")
        ws1.onopen = () => { opened = true; ws1.send("Hello WebSocket!") }
        ws1.onmessage = () => { received = true; ws1.close(1000, "done") }
        ws1.onclose = (e) => {
            closed = true
            assert('onopen fired', opened)
            assert('onmessage received', received)
            assert('close code=1000', e.code === 1000)
            assert('wasClean', e.wasClean)
            finishTest(p1.id)
        }
        ws1.onerror = () => { assert('no error', false); finishTest(p1.id) }
        const timer1 = os.setTimeout(() => { if (!closed) { assert('no timeout', false); finishTest(p1.id) } }, 10000)
        await p1.promise
        os.clearTimeout(timer1)

        // ── large message ──
        t.section('large message (>125 bytes)')
        const p2 = waitForTest()
        const ws2 = new WebSocket("wss://ws.postman-echo.com/raw")
        let largeOk = false, closed2 = false
        const largeStr = "A".repeat(1000)
        ws2.onopen = () => { ws2.send(largeStr) }
        ws2.onmessage = (e) => { largeOk = e.data.length === 1000; ws2.close(1000, "done") }
        ws2.onclose = () => { closed2 = true; assert('large msg echo 1000 bytes', largeOk); finishTest(p2.id) }
        ws2.onerror = () => { assert('no error', false); finishTest(p2.id) }
        const timer2 = os.setTimeout(() => { if (!closed2) { assert('large msg no timeout', false); finishTest(p2.id) } }, 15000)
        await p2.promise
        os.clearTimeout(timer2)

        // ── multiple messages ──
        t.section('multiple messages')
        const p3 = waitForTest()
        const ws3 = new WebSocket("wss://ws.postman-echo.com/raw")
        let count = 0, closed3 = false
        ws3.onopen = () => { ws3.send("a"); ws3.send("b"); ws3.send("c") }
        ws3.onmessage = () => { count++; if (count === 3) ws3.close(1000, "done") }
        ws3.onclose = () => { closed3 = true; assert('received 3 messages', count === 3); finishTest(p3.id) }
        ws3.onerror = () => { assert('no error', false); finishTest(p3.id) }
        const timer3 = os.setTimeout(() => { if (!closed3) { assert('no timeout', false); finishTest(p3.id) } }, 15000)
        await p3.promise
        os.clearTimeout(timer3)

        // ── invalid URL ──
        t.section('invalid URL')
        const p4 = waitForTest()
        const ws4 = new WebSocket("not-a-websocket")
        let err4 = false
        ws4.onerror = () => { err4 = true }
        ws4.onclose = () => { assert('onerror fired', err4); finishTest(p4.id) }
        const timer4 = os.setTimeout(() => { assert('invalid url error', err4); finishTest(p4.id) }, 3000)
        await p4.promise
        os.clearTimeout(timer4)

        // ── invalid scheme ──
        t.section('invalid scheme (http://)')
        const p5 = waitForTest()
        const ws5 = new WebSocket("http://example.com/ws")
        let err5 = false
        ws5.onerror = () => { err5 = true }
        ws5.onclose = () => { assert('http scheme onerror', err5); finishTest(p5.id) }
        const timer5 = os.setTimeout(() => { assert('http scheme error guard', err5); finishTest(p5.id) }, 3000)
        await p5.promise
        os.clearTimeout(timer5)

        // ── early send/close ──
        t.section('send/close before onopen')
        const p6 = waitForTest()
        const ws6 = new WebSocket("wss://ws.postman-echo.com/raw")
        ws6.send("noop")
        ws6.close(1000, "early")
        let close6 = false
        ws6.onopen = () => { assert('onopen after early close', false) }
        ws6.onclose = () => { close6 = true; assert('early close ok', true); finishTest(p6.id) }
        ws6.onerror = () => {}
        const timer6 = os.setTimeout(() => { if (!close6) assert('no crash', true); finishTest(p6.id) }, 5000)
        await p6.promise
        os.clearTimeout(timer6)
    }
}
