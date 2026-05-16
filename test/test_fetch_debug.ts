import '../lib/fetch.js'
import * as std from 'std'

async function main() {
    const urls = ['http://httpbin.org/', 'https://httpbin.org/',
        'http://example.com/', 'https://example.com/']
    for (const url of urls) {
        try {
            const r = await fetch(url)
            const text = await r.text()
            std.printf('%s → %d (%d bytes, first 80: %s)\n', url, r.status, text.length, text.slice(0, 80).replace(/\n/g, '\\n'))
        } catch (e: unknown) {
            std.printf('%s → ERROR: %s\n', url, (e as Error).message)
        }
    }
}
main()
