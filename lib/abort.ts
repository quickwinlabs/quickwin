// ── Minimal AbortSignal / AbortController ──
//
// quickwin has no EventTarget/DOM runtime, so this is a self-contained,
// dependency-free subset of the WHATWG API used for client-disconnect
// notifications on the HTTP server (and fetch cancellation).
//
// Semantics mirror the web platform on the points that matter:
//   - abort() fires listeners synchronously (same call stack), once, idempotently;
//   - listeners registered AFTER the signal already aborted are ignored
//     (late listeners are never called); consumers must pre-check signal.aborted.

export interface AbortEvent {
    readonly type: 'abort'
    readonly target: unknown
}

export class AbortSignal {
    private _aborted = false
    private _reason: unknown = undefined
    private _listeners: ((e: AbortEvent) => void)[] = []
    onabort: ((e: AbortEvent) => void) | null = null

    get aborted(): boolean {
        return this._aborted
    }

    get reason(): unknown {
        return this._reason
    }

    addEventListener(type: string, listener: (e: AbortEvent) => void): void {
        if (this._aborted || type !== 'abort') return
        this._listeners.push(listener)
    }

    removeEventListener(type: string, listener: (e: AbortEvent) => void): void {
        if (this._aborted || type !== 'abort') return
        const i = this._listeners.indexOf(listener)
        if (i >= 0) this._listeners.splice(i, 1)
    }

    /** @internal fired by AbortController.abort() */
    _fire(reason: unknown): void {
        if (this._aborted) return
        this._aborted = true
        this._reason = reason
        const ev: AbortEvent = { type: 'abort', target: this }
        const ls = this._listeners
        this._listeners = []
        if (this.onabort) {
            try { this.onabort(ev) } catch (e) { console.error('[abort] onabort handler error:', e) }
        }
        for (const l of ls) {
            try { l(ev) } catch (e) { console.error('[abort] listener error:', e) }
        }
    }

    throwIfAborted(): void {
        if (this._aborted) throw this._reason
    }
}

export class AbortController {
    readonly signal = new AbortSignal()

    abort(reason?: unknown): void {
        this.signal._fire(reason)
    }
}