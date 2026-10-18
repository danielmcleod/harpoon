// NDJSON line splitting over raw byte chunks. Splits on LF bytes, which never occur inside a
// multi-byte UTF-8 sequence, so a code point split across chunks is decoded only once its line is complete.

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024
const OVERSIZE_HEAD_BYTES = 256

export type LineRecord =
  | { kind: 'line'; line: string }
  /** A line longer than maxLineBytes: dropped (never parsed, never counted as malformed); `head` is its start. */
  | { kind: 'oversize'; bytes: number; head: string }

const LF = 0x0a
const CR = 0x0d

function decode(buf: Buffer): string {
  const end = buf.length > 0 && buf[buf.length - 1] === CR ? buf.length - 1 : buf.length
  return buf.toString('utf8', 0, end)
}

export class LineSplitter {
  private parts: Buffer[] = []
  private size = 0
  /** Bytes of the current line seen so far once it went over the limit (its content is discarded). */
  private overflow = 0
  private head: Buffer | null = null
  private readonly maxLineBytes: number

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes
  }

  push(chunk: Buffer | string): LineRecord[] {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const out: LineRecord[] = []
    let start = 0
    while (start < buf.length) {
      const nl = buf.indexOf(LF, start)
      const end = nl === -1 ? buf.length : nl
      this.append(buf.subarray(start, end))
      if (nl === -1) break
      out.push(this.take())
      start = nl + 1
    }
    return out
  }

  /** Flush a trailing partial line (a process may exit without a final newline). */
  end(): LineRecord[] {
    if (this.size === 0 && this.overflow === 0) return []
    return [this.take()]
  }

  private append(piece: Buffer): void {
    if (piece.length === 0) return
    if (this.overflow > 0) {
      this.overflow += piece.length
      const head = this.head ?? Buffer.alloc(0)
      if (head.length < OVERSIZE_HEAD_BYTES) {
        this.head = Buffer.concat([head, piece.subarray(0, OVERSIZE_HEAD_BYTES - head.length)])
      }
      return
    }
    if (this.size + piece.length > this.maxLineBytes) {
      const joined = Buffer.concat([...this.parts, piece])
      this.head = joined.subarray(0, OVERSIZE_HEAD_BYTES)
      this.overflow = joined.length
      this.parts = []
      this.size = 0
      return
    }
    this.parts.push(piece)
    this.size += piece.length
  }

  private take(): LineRecord {
    if (this.overflow > 0) {
      const rec: LineRecord = {
        kind: 'oversize',
        bytes: this.overflow,
        head: (this.head ?? Buffer.alloc(0)).toString('utf8'),
      }
      this.overflow = 0
      this.head = null
      return rec
    }
    const buf = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.size)
    this.parts = []
    this.size = 0
    return { kind: 'line', line: decode(buf) }
  }
}

/** Split any byte/string stream into line records. */
export async function* splitLines(
  source: AsyncIterable<Buffer | string>,
  maxLineBytes: number = DEFAULT_MAX_LINE_BYTES,
): AsyncGenerator<LineRecord> {
  const splitter = new LineSplitter(maxLineBytes)
  for await (const chunk of source) yield* splitter.push(chunk)
  yield* splitter.end()
}
