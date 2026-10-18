// The note editor: CodeMirror with Markdown, history and line wrapping. Typing @ offers services, connectors and
// decisions; picking one inserts a mention link (`[@Payments](harpoon:node/payments)`) the preview makes clickable.
import { autocompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'

export interface MentionTarget {
  kind: 'node' | 'connector' | 'decision' | 'set'
  id: string
  label: string
  detail: string
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-content': { fontFamily: 'inherit', padding: '12px 4px', caretColor: 'var(--foreground)' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.6', fontFamily: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklab, var(--primary) 25%, transparent) !important' },
  '.cm-tooltip.cm-tooltip-autocomplete': { border: '1px solid var(--border)', backgroundColor: 'var(--popover)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px !important', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent) !important', color: 'var(--foreground) !important' },
  '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
})

export function NoteEditor({ value, onChange, mentions, readOnly }: { value: string; onChange: (v: string) => void; mentions: () => MentionTarget[]; readOnly: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, mentions })
  latest.current = { onChange, mentions }

  useEffect(() => {
    if (host.current === null) return
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/@[\w .-]{0,40}/)
      if (word === null || (word.from === word.to && !ctx.explicit)) return null
      return {
        from: word.from,
        options: latest.current.mentions().map((t) => ({
          label: `@${t.label}`,
          detail: t.detail,
          apply: `[@${t.label}](harpoon:${t.kind}/${t.id})`,
        })),
        validFor: /^@[\w .-]*$/,
      }
    }
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          autocompletion({ override: [complete], icons: false }),
          placeholder('Write notes in Markdown. @ mentions a service or decision; - [ ] adds a task.'),
          EditorState.readOnly.of(readOnly),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // The editor is created once per note (the parent keys it by path); later values come from typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  // An outside change (the AI, another window) replaces the text when it differs.
  useEffect(() => {
    const v = view.current
    if (v === null) return
    const cur = v.state.doc.toString()
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  return <div ref={host} className="h-full min-h-0" />
}
