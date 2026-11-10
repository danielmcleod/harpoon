// A small markdown subset for AI replies and notes: paragraphs, bullet, numbered and task lists (nested by
// indentation), headings, tables, block quotes, rules, `code`, **bold**, *italics*, links and fenced code. Links to
// `harpoon:<kind>/<id>` (mentions) and task boxes call back into the app. Everything becomes React nodes (never
// HTML), and only https links are followed.
import { Fragment, memo } from 'react'

export interface MarkdownHandlers {
  /** A `harpoon:` mention was clicked. */
  onMention?: (kind: string, id: string) => void
  /** A task box was ticked (its line number in the source text). */
  onToggleTask?: (line: number, done: boolean) => void
}

// `_italics_` only between non-word characters, so snake_case names stay as they are.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\w_])_[^_\s](?:[^_]*[^_\s])?_(?![\w_]))/g

function inline(text: string, h: MarkdownHandlers): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = new RegExp(INLINE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={i++} className="rounded bg-muted px-1 font-mono text-[11px]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={i++}>{inline(tok.slice(2, -2), h)}</strong>)
    else if (tok.startsWith('*') || tok.startsWith('_')) out.push(<em key={i++}>{inline(tok.slice(1, -1), h)}</em>)
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
      const label = lm?.[1] ?? tok
      const href = lm?.[2] ?? ''
      const mention = /^harpoon:([a-z]+)\/(.+)$/.exec(href)
      if (mention !== null) {
        out.push(
          <button key={i++} type="button" onClick={() => h.onMention?.(mention[1] ?? '', mention[2] ?? '')} className="rounded bg-primary/12 px-1 font-medium text-primary hover:bg-primary/20">
            {label}
          </button>,
        )
      } else if (/^https:\/\//.test(href)) {
        out.push(
          <a key={i++} href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline">
            {label}
          </a>,
        )
      } else out.push(label)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LIST = /^(\s*)(?:[-*+]|(\d{1,9})[.)]) (.*)$/
