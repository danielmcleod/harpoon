// A small markdown subset for AI replies and notes: paragraphs, bullet lists, task lists, headings, `code`, **bold**,
// links and fenced code. Links to `harpoon:<kind>/<id>` (mentions) and task boxes call back into the app.
import { Fragment } from 'react'

export interface MarkdownHandlers {
  /** A `harpoon:` mention was clicked. */
  onMention?: (kind: string, id: string) => void
  /** A task box was ticked (its line number in the source text). */
  onToggleTask?: (line: number, done: boolean) => void
}

function inline(text: string, h: MarkdownHandlers): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={i++} className="rounded bg-muted px-1 font-mono text-[11px]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
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

export function Markdown({ text, ...h }: { text: string } & MarkdownHandlers): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) code.push(lines[i++] ?? '')
      i++
      blocks.push(<pre key={key++} className="my-1.5 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">{code.join('\n')}</pre>)
      continue
    }
    if (/^\s*[-*] /.test(line)) {
      const items: { text: string; line: number }[] = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i] ?? '')) {
        items.push({ text: (lines[i] ?? '').replace(/^\s*[-*] /, ''), line: i })
        i++
      }
      const tasky = items.some((t) => /^\[( |x|X)\] /.test(t.text))
      blocks.push(
        <ul key={key++} className={tasky ? 'my-1 pl-0.5' : 'my-1 list-disc pl-4'}>
          {items.map((t) => {
            const task = /^\[( |x|X)\] (.*)$/.exec(t.text)
            if (task === null) return <li key={t.line} className={tasky ? 'ml-5 list-disc' : undefined}>{inline(t.text, h)}</li>
            const done = task[1] !== ' '
            return (
              <li key={t.line} className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  aria-label="Done"
                  checked={done}
                  disabled={h.onToggleTask === undefined}
                  onChange={(e) => h.onToggleTask?.(t.line, e.target.checked)}
                  className="mt-[3px]"
                />
                <span className={done ? 'text-muted-foreground line-through' : undefined}>{inline(task[2] ?? '', h)}</span>
              </li>
            )
          })}
        </ul>,
      )
      continue
    }
    if (/^#{1,4} /.test(line)) {
      blocks.push(<p key={key++} className="mt-2 font-semibold">{inline(line.replace(/^#+ /, ''), h)}</p>)
      i++
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^\s*[-*] |^```|^#{1,4} /.test(lines[i] ?? '')) para.push(lines[i++] ?? '')
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
  return <div className="text-[12.5px] leading-relaxed selectable">{blocks}</div>
}
