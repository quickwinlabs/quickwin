/// <reference types="node" />

import * as http from 'node:http'
import * as https from 'node:https'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'

const HTTP_PORT = parseInt(process.argv[2], 10) || 18923
const HTTPS_PORT = HTTP_PORT + 1

function parseBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
        req.on('end', () => resolve(body))
    })
}

function getPath(url: string | undefined): string {
    const idx = (url || '/').indexOf('?')
    return idx < 0 ? (url || '/') : url!.slice(0, idx)
}

function getQuery(url: string | undefined): Record<string, string> {
    const qIdx = (url || '').indexOf('?')
    if (qIdx < 0) return {}
    const params = new URLSearchParams(url!.slice(qIdx + 1))
    const result: Record<string, string> = {}
    for (const [k, v] of params) result[k] = v
    return result
}

function jsonEcho(req: http.IncomingMessage, body: string): string {
    const data: Record<string, any> = {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])
        ),
        args: getQuery(req.url),
        data: body || ''
    }
    return JSON.stringify(data)
}

const server = http.createServer(async (req, res) => {
    const pathname = getPath(req.url)

    if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('hello from test server')
        return
    }

    if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/any' || pathname === '/anything')) {
        const body = req.method === 'POST' ? await parseBody(req) : ''
        const json = jsonEcho(req, body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(json)
        return
    }

    if (req.method === 'GET' && pathname.startsWith('/base64/')) {
        const encoded = pathname.slice('/base64/'.length)
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(decoded)
        return
    }

    if (req.method === 'POST' && pathname === '/post') {
        const body = await parseBody(req)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(body)
        return
    }

    if (req.method === 'GET' && pathname === '/cache/60') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=60'
        })
        res.end('cached response')
        return
    }

    res.writeHead(404)
    res.end('not found')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data.toString())
        }
    })
})

const certDir = path.dirname(process.argv[1] || __filename)
const httpsOpts = {
    key: fs.readFileSync(path.join(certDir, 'test-key.pem'), 'utf-8'),
    cert: fs.readFileSync(path.join(certDir, 'test-cert.pem'), 'utf-8'),
}
const httpsServer = https.createServer(httpsOpts, async (req, res) => {
    const pathname = getPath(req.url)

    if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('hello from test server')
        return
    }

    if ((req.method === 'GET' || req.method === 'POST') && (pathname === '/any' || pathname === '/anything')) {
        const body = req.method === 'POST' ? await parseBody(req) : ''
        const json = jsonEcho(req, body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(json)
        return
    }

    if (req.method === 'GET' && pathname.startsWith('/base64/')) {
        const encoded = pathname.slice('/base64/'.length)
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(decoded)
        return
    }

    if (req.method === 'POST' && pathname === '/post') {
        const body = await parseBody(req)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(body)
        return
    }

    if (req.method === 'GET' && pathname === '/cache/60') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=60'
        })
        res.end('cached response')
        return
    }

    res.writeHead(404)
    res.end('not found')
})

httpsServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
    })
})

server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`test server listening on http://127.0.0.1:${HTTP_PORT}/`)
})
httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => {
    console.log(`test server listening on https://127.0.0.1:${HTTPS_PORT}/`)
})
