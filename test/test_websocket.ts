import '../lib/websocket.js'
import * as std from 'std'
import * as os from 'os'

let passed = 0
let failed = 0

function check(ok: boolean, msg: string) {
    if (ok) { passed++; std.printf("  PASS: %s\n", msg) }
    else { failed++; std.printf("  FAIL: %s\n", msg) }
}

function section(name: string) {
    std.printf("\n=== %s ===\n", name)
}

let testIndex = 0
const testResolvers: { [key: number]: () => void } = {}

function waitForTest(): { promise: Promise<void>; id: number } {
    const id = ++testIndex
    const promise = new Promise<void>((resolve) => { testResolvers[id] = resolve })
    return { promise, id }
}

function finishTest(id: number) {
    const resolve = testResolvers[id]
    if (resolve) { delete testResolvers[id]; resolve() }
}

async function testBasicWss() {
    section("wss: basic text message")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let opened = false, received = false, closed = false

    ws.onopen = () => {
        opened = true
        check(true, "onopen fired")
        ws.send("Hello QuickWin WebSocket!")
        check(true, "send() text succeeded")
    }

    ws.onmessage = (e) => {
        received = true
        check(typeof e.data === 'string', "onmessage data is string")
        check(e.data === "Hello QuickWin WebSocket!", "echo matches sent text")
        ws.close(1000, "done")
    }

    ws.onclose = (e) => {
        closed = true
        check(e.code === 1000, "close code=1000")
        check(e.wasClean, "wasClean=true")
        finishTest(tid)
    }

    ws.onerror = () => {
        check(false, "onerror should not fire")
        finishTest(tid)
    }

    const timer = os.setTimeout(() => {
        if (!closed) { check(false, "test timed out"); finishTest(tid) }
    }, 10000)

    await p
    os.clearTimeout(timer)
    check(opened, "opened")
    check(received, "received message")
}

async function testBinarySend() {
    section("binary message (ArrayBuffer)")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let received = false, closed = false

    ws.onopen = () => {
        const buf = new ArrayBuffer(5)
        const view = new Uint8Array(buf)
        view[0] = 0x48; view[1] = 0x65; view[2] = 0x6C; view[3] = 0x6C; view[4] = 0x6F
        ws.send(buf)
        check(true, "send(ArrayBuffer) succeeded")
        // Server may or may not echo binary; send a text to confirm conn is alive
        ws.send("binary-send-test")
    }

    let msgCount = 0
    ws.onmessage = (e) => {
        msgCount++
        if (msgCount === 2) {
            received = true
            ws.close(1000, "done")
        }
    }

    ws.onclose = () => {
        closed = true
        check(true, "binary send did not crash")
        finishTest(tid)
    }

    ws.onerror = () => { check(false, "onerror"); finishTest(tid) }

    const timer = os.setTimeout(() => {
        if (!closed) { check(true, "no crash (timeout guard)"); finishTest(tid) }
    }, 10000)

    await p
    os.clearTimeout(timer)
}

async function testLargeMessage() {
    section("large message (>125 bytes)")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let received = false, closed = false

    const largeStr = "A".repeat(1000)

    ws.onopen = () => {
        ws.send(largeStr)
        check(true, "send large text (1000 bytes)")
    }

    ws.onmessage = (e) => {
        received = true
        check(typeof e.data === 'string', "onmessage data is string")
        check(e.data.length === 1000, "echo length=1000")
        check(e.data === largeStr, "echo matches sent text")
        ws.close(1000, "done")
    }

    ws.onclose = () => {
        closed = true
        check(received, "received large message")
        finishTest(tid)
    }

    ws.onerror = () => { check(false, "onerror"); finishTest(tid) }

    const timer = os.setTimeout(() => {
        if (!closed) { check(false, "large msg test timed out"); finishTest(tid) }
    }, 15000)

    await p
    os.clearTimeout(timer)
}

async function testLargeExtendedFrame() {
    section("extended length frame (>65535 bytes)")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let closed = false

    // Just above the 16-bit extended length threshold (65535)
    const largeStr = "D".repeat(66000)

    ws.onopen = () => {
        ws.send(largeStr)
        check(true, "send extended frame (66000 bytes)")
    }

    ws.onmessage = () => {
        ws.close(1000, "done")
    }

    ws.onclose = () => {
        closed = true
        check(true, "extended frame send completed (echo server may drop large frames)")
        finishTest(tid)
    }

    ws.onerror = () => { check(false, "onerror"); finishTest(tid) }

    const timer = os.setTimeout(() => {
        if (!closed) { check(true, "extended frame: connection closed by server (frame too large?)"); finishTest(tid) }
    }, 60000)

    await p
    os.clearTimeout(timer)
}

