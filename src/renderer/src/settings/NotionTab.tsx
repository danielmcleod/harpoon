// Notion: the page Harpoon publishes to, the Notion MCP server your CLI uses (for AI publishing), whether meeting
// notes go too, an optional integration token (to attach the share bundle file), and the publish log.
import { ExternalLink, FileUp, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PublishSettings } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'
import { ask, setVendor } from '../state/ai.ts'
import { setUi } from '../state/store.ts'
import { currentExportView } from '../panels/ExportMenu.tsx'

export async function publishWithAi(): Promise<void> {
  const r = await invoke('publish.get')
  if (!r.ok) return toast(r.error.message, 'error')
  const n = r.value.notion
  if (n.pageUrl === '' || n.server === null) {
    openSettingsNotion()
    return toast('Set the Notion page and server first.', 'info')
  }
  const ok = window.confirm(
    `Publish to ${n.pageUrl}\nthrough "${n.server}" with Claude Code?\n\nIt writes the architecture, roadmap and decision log${n.includeNotes ? ', and meeting notes,' : ''} to that page and its subpages. Working notes stay out${n.includeNotes ? ' unless included' : ''}.

It runs your own Claude Code on this computer, with your account and its Notion connection; usage counts against your plan.`,
  )
  if (!ok) return
  setUi({ settings: null, aiOpen: true })
  setVendor('claude')
  await ask('', { mode: 'publish' })
}

const openSettingsNotion = (): void => setUi({ settings: 'notion' })

export async function attachBundleToNotion(): Promise<void> {
  toast('Uploading the share bundle to Notion…')
  const r = await invoke('notion.attachBundle', { view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  toast(`Attached ${r.value.filename} to the Notion page.`)
}

export function NotionTab({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [pub, setPub] = useState<PublishSettings | null>(null)
  const [servers, setServers] = useState<{ claude: string[]; codex: string[] }>({ claude: [], codex: [] })
  const [token, setToken] = useState({ hasToken: false, canEncrypt: true })
  const [draftToken, setDraftToken] = useState('')

  useEffect(() => {
    void invoke('publish.get').then((r) => r.ok && setPub(r.value))
    void invoke('notion.servers').then((r) => r.ok && setServers(r.value))
    void invoke('notion.tokenStatus').then((r) => r.ok && setToken(r.value))
  }, [])
  if (pub === null) return <p className="text-xs text-muted-foreground">Loading…</p>
  const n = pub.notion
  const save = (p: Partial<PublishSettings['notion']>): void => {
    const next = { notion: { ...n, ...p } }
    setPub(next)
    void invoke('publish.set', next).then((r) => !r.ok && toast(r.error.message, 'error'))
  }
  const suggestions = [...new Set([...servers.claude, ...servers.codex])]

  return (
    <div className="flex max-w-2xl flex-col gap-5 text-xs">
      <p className="text-muted-foreground">
        Share the architecture, roadmap and decision log with your team in Notion. Without any setup, <strong>Share → Notion import (.zip)</strong> makes pages you import into Notion. With the
        settings below, the AI keeps a Notion page up to date for you, and Harpoon can attach the full share bundle to it.
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Notion page</h3>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">The page Harpoon writes under (copy its link in Notion)</span>
          <input
            value={n.pageUrl}
            readOnly={readOnly}
            onChange={(e) => save({ pageUrl: e.target.value.trim() })}
            placeholder="https://www.notion.so/acme/Architecture-1234567890abcdef1234567890abcdef"
            className="h-8 rounded-md border bg-background px-2 font-mono text-[11px] outline-none focus:border-ring"
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={readOnly} checked={n.includeNotes} onChange={(e) => save({ includeNotes: e.target.checked })} />
          Publish meeting notes too (they capture people’s words; off by default)
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Publish with AI</h3>
        <p className="text-muted-foreground">
          The AI writes the pages through the Notion MCP server you already use with Claude Code or Codex (add Notion as an MCP server or connector there first). It updates its own section and pages
          in place and never touches the rest of the page.
        </p>
        <p className="text-muted-foreground">
          Publishing runs your own Claude Code on this computer, signed in to your account; the usage counts against your own plan. Harpoon has no AI
          service or Notion access of its own.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Notion MCP server name, as your CLI shows it (claude mcp list). Saved on this computer only; publishing runs with Claude Code.</span>
          <input
            list="hx-notion-servers"
            value={n.server ?? ''}
            readOnly={readOnly}
            onChange={(e) => save({ server: e.target.value.trim() === '' ? null : e.target.value.trim() })}
            placeholder="claude.ai Notion"
            className="h-8 w-80 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring"
          />
          <datalist id="hx-notion-servers">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <div>
          <Button size="sm" icon={<Send />} disabled={readOnly || n.pageUrl === '' || n.server === null} onClick={() => void publishWithAi()}>
            Publish now
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Attach the share bundle (optional)</h3>
        <p className="text-muted-foreground">
          The Notion MCP server cannot upload files. To attach the full bundle (viewer, docs, diagram code, project) to the page, create a Notion internal integration, share the page with it
          (page ⋯ → Connections), and paste its token here. It is stored encrypted on this machine only, never in the project.
        </p>
        <div className="flex items-center gap-2">
          {token.hasToken ? (
            <>
              <span className="rounded bg-success/15 px-1.5 py-0.5 text-success">Token saved</span>
              <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => void invoke('notion.setToken', { token: null }).then((r) => r.ok && setToken((t) => ({ ...t, hasToken: false })))}>
                Remove
              </Button>
            </>
          ) : (
            <>
              <input
                type="password"
                autoComplete="off"
                value={draftToken}
                disabled={readOnly || !token.canEncrypt}
                onChange={(e) => setDraftToken(e.target.value)}
                placeholder={token.canEncrypt ? 'ntn_… or secret_…' : 'No secure storage on this system'}
                aria-label="Notion integration token"
                className="h-8 w-72 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || draftToken.trim().length < 10}
                onClick={() =>
                  void invoke('notion.setToken', { token: draftToken.trim() }).then((r) => {
                    if (!r.ok) return toast(r.error.message, 'error')
                    setDraftToken('')
                    setToken((t) => ({ ...t, hasToken: true }))
                  })
                }
              >
                Save token
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" icon={<FileUp />} disabled={readOnly || !token.hasToken || n.pageUrl === ''} onClick={() => void attachBundleToNotion()}>
            Attach bundle now
          </Button>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-sm font-semibold">Publish log</h3>
        {n.log.length === 0 && <p className="text-muted-foreground">Nothing published yet.</p>}
        <ul className="flex flex-col gap-1.5">
          {n.log.slice(0, 20).map((l, i) => (
            <li key={i} className="rounded-md border p-2">
              <div className="mb-0.5 text-[10.5px] text-muted-foreground">
                {new Date(l.at).toLocaleString()} · {l.by === 'ai' ? 'AI publish' : l.by === 'api' ? 'bundle attached' : 'import'}
              </div>
              <div className="whitespace-pre-wrap">{l.summary}</div>
            </li>
          ))}
        </ul>
        {n.pageUrl.startsWith('https://') && (
          <a href={n.pageUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-primary hover:underline">
            Open the Notion page <ExternalLink className="size-3" />
          </a>
        )}
      </section>
    </div>
  )
}
