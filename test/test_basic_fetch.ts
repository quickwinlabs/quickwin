import * as std from 'std'
import '../lib/fetch.js'
import { Tester } from './test_helper.js'

const PORT = 18923
const URL127 = `http://127.0.0.1:${PORT}/`
const URLLocalhost = `http://localhost:${PORT}/`

export const suite = {
    name: 'basic-fetch',
    run: async (t: Tester) => {
        function assert(name: string, ok: boolean): void {
            if (ok) { t.ok++; std.printf('  PASS: %s\n', name) }
            else { t.fail++; std.printf('  FAIL: %s\n', name) }
        }

        t.section('fetch 127.0.0.1')
        {
            const r = await fetch(URL127)
            assert('status 200', r.status === 200)
            const body = await r.text()
            assert('body = hello from test server', body === 'hello from test server')
        }

        t.section('fetch localhost')
        {
            const r = await fetch(URLLocalhost)
            assert('status 200', r.status === 200)
            const body = await r.text()
            assert('body = hello from test server', body === 'hello from test server')
        }
    }
}