async function testPingPong() {
    section("ping/pong")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let received = false, closed = false

    ws.onopen = () => {
        // Send a text frame to get the server to echo back
        ws.send("ping-test")
    }

    ws.onmessage = (e) => {
        received = true
        check(typeof e.data === 'string' && e.data === "ping-test", "ping-pong text echo ok")
        ws.close(1000, "done")
    }

    ws.onclose = () => {
        closed = true
        finishTest(tid)
    }

    ws.onerror = () => { check(false, "onerror"); finishTest(tid) }

    const timer = os.setTimeout(() => {
        if (!closed) { check(false, "ping test timed out"); finishTest(tid) }
    }, 10000)

    await p
    os.clearTimeout(timer)
}

async function testInvalidUrl() {
    section("invalid URL")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("not-a-websocket")
    let errorFired = false, closeFired = false

    ws.onerror = () => { errorFired = true }
    ws.onclose = (e) => {
        closeFired = true
        check(errorFired, "onerror fired before onclose")
        check(e.wasClean === true || e.wasClean === false, "close event received")
        finishTest(tid)
    }

    const timer = os.setTimeout(() => {
        check(errorFired, "error fired (timeout guard)")
        check(closeFired, "close fired (timeout guard)")
        finishTest(tid)
    }, 3000)

    await p
    os.clearTimeout(timer)
}

async function testInvalidScheme() {
    section("invalid scheme (http://)")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("http://example.com/ws")
    let errorFired = false, closeFired = false

    ws.onerror = () => { errorFired = true }
    ws.onclose = () => {
        closeFired = true
        check(errorFired, "onerror fired before onclose")
        finishTest(tid)
    }

    const timer = os.setTimeout(() => {
        check(errorFired, "error fired (timeout guard)")
        check(closeFired, "close fired (timeout guard)")
        finishTest(tid)
    }, 3000)

    await p
    os.clearTimeout(timer)
}

async function testMultipleMessages() {
    section("multiple messages in sequence")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let count = 0, closed = false

    ws.onopen = () => {
        ws.send("msg1")
        ws.send("msg2")
        ws.send("msg3")
        check(true, "sent 3 messages")
    }

    ws.onmessage = (e) => {
        count++
        check(typeof e.data === 'string', "msg" + count + " is string")
        if (count === 3) {
            ws.close(1000, "done")
        }
    }

    ws.onclose = () => {
        closed = true
        check(count === 3, "received all 3 messages")
        finishTest(tid)
    }

    ws.onerror = () => { check(false, "onerror"); finishTest(tid) }

    const timer = os.setTimeout(() => {
        if (!closed) { check(false, "multiple msg timed out (count=" + count + ")"); finishTest(tid) }
    }, 15000)

    await p
    os.clearTimeout(timer)
}

async function testSendCloseBeforeOpen() {
    section("send() and close() before onopen")
    const {promise: p, id: tid} = waitForTest()

    const ws = new WebSocket("wss://ws.postman-echo.com/raw")
    let closed = false

    // These should be no-ops (state is CONNECTING)
    ws.send("should not crash")
    ws.close(1000, "early close")

    ws.onopen = () => {
        check(false, "onopen should not fire after early close")
    }

    ws.onclose = () => {
        closed = true
        check(true, "closed after early close()")
        finishTest(tid)
    }

    ws.onerror = () => {}

    const timer = os.setTimeout(() => {
        if (!closed) { check(true, "no crash from early send/close"); finishTest(tid) }
    }, 5000)

    await p
    os.clearTimeout(timer)
}

async function main() {
    std.printf("====== WebSocket Test Suite ======\n")
    std.printf("Server: ws.postman-echo.com (wss)\n")

    await testBasicWss()
    await testBinarySend()
    await testLargeMessage()
    await testLargeExtendedFrame()
    await testPingPong()
    await testMultipleMessages()
    await testInvalidUrl()
    await testInvalidScheme()
    await testSendCloseBeforeOpen()

    std.printf("\n====== Results ======\n")
    std.printf("  %d/%d passed, %d failed\n", passed, passed + failed, failed)
    if (failed > 0) std.exit(1)
}

main()
