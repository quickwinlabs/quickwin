import { Tester } from './test_helper.js'
import '../lib/polyfill.js'

export const suite = {
    name: 'url',
    run: (t: Tester) => {
        t.section('http parse')
        const u = new URL('http://example.com')
        t.check('href', 'http://example.com/', u.href)
        t.check('protocol', 'http:', u.protocol)
        t.check('hostname', 'example.com', u.hostname)
        t.check('port', '', u.port)
        t.check('pathname', '/', u.pathname)
        t.check('host', 'example.com', u.host)
        t.check('origin', 'http://example.com', u.origin)

        t.section('full http')
        const u2 = new URL('https://user:pass@host.com:443/path/to?q=1&r=2#frag')
        t.check('protocol', 'https:', u2.protocol)
        t.check('username', 'user', u2.username)
        t.check('password', 'pass', u2.password)
        t.check('hostname', 'host.com', u2.hostname)
        t.check('port', '443', u2.port)
        t.check('pathname', '/path/to', u2.pathname)
        t.check('search', '?q=1&r=2', u2.search)
        t.check('hash', '#frag', u2.hash)
        t.check('host', 'host.com:443', u2.host)

        t.section('query string params')
        t.check('get q', '1', u2.searchParams.get('q'))
        t.check('get r', '2', u2.searchParams.get('r'))
        t.check('has q', true, u2.searchParams.has('q'))
        t.check('has x', false, u2.searchParams.has('x'))

        t.section('relative resolution')
        const b = new URL('./add.wasm', 'http://example.com/base/')
        t.check('relative path', 'http://example.com/base/add.wasm', b.href)
        const b2 = new URL('../other', 'http://example.com/base/')
        t.check('up one dir', 'http://example.com/other', b2.href)
        const b3 = new URL('/abs', 'http://example.com/base/')
        t.check('absolute path', 'http://example.com/abs', b3.href)
        const b4 = new URL('//other.com:8080/path', 'http://example.com/base/')
        t.check('protocol-relative', 'http://other.com:8080/path', b4.href)

        t.section('file URL')
        const f = new URL('file:///C:/Users/test/file.js')
        t.check('protocol', 'file:', f.protocol)
        t.check('hostname', '', f.hostname)
        t.check('pathname', '/C:/Users/test/file.js', f.pathname)

        t.section('file relative resolution')
        const f2 = new URL('./add.wasm', 'file:///C:/Users/test/helper.js')
        t.check('file relative', 'file:///C:/Users/test/add.wasm', f2.href)
        const f3 = new URL('../other.wasm', 'file:///C:/Users/test/sub/helper.js')
        t.check('file up dir', 'file:///C:/Users/test/other.wasm', f3.href)

        t.section('URLSearchParams')
        const p = new URLSearchParams('a=1&b=2&a=3')
        t.check('get a', '1', p.get('a'))
        t.check('getAll a', 2, p.getAll('a').length)
        t.check('get b', '2', p.get('b'))
        t.check('has c', false, p.has('c'))
        t.check('size', 3, p.size)

        t.section('URLSearchParams set/append/delete')
        const p2 = new URLSearchParams()
        p2.append('key', 'val1')
        p2.append('key', 'val2')
        t.check('append 2', 2, p2.getAll('key').length)
        p2.set('key', 'new')
        t.check('set replaces', 1, p2.getAll('key').length)
        t.check('set value', 'new', p2.get('key'))
        p2.append('x', 'y')
        p2.delete('x')
        t.check('delete', false, p2.has('x'))

        t.section('URLSearchParams toString')
        const p3 = new URLSearchParams('q=hello&r=world')
        t.check('toString', 'q=hello&r=world', p3.toString())

        t.section('URLSearchParams iterator')
        const p4 = new URLSearchParams('a=1&b=2')
        const keys: string[] = []
        for (const k of p4.keys()) keys.push(k)
        t.check('keys', 'a,b', keys.join(','))

        t.section('URL toJSON')
        const j = new URL('http://example.com/path')
        t.check('toJSON', 'http://example.com/path', j.toJSON())

        t.section('URL toString')
        t.check('toString', 'http://example.com/path', j.toString())

        t.section('IPv6')
        const v6 = new URL('http://[::1]:8080/path')
        t.check('hostname', '::1', v6.hostname)
        t.check('port', '8080', v6.port)
        t.check('host', '[::1]:8080', v6.host)
        t.check('pathname', '/path', v6.pathname)
        const v6b = new URL('http://[2001:db8::1]/')
        t.check('IPv6 no port', '2001:db8::1', v6b.hostname)
        t.check('IPv6 host', '[2001:db8::1]', v6b.host)
        const v6c = new URL('http://[::1]:8080')
        t.check('IPv6 origin', 'http://[::1]:8080', v6c.origin)

        t.section('ws/wss')
        const ws = new URL('ws://example.com/socket')
        t.check('ws protocol', 'ws:', ws.protocol)
        t.check('ws hostname', 'example.com', ws.hostname)
        t.check('ws pathname', '/socket', ws.pathname)
        const wss = new URL('wss://secure.com:9090/chat')
        t.check('wss port', '9090', wss.port)

        t.section('relative fragment/query')
        const rf = new URL('#top', 'http://example.com/path')
        t.check('fragment-only', 'http://example.com/path#top', rf.href)
        const rq = new URL('?q=1', 'http://example.com/path')
        t.check('query-only', 'http://example.com/path?q=1', rq.href)
        const rqf = new URL('?a=1#hash', 'http://example.com/path')
        t.check('query+frag', 'http://example.com/path?a=1#hash', rqf.href)

        t.section('path normalization')
        const np1 = new URL('a/../../other', 'http://example.com/base/')
        t.check('multi up', 'http://example.com/other', np1.href)
        const np2 = new URL('/../other', 'http://example.com/base/')
        t.check('root up', 'http://example.com/other', np2.href)
        const np3 = new URL('.', 'http://example.com/base/')
        t.check('dot only', 'http://example.com/base', np3.href)
        const np4 = new URL('', 'http://example.com/base/')
        t.check('empty relative', 'http://example.com/base/', np4.href)

        t.section('IP address')
        const ip = new URL('http://127.0.0.1:8080/path')
        t.check('ip hostname', '127.0.0.1', ip.hostname)
        t.check('ip port', '8080', ip.port)

        t.section('URLSearchParams values/entries/forEach')
        const pv = new URLSearchParams('a=1&b=2')
        const vals: string[] = []
        for (const v of pv.values()) vals.push(v)
        t.check('values', '1,2', vals.join(','))
        const entries: string[] = []
        for (const [k, v] of pv.entries()) entries.push(k + '=' + v)
        t.check('entries', 'a=1,b=2', entries.join(','))
        let forEachStr = ''
        pv.forEach((v, k) => { forEachStr += k + '=' + v + '|' })
        t.check('forEach', 'a=1|b=2|', forEachStr)
        const ps = new URLSearchParams('b=2&a=1&c=3')
        ps.sort()
        t.check('sort', 'a=1&b=2&c=3', ps.toString())

        t.section('URLSearchParams edge cases')
        const pe1 = new URLSearchParams('a=1&b')
        t.check('empty value', '', pe1.get('b'))
        const pe2 = new URLSearchParams('?a=1&b=2')
        t.check('leading ?', '1', pe2.get('a'))
        const pe3 = new URLSearchParams([['x', '10'], ['y', '20']] as any)
        t.check('array init', '10', pe3.get('x'))
        t.check('array init 2', '20', pe3.get('y'))
        t.check('array size', 2, pe3.size)

        t.section('encoded chars')
        const enc = new URL('http://example.com/hello%20world')
        t.check('encoded pathname', '/hello%20world', enc.pathname)
        const encq = new URL('http://example.com/path?q=a+b&r=%25')
        t.check('encoded query +→space', 'a b', encq.searchParams.get('q'))
        t.check('encoded query %25', '%', encq.searchParams.get('r'))

        t.section('null/undefined base')
        let threw = false
        try { new URL('/path', null as any) } catch { threw = true }
        t.check('null base throws', true, threw)
        threw = false
        try { new URL('relative') } catch { threw = true }
        t.check('no base throws', true, threw)

        t.section('data URL')
        const d = new URL('data:text/plain,hello')
        t.check('data protocol', 'data:', d.protocol)
        t.check('data hostname', '', d.hostname)
        t.check('data pathname', 'text/plain,hello', d.pathname)
    }
}
