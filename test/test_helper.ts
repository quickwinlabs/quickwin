import * as std from 'std'

const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const BOLD  = '\x1b[1m'
const RESET = '\x1b[0m'

export function readWasmFile(path: string): ArrayBuffer | null {
    const base = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1)
    const parts = (base + path).split('/')
    const out: string[] = []
    for (const p of parts) {
        if (p === '..') out.pop()
        else if (p !== '.') out.push(p)
    }
    let filePath = out.join('/').slice(7)
    if (filePath.length >= 3 && filePath[1] === ':') filePath = filePath.slice(1)
    const fp = std.open(filePath, 'rb')
    if (!fp) return null
    fp.seek(0, 2)
    const size = fp.tell()
    fp.seek(0, 0)
    const buffer = new ArrayBuffer(size)
    fp.read(buffer, 0, size)
    fp.close()
    return buffer
}

export class Tester {
    ok = 0
    fail = 0

    section(name: string): void {
        std.printf('\n%s=== %s ===%s\n', BOLD, name, RESET)
    }

    check(name: string, expected: unknown, actual: unknown): void {
        if (typeof expected === 'number' && typeof actual === 'number') {
            if (Math.abs(expected - actual) < 0.0001) {
                this.ok++; std.printf('  %sPASS:%s %s = %s\n', GREEN, RESET, name, String(actual))
            } else {
                this.fail++; std.printf('  %sFAIL:%s %s = %s (expected %s)\n', RED, RESET, name, String(actual), String(expected))
            }
        } else if (expected === actual) {
            this.ok++; std.printf('  %sPASS:%s %s = %s\n', GREEN, RESET, name, String(actual))
        } else {
            this.fail++; std.printf('  %sFAIL:%s %s = %s (expected %s)\n', RED, RESET, name, String(actual), String(expected))
        }
    }

    checkTrue(name: string, actual: boolean): void {
        this.check(name, true, actual)
    }

    summary(): void {
        const color = this.fail > 0 ? RED : GREEN
        std.printf('\n%s%d/%d passed%s\n', color, this.ok, this.ok + this.fail, RESET)
    }
}
