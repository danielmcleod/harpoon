// NDJSON JSON-RPC peer (jsonrpc.JsonRpcPeer): Codex app-server (`header:'omit'`) and ACP
// (`header:'2.0'`). Unknown incoming requests get -32601; -32001 (overloaded) is retried at 250/1000/3000 ms;
// three unparseable lines in a row raise `stream_malformed`.
import type { Readable, Writable } from 'node:stream'
import { LineSplitter } from './lines.ts'
import type { LineRecord } from './lines.ts'
import type { ChildHandle, TapFn } from './spawn.ts'

export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
export const SERVER_OVERLOADED = -32001
export const RPC_RETRY_DELAYS_MS: readonly number[] = [250, 1000, 3000]
export const MALFORMED_THRESHOLD = 3
export const RPC_MAX_LINE_BYTES = 32 * 1024 * 1024
/** How many locally timed-out request ids are remembered so their late replies are dropped quietly. */
const TIMED_OUT_IDS_MAX = 256

export type RpcId = number | string

export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export class JsonRpcError extends Error {
  readonly code: number
  readonly data: unknown
  readonly method: string | undefined

  constructor(code: number, message: string, data?: unknown, method?: string) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
    this.method = method
  }
}

export type PeerErrorKind = 'timeout' | 'closed'

/** Local failures (timeout, peer closed) — not protocol errors from the other side. */
export class JsonRpcPeerError extends Error {
  readonly kind: PeerErrorKind
  readonly method: string

  constructor(kind: PeerErrorKind, method: string, message: string) {
    super(message)
    this.name = 'JsonRpcPeerError'
    this.kind = kind
    this.method = method
  }
}

export type StreamErrorReason = 'malformed' | 'unknown-response-id' | 'oversize'

/** Stream-level problems; the adapter classifies them (`stream_malformed`). */
export interface RpcStreamError {
  category: 'stream_malformed'
  reason: StreamErrorReason
  message: string
  /** The offending raw lines (malformed: the last three). */
  lines: string[]
}

export interface RpcTransport {
  /** Incoming records (line or oversize); the iterator ends when the stream closes. */
  records: AsyncIterable<LineRecord>
  writeLine(value: unknown): Promise<boolean>
  close?(): void
}

export interface JsonRpcPeerOptions {
  header: 'omit' | '2.0'
  /** Default per-request timeout (per attempt); undefined = none. */
  defaultTimeoutMs?: number
  retryDelaysMs?: readonly number[]
}

export interface RequestOptions {
  timeoutMs?: number
  /** Retry -32001 (default true). */
  retry?: boolean
}

export interface IncomingRequestContext {
  id: RpcId
  method: string
}

export type RequestHandler = (params: unknown, ctx: IncomingRequestContext) => unknown
export type NotificationHandler = (params: unknown, method: string) => void

interface Pending {
  method: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function toErrorObject(err: unknown): RpcErrorObject {
  if (err instanceof JsonRpcError) {
    const out: RpcErrorObject = { code: err.code, message: err.message }
    if (err.data !== undefined) out.data = err.data
    return out
  }
  return { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) }
}

export class JsonRpcPeer {
  private readonly transport: RpcTransport
  private readonly opts: JsonRpcPeerOptions
  private nextId = 1
  private readonly pending = new Map<RpcId, Pending>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private readonly errorListeners = new Set<(e: RpcStreamError) => void>()
  private readonly closeListeners = new Set<() => void>()
  private malformed: string[] = []
  private closed = false
  /** Ids whose request timed out locally; a reply that arrives later is normal, not a stream error. */
  private readonly timedOut = new Set<RpcId>()
  readonly done: Promise<void>

  constructor(transport: RpcTransport, opts: JsonRpcPeerOptions) {
    this.transport = transport
    this.opts = opts
    this.done = this.readLoop()
  }

  /** Over a spawned child's stdout/stdin. */
  static fromChild(
    child: Pick<ChildHandle, 'records' | 'writeLine' | 'closeStdin'>,
    opts: JsonRpcPeerOptions,
  ): JsonRpcPeer {
    return new JsonRpcPeer(
      {
        records: child.records('stdout'),
        writeLine: (v) => child.writeLine(v),
        close: () => child.closeStdin(),
      },
      opts,
    )
  }

  /** Over any readable/writable pair (a socket, a PassThrough pair in tests). */
  static fromStreams(
    readable: Readable,
    writable: Writable,
    opts: JsonRpcPeerOptions & { maxLineBytes?: number; tap?: TapFn },
  ): JsonRpcPeer {
    const max = opts.maxLineBytes ?? RPC_MAX_LINE_BYTES
    const tap = opts.tap
    async function* records(): AsyncGenerator<LineRecord> {
      const splitter = new LineSplitter(max)
      for await (const chunk of readable as AsyncIterable<Buffer | string>) {
        for (const rec of splitter.push(chunk)) {
          if (rec.kind === 'line') tap?.('out', rec.line)
          yield rec
        }
      }
      yield* splitter.end()
    }
    const writeLine = (value: unknown): Promise<boolean> => {
      if (writable.destroyed || writable.writableEnded) return Promise.resolve(false)
      const line = JSON.stringify(value)
      tap?.('in', line)
      return new Promise((resolve) => {
        writable.write(`${line}\n`, (err) => resolve(err === null || err === undefined))
      })
    }
    return new JsonRpcPeer({ records: records(), writeLine, close: () => writable.end() }, opts)
  }

