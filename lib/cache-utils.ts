// ── INI-format cache helpers ──

export interface IniCache {
    headers: Record<string, string>
    meta: Record<string, string>
}

export function parseIni(text: string): IniCache {
    const headers: Record<string, string> = {}
    const meta: Record<string, string> = {}
    let section = ''
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '[headers]') { section = 'headers'; continue }
        if (trimmed === '[meta]') { section = 'meta'; continue }
        if (!section || !trimmed) continue
        const colon = trimmed.indexOf(':')
        if (colon < 0) continue
        const key = trimmed.slice(0, colon).trim()
        const val = trimmed.slice(colon + 1).trim()
        if (section === 'headers') headers[key] = val
        else if (section === 'meta') meta[key] = val
    }
    return { headers, meta }
}

export function toIni(headers: Record<string, string>, meta: Record<string, string>): string {
    let s = ''
    if (Object.keys(headers).length > 0) {
        s += '[headers]\n'
        for (const k in headers) {
            s += k + ': ' + headers[k] + '\n'
        }
    }
    s += '[meta]\n'
    for (const k in meta) {
        s += k + ': ' + meta[k] + '\n'
    }
    return s
}
