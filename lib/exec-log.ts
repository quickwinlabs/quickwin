export interface LogEntry {
    /** epoch 秒 */
    ts: number
    /** 展示用命令/请求描述 */
    cmd: string
    /** HTTP 状态码（401/404/500/504 等）；异常终止用 -1 */
    status: number
    /** X-Exit-Code（子进程退出码）；无则 null */
    exit: number | null
    /** 耗时 ms */
    durMs: number
    /** 附加说明（如超时/拒绝原因） */
    note?: string
}

/** 请求日志：固定容量环形缓冲，GUI ListBox 每行一条。 */
export class RequestLog {
    private buf: LogEntry[] = []

    constructor(private readonly cap = 100) { }

    get size(): number { return this.buf.length }

    push(e: LogEntry): void {
        this.buf.push(e)
        if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap)
    }

    list(): LogEntry[] { return this.buf.slice() }
}