const QUOTE = /^\s{0,3}> ?/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const HEADING = /^#{1,6} /
const FENCE = /^\s*```/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (s: string): number => s.replace(/\t/g, '  ').length

/** A table starts where a row with a `|` is followed by its `|---|---|` rule. */
const tableAt = (lines: readonly string[], i: number): boolean => {
  const head = lines[i] ?? ''
  const rule = lines[i + 1] ?? ''
  return head.includes('|') && rule.includes('-') && rule.includes('|') && TABLE_RULE.test(rule)
}

/** A table row's cells (`\|` is a literal bar). */
function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

interface Item {
  indent: number
  ordered: boolean
  /** The number an ordered item was written with. */
  n: number
  text: string
  /** Its line in the source text (task boxes report it). */
  line: number
  kids: Item[]
}

/** Items nest under the last item that is indented less. */
function nest(flat: Item[]): Item[] {
  const roots: Item[] = []
  const path: Item[] = []
  for (const it of flat) {
    while (path.length > 0 && (path.at(-1)?.indent ?? 0) >= it.indent) path.pop()
    const parent = path.at(-1)
    if (parent === undefined) roots.push(it)
    else parent.kids.push(it)
    path.push(it)
  }
  return roots
}

function list(items: Item[], h: MarkdownHandlers, key: number | string): React.ReactNode {
  const first = items[0]
  if (first === undefined) return null
  const tasky = items.some((t) => /^\[( |x|X)\] /.test(t.text))
  const numbered = first.ordered && !tasky
  const row = (t: Item): React.ReactNode => {
    const task = /^\[( |x|X)\] (.*)$/.exec(t.text)
    const kids = t.kids.length > 0 ? list(t.kids, h, 'kids') : null
    if (task === null) {
      return (
        <li key={t.line} className={tasky ? 'ml-5 list-disc' : undefined} {...(numbered ? { value: t.n } : {})}>
          {inline(t.text, h)}
          {kids}
        </li>
      )
    }
    const done = task[1] !== ' '
    return (
      <li key={t.line}>
        <div className="flex items-start gap-1.5">
          <input
            type="checkbox"
            aria-label="Done"
            checked={done}
            disabled={h.onToggleTask === undefined}
            onChange={(e) => h.onToggleTask?.(t.line, e.target.checked)}
            className="mt-[3px]"
          />
          <span className={done ? 'text-muted-foreground line-through' : undefined}>{inline(task[2] ?? '', h)}</span>
        </div>
        {kids !== null && <div className="pl-5">{kids}</div>}
      </li>
    )
  }
  if (numbered) {
    return (
      <ol key={key} className="my-1 list-decimal pl-5">
        {items.map(row)}
      </ol>
    )
  }
  return (
    <ul key={key} className={tasky ? 'my-1 pl-0.5' : 'my-1 list-disc pl-4'}>
      {items.map(row)}
    </ul>
  )
}

/** Blocks of `lines`; `offset` is where they start in the source text (a quote's lines are blocks of their own). */
function blocksOf(lines: readonly string[], offset: number, h: MarkdownHandlers): React.ReactNode[] {
  const blocks: React.ReactNode[] = []
  const at = (i: number): string => lines[i] ?? ''
  /** What ends a paragraph: a blank line or the start of another block (a numbered list only from `1.`). */
  const breaks = (i: number): boolean => {
    const l = at(i)
    if (l.trim() === '' || FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || RULE.test(l) || tableAt(lines, i)) return true
    const li = LIST.exec(l)
    return li !== null && (li[2] === undefined || li[2] === '1')
  }
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = at(i)
    if (FENCE.test(line)) {
      // A fence under a list item is indented: its code loses that indent.
      const pad = line.length - line.trimStart().length
      const code: string[] = []
      i++
      while (i < lines.length && !FENCE.test(at(i))) {
        const l = at(i++)
        code.push(l.slice(Math.min(pad, l.length - l.trimStart().length)))
      }
      i++
      blocks.push(<pre key={key++} className="my-1.5 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">{code.join('\n')}</pre>)
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-border" />)
      i++
      continue
    }
    if (HEADING.test(line)) {
      blocks.push(<p key={key++} className="mt-2 font-semibold">{inline(line.replace(/^#+ /, ''), h)}</p>)
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const start = i
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(at(i))) inner.push(at(i++).replace(QUOTE, ''))
      blocks.push(
        <blockquote key={key++} className="my-1.5 border-l-2 border-border pl-2.5 text-muted-foreground">
          {blocksOf(inner, offset + start, h)}
        </blockquote>,
      )
      continue
    }
    if (tableAt(lines, i)) {
      const head = cells(line)
      const align = cells(at(i + 1)).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'text-center' : 'text-right') : 'text-left'))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && at(i).includes('|') && at(i).trim() !== '') rows.push(cells(at(i++)))
      blocks.push(
        <div key={key++} className="my-1.5 overflow-x-auto">
          <table className="border-collapse text-[11.5px]">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className={`border-b px-2 py-1 font-semibold ${align[j] ?? 'text-left'}`}>
                    {inline(c, h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  {head.map((_, j) => (
                    <td key={j} className={`border-b border-border/60 px-2 py-1 align-top ${align[j] ?? 'text-left'}`}>
                      {inline(r[j] ?? '', h)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (LIST.test(line)) {
      const flat: Item[] = []
      while (i < lines.length) {
        const li = LIST.exec(at(i))
        if (li !== null) flat.push({ indent: indentOf(li[1] ?? ''), ordered: li[2] !== undefined, n: Number(li[2] ?? 1), text: li[3] ?? '', line: offset + i, kids: [] })
        // An indented line under an item carries on its text.
        else if (/^\s{2,}\S/.test(at(i)) && !FENCE.test(at(i))) (flat.at(-1) as Item).text += ` ${at(i).trim()}`
        else break
        i++
      }
      blocks.push(list(nest(flat), h, key++))
      continue
    }
    const para: string[] = [lines[i++] ?? '']
    while (i < lines.length && !breaks(i)) para.push(lines[i++] ?? '')
    blocks.push(
      <p key={key++} className="my-1">
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, h)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return blocks
}

function MarkdownImpl({ text, ...h }: { text: string } & MarkdownHandlers): React.JSX.Element {
  return <div className="text-[12.5px] leading-relaxed selectable">{blocksOf(text.replace(/\r\n/g, '\n').split('\n'), 0, h)}</div>
}

/** Memoized: a streaming answer re-renders its conversation on every chunk, and only the last turn's text changed. */
export const Markdown = memo(MarkdownImpl)
