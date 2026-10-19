// Settings → AI (this computer, every project): the CLIs Harpoon found and the models they list, the model and effort
// each one starts with, and access for outside agents to Harpoon's MCP tools.
import { CheckCircle2, CircleAlert, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AiDefaults, AiVendor, ExternalMcpView, ProviderView } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { Switch } from '../components/ui/Switch.tsx'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'
import { loadProviders } from '../state/ai.ts'
import { getState, setAi, setState, useStore } from '../state/store.ts'
import { AiNote } from '../ai/AiNote.tsx'
import { ModelPicker } from '../ai/ModelPicker.tsx'
import type { ModelPick } from '../ai/ModelPicker.tsx'

export function AiTab(): React.JSX.Element {
  const providers = useStore((s) => s.ai.providers)
  const defaults = useStore((s) => s.prefs.ai)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (providers === null) void loadProviders()
  }, [providers])

  const save = async (next: AiDefaults): Promise<void> => {
    const r = await invoke('state.set', { ai: next })
    if (!r.ok) return toast(r.error.message, 'error')
    setState({ prefs: r.value })
  }
  const setPick = (vendor: AiVendor, pick: ModelPick): void => {
    void save({ ...defaults, [vendor]: pick })
    // The panel follows when it is on that CLI.
    if (getState().ai.vendor === vendor) setAi(pick)
  }

  return (
    <div className="flex flex-col gap-6 text-xs">
      <AiNote />

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-sm font-semibold">Models</h3>
          <Button
            size="sm"
            variant="outline"
            icon={<RefreshCw className={checking ? 'animate-spin' : undefined} />}
            disabled={checking}
            onClick={() => {
              setChecking(true)
              void loadProviders(true).finally(() => setChecking(false))
            }}
          >
            Check again
          </Button>
        </div>
        <p className="text-muted-foreground">
          Saved on this computer for every project; the AI panel starts from these and can change them per conversation. A model your CLI does not list
          yet: update the CLI and check again, or pick “Other model id…” and type it.
        </p>
        <label className="flex items-center gap-2">
          <span className="w-28 text-muted-foreground">Start with</span>
          <select
            value={defaults.vendor ?? ''}
            onChange={(e) => void save({ ...defaults, vendor: e.target.value === '' ? null : (e.target.value as AiVendor) })}
            className="h-7 rounded-md border bg-background px-1.5"
          >
            <option value="">The first one that works</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        {(providers ?? []).map((p) => (
          <ProviderRow key={p.id} provider={p} pick={defaults[p.id]} onPick={(v) => setPick(p.id, v)} />
        ))}
        {providers === null && <p className="text-muted-foreground">Checking your CLIs…</p>}
      </section>

      <OutsideAgents />
    </div>
  )
}

function ProviderRow({ provider: p, pick, onPick }: { provider: ProviderView; pick: ModelPick; onPick: (v: ModelPick) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        {p.ok ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
        <span className="text-sm font-medium">{p.name}</span>
        <span className="text-muted-foreground">{[p.version !== null ? `v${p.version}` : null, p.account].filter((x) => x !== null).join(' · ')}</span>
      </div>
      {!p.ok && <p className="text-warning">{p.issue ?? 'Not available.'} Install it and sign in from a terminal, then check again.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-muted-foreground">Default model</span>
        <ModelPicker provider={p} value={pick} onChange={onPick} />
      </div>
      {p.ok && <p className="text-muted-foreground">{p.models.length === 0 ? 'The CLI listed no models; type a model id or use its default.' : `${p.models.length} models listed by this CLI.`}</p>}
    </div>
  )
}

function OutsideAgents(): React.JSX.Element {
  const [view, setView] = useState<ExternalMcpView | null>(null)
  const [show, setShow] = useState(false)
  const [port, setPort] = useState('')

  useEffect(() => {
    void invoke('mcp.external.get').then((r) => {
      if (r.ok) {
        setView(r.value)
        setPort(String(r.value.port))
      }
    })
  }, [])

  const set = async (req: { enabled?: boolean; port?: number; regenerate?: boolean }): Promise<void> => {
    const r = await invoke('mcp.external.set', req)
    if (!r.ok) return toast(r.error.message, 'error')
    setView(r.value)
    setPort(String(r.value.port))
  }
  if (view === null) return <section />

  const url = view.url ?? `http://127.0.0.1:${view.port}/mcp/harpoon`
  const token = view.token ?? '<token>'
  const shown = show ? token : '•'.repeat(24)
  const snippets: { title: string; text: string }[] = [
    { title: 'Claude Code', text: `claude mcp add --transport http harpoon ${url} --header "Authorization: Bearer ${token}"` },
    { title: 'Codex (~/.codex/config.toml; set HARPOON_MCP_TOKEN to the token)', text: `[mcp_servers.harpoon]\nurl = "${url}"\nbearer_token_env_var = "HARPOON_MCP_TOKEN"` },
    { title: 'Other MCP clients (JSON)', text: JSON.stringify({ mcpServers: { harpoon: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
  ]
  const portNum = Number(port)
  const portOk = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">Outside agents</h3>
        <Switch checked={view.enabled} onCheckedChange={(on) => void set({ enabled: on })} aria-label="Let outside agents connect" />
      </div>
      <p className="text-muted-foreground">
        Let an agent you run yourself (Claude Code, Codex, or any MCP client) use Harpoon&apos;s tools on the project open here: read the architecture, and stage changes
        that arrive in the AI panel as a proposal to review. It listens on this computer only and needs the token. Anyone with the token who can run programs on this
        computer can use it, so treat it like a password.
      </p>
      {view.enabled && (
        <>
          {view.error !== null && <p className="text-warning">{view.error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-muted-foreground">Status</span>
            <span>{view.running ? `Listening${view.lastCall !== null ? `; last call ${new Date(view.lastCall).toLocaleTimeString()}` : '; no agent has called yet'}` : 'Not listening'}</span>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (portOk) void set({ port: portNum })
            }}
          >
            <span className="w-28 text-muted-foreground">Port</span>
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" aria-label="Port" className="h-7 w-24 rounded-md border bg-background px-2 font-mono" />
            <Button size="sm" variant="outline" type="submit" disabled={!portOk || portNum === view.port}>
              Change
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-muted-foreground">Token</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{shown}</code>
            <Button size="icon" variant="ghost" className="size-7" aria-label={show ? 'Hide token' : 'Show token'} onClick={() => setShow((x) => !x)}>
              {show ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (window.confirm('Issue a new token? Agents set up with the old one stop working until you update them.')) void set({ regenerate: true })
              }}
            >
              New token
            </Button>
          </div>
          {snippets.map((sn) => (
            <div key={sn.title} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{sn.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy />}
                  onClick={() => void navigator.clipboard.writeText(sn.text).then(() => toast('Copied (it includes the token)', 'info'))}
                >
                  Copy
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">{show ? sn.text : sn.text.replaceAll(token, '<token>')}</pre>
            </div>
          ))}
        </>
      )}
    </section>
  )
}