  get isClosed(): boolean {
    return this.closed
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method)
    }
  }

  /** `method` may be '*' for every notification. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set()
    set.add(handler)
    this.notificationHandlers.set(method, set)
    return () => set.delete(handler)
  }

  onError(listener: (e: RpcStreamError) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async request<T = unknown>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<T> {
    const delays = opts.retry === false ? [] : (this.opts.retryDelaysMs ?? RPC_RETRY_DELAYS_MS)
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.requestOnce(method, params, opts.timeoutMs ?? this.opts.defaultTimeoutMs)) as T
      } catch (err) {
        const wait = delays[attempt]
        if (
          !(err instanceof JsonRpcError) ||
          err.code !== SERVER_OVERLOADED ||
          wait === undefined ||
          this.closed
        ) {
          throw err
        }
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new JsonRpcPeerError('closed', method, `cannot notify ${method}: peer closed`)
    await this.transport.writeLine(this.frame({ method, ...(params === undefined ? {} : { params }) }))
  }

  /** Reject everything pending and stop accepting work (the transport is closed if it supports it). */
  close(): void {
    this.transport.close?.()
    this.shutdown()
  }

  private frame(body: Record<string, unknown>): Record<string, unknown> {
    return this.opts.header === '2.0' ? { jsonrpc: '2.0', ...body } : body
  }

  private requestOnce(method: string, params: unknown, timeoutMs: number | undefined): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new JsonRpcPeerError('closed', method, `cannot call ${method}: peer closed`))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: undefined }
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          this.timedOut.add(id)
          if (this.timedOut.size > TIMED_OUT_IDS_MAX) {
            const oldest = this.timedOut.values().next().value
            if (oldest !== undefined) this.timedOut.delete(oldest)
          }
          reject(new JsonRpcPeerError('timeout', method, `${method} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      const body: Record<string, unknown> = { id, method }
      if (params !== undefined) body['params'] = params
      this.transport.writeLine(this.frame(body)).then(
        (ok) => {
          if (!ok && this.pending.delete(id)) {
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            reject(new JsonRpcPeerError('closed', method, `cannot call ${method}: stdin closed`))
          }
        },
        (err: unknown) => {
          if (this.pending.delete(id)) {
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        },
      )
    })
  }

  private emitError(e: RpcStreamError): void {
    for (const l of [...this.errorListeners]) l(e)
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const rec of this.transport.records) {
        if (rec.kind === 'oversize') {
          this.emitError({
            category: 'stream_malformed',
            reason: 'oversize',
            message: `dropped a ${rec.bytes}-byte line over the size limit`,
            lines: [rec.head],
          })
          continue
        }
        this.handleLine(rec.line)
      }
    } finally {
      this.shutdown()
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      msg = undefined
    }
    if (!isObj(msg)) {
      this.malformed.push(line)
      if (this.malformed.length === MALFORMED_THRESHOLD) {
        this.emitError({
          category: 'stream_malformed',
          reason: 'malformed',
          message: `${MALFORMED_THRESHOLD} consecutive unparseable lines`,
          lines: [...this.malformed],
        })
      }
      return
    }
    this.malformed = []
    const method = msg['method']
    const id = msg['id']
    const hasId = typeof id === 'number' || typeof id === 'string'
    if (typeof method === 'string') {
      if (hasId) void this.handleRequest(id, method, msg['params'])
      else this.handleNotification(method, msg['params'])
      return
    }
    if (hasId && ('result' in msg || 'error' in msg)) {
      this.handleResponse(id, msg, line)
      return
    }
    this.emitError({
      category: 'stream_malformed',
      reason: 'malformed',
      message: 'frame is neither a request, a notification nor a response',
      lines: [line],
    })
  }

  private handleResponse(id: RpcId, msg: Record<string, unknown>, line: string): void {
    const key = typeof id === 'string' && /^\d+$/.test(id) && !this.pending.has(id) ? Number(id) : id
    const entry = this.pending.get(key)
    if (entry === undefined) {
      if (this.timedOut.delete(key)) return
      this.emitError({
        category: 'stream_malformed',
        reason: 'unknown-response-id',
        message: `response for unknown request id ${JSON.stringify(id)}`,
        lines: [line],
      })
      return
    }
    this.pending.delete(key)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const error = msg['error']
    if (error !== undefined && error !== null) {
      const e = isObj(error) ? error : {}
      const code = typeof e['code'] === 'number' ? e['code'] : INTERNAL_ERROR
      const message = typeof e['message'] === 'string' ? e['message'] : 'error'
      entry.reject(new JsonRpcError(code, message, e['data'], entry.method))
      return
    }
    entry.resolve(msg['result'])
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method)
    let reply: Record<string, unknown>
    if (handler === undefined) {
      reply = { id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } }
    } else {
      try {
        const result: unknown = await handler(params, { id, method })
        reply = { id, result: result === undefined ? null : result }
      } catch (err) {
        reply = { id, error: toErrorObject(err) }
      }
    }
    if (!this.closed) await this.transport.writeLine(this.frame(reply)).catch(() => false)
  }

  private handleNotification(method: string, params: unknown): void {
    for (const key of [method, '*']) {
      for (const h of [...(this.notificationHandlers.get(key) ?? [])]) {
        try {
          h(params, method)
        } catch {
          // a listener failure must not break the read loop
        }
      }
    }
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(
        new JsonRpcPeerError('closed', entry.method, `${entry.method}: peer closed before replying`),
      )
      this.pending.delete(id)
    }
    for (const l of [...this.closeListeners]) l()
  }
}
