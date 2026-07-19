export function assertNonNullable<T>(v: T, msg?: string): asserts v is NonNullable<T> {
    if (v === null || v === undefined) throw new Error(msg ?? `Assert failed: unexpected ${v}`)
}

export function assertArrayBuffer(v: ArrayBufferLike): asserts v is ArrayBuffer {
    if (!(v instanceof ArrayBuffer)) throw new Error('Assert failed: expected ArrayBuffer')
}