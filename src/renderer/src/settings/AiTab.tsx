// Settings → AI (this computer, every project): the CLIs Harpoon found and the models they list, the model and effort
// each one starts with, and access for outside agents to Harpoon's MCP tools.
import { CheckCircle2, CircleAlert, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AiDefaults, AiVendor, CodexPluginResult, ExternalMcpView, GitPolicy, ImplementSettings, ProviderView } from '@shared/ipc.ts'
import type { Approvals } from '@shared/run.ts'
import { APPROVAL_INFO, GIT_INFO } from '../ai/ImplementDialog.tsx'
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

      <Implementing />

      <OutsideAgents />
    </div>
  )
}

/** How "Implement this plan" starts on this computer (the dialog can change it per run). */
function Implementing(): React.JSX.Element {
  const cur = useStore((s) => s.prefs.implement)
  const [template, setTemplate] = useState(cur.branchTemplate)
  const [plansDir, setPlansDir] = useState(cur.plansDir)
  useEffect(() => {
    setTemplate(cur.branchTemplate)
    setPlansDir(cur.plansDir)
  }, [cur.branchTemplate, cur.plansDir])
  const save = async (p: Partial<ImplementSettings>): Promise<void> => {
    const r = await invoke('state.set', { implement: { ...cur, ...p } })
    if (!r.ok) return toast(r.error.message, 'error')
    setState({ prefs: r.value })
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Implementing</h3>
      <p className="text-muted-foreground">
        “Implement this plan” has your CLI edit the code. These are the defaults on this computer; the Implement dialog can change them for one run.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-28 text-muted-foreground">Before it acts</span>
        <select value={cur.approvals} onChange={(e) => void save({ approvals: e.target.value as Approvals })} className="h-7 rounded-md border bg-background px-1.5">
          {(Object.keys(APPROVAL_INFO) as Approvals[]).map((a) => (
            <option key={a} value={a}>
              {APPROVAL_INFO[a].label}
            </option>
          ))}
        </select>
        <span className="min-w-0 flex-1 text-muted-foreground">{APPROVAL_INFO[cur.approvals].hint}</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-muted-foreground">Git</span>
        <select value={cur.git} onChange={(e) => void save({ git: e.target.value as GitPolicy })} className="h-7 rounded-md border bg-background px-1.5">
          {(Object.keys(GIT_INFO) as GitPolicy[]).map((g) => (
            <option key={g} value={g}>
              {GIT_INFO[g].label}
            </option>
          ))}
        </select>
      </label>
      <p className="pl-30 text-muted-foreground">{GIT_INFO[cur.git].hint}</p>
      <label className="flex items-center gap-2">
        <span className="w-28 text-muted-foreground">Branch template</span>
        <input
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          onBlur={() => template.trim() !== '' && template !== cur.branchTemplate && void save({ branchTemplate: template.trim() })}
          className="h-7 w-56 rounded-md border bg-background px-1.5 font-mono"
        />
        <span className="text-muted-foreground">{'{slug}'} is the plan’s name, {'{date}'} today’s date.</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-muted-foreground">Plans folder</span>
        <input
          value={plansDir}
          onChange={(e) => setPlansDir(e.target.value)}
          onBlur={() => plansDir.trim() !== '' && plansDir !== cur.plansDir && void save({ plansDir: plansDir.trim() })}
          className="h-7 w-56 rounded-md border bg-background px-1.5 font-mono"
        />
        <span className="text-muted-foreground">Inside the project (default .harpoon/plans), or an absolute folder.</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-28 text-muted-foreground">Approval wait</span>
        <select value={cur.askTimeoutMin} onChange={(e) => void save({ askTimeoutMin: Number(e.target.value) })} className="h-7 rounded-md border bg-background px-1.5">
          {[5, 15, 30, 60, 120].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">An unanswered request is declined after this.</span>
      </label>
    </section>
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
  const b = view.bridge
  const quote = (x: string): string => (/[\s"]/.test(x) ? JSON.stringify(x) : x)
  const bridgeLine = b === null ? null : [b.command, ...b.args].map(quote).join(' ')
  // Clients that run a command use the bridge (no token in their configuration); the rest connect over HTTP.
  const snippets: { title: string; text: string }[] = [
    ...(b !== null && bridgeLine !== null
      ? [
          { title: 'Claude Code', text: `claude mcp add --scope user harpoon -- ${bridgeLine}` },
          { title: 'Claude Desktop, Windsurf and other MCP clients (JSON, runs Harpoon --mcp)', text: JSON.stringify({ mcpServers: { harpoon: { command: b.command, args: b.args } } }, null, 2) },
          { title: 'VS Code (.vscode/mcp.json)', text: JSON.stringify({ servers: { harpoon: { type: 'stdio', command: b.command, args: b.args } } }, null, 2) },
        ]
      : []),
    { title: 'Over HTTP: Claude Code', text: `claude mcp add --transport http harpoon ${url} --header "Authorization: Bearer ${token}"` },
    { title: 'Over HTTP: Codex config.toml (set HARPOON_MCP_TOKEN to the token)', text: `[mcp_servers.harpoon]\nurl = "${url}"\nbearer_token_env_var = "HARPOON_MCP_TOKEN"` },
    { title: 'Over HTTP: other clients (JSON)', text: JSON.stringify({ mcpServers: { harpoon: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
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
          <ConnectApps hasBridge={b !== null} />
          {snippets.map((sn) => (
            <div key={sn.title} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{sn.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy />}
                  onClick={() => void navigator.clipboard.writeText(sn.text).then(() => toast(sn.text.includes(token) ? 'Copied (it includes the token)' : 'Copied', 'info'))}
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

/** One-click setup for the apps that support it: Codex (CLI, desktop app and IDE extension), VS Code, Cursor. */
function ConnectApps({ hasBridge }: { hasBridge: boolean }): React.JSX.Element | null {
  const [codex, setCodex] = useState<CodexPluginResult | null>(null)
  const [busy, setBusy] = useState(false)
  if (!hasBridge) return null
  const installCodex = async (): Promise<void> => {
    if (!window.confirm('Install the Harpoon plugin for Codex? Harpoon writes a local plugin marketplace in its own folder and runs "codex plugin marketplace add" and "codex plugin add harpoon@harpoon". The Codex CLI, desktop app and IDE extension all see it.')) return
    setBusy(true)
    const r = await invoke('mcp.external.codexPlugin', { install: true })
    setBusy(false)
    if (!r.ok) return toast(r.error.message, 'error')
    setCodex(r.value)
    const allOk = r.value.steps.every((x) => x.ok)
    toast(allOk ? 'Harpoon plugin installed for Codex. Restart the Codex app to see it.' : 'The Codex plugin was written, but a step failed; see Settings → AI.', allOk ? 'info' : 'warn')
  }
  const editor = async (e: 'vscode' | 'cursor'): Promise<void> => {
    const r = await invoke('mcp.addToEditor', { editor: e })
    if (!r.ok) toast(r.error.message, 'error')
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <span className="font-medium">Connect an app</span>
      <p className="text-muted-foreground">
        These run Harpoon itself as a local MCP server (Harpoon --mcp), which uses the token from this computer&apos;s settings, so no token goes into the app&apos;s
        configuration. Keep Harpoon open, with a project, while the agent works.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void installCodex()} title="Codex CLI, desktop app and IDE extension">
          {busy ? 'Installing…' : 'Install for Codex'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void editor('vscode')}>
          Add to VS Code
        </Button>
        <Button size="sm" variant="outline" onClick={() => void editor('cursor')}>
          Add to Cursor
        </Button>
      </div>
      {codex !== null && (
        <div className="flex flex-col gap-1 text-[11px]">
          {codex.steps.map((st) => (
            <p key={st.command} className={st.ok ? 'text-muted-foreground' : 'text-warning'}>
              {st.ok ? '✓' : '✗'} {st.command}
              {!st.ok && st.output !== '' ? `: ${st.output}` : ''}
            </p>
          ))}
          <p className="text-muted-foreground">
            By hand: <code className="font-mono">codex plugin marketplace add &quot;{codex.dir}&quot;</code>, then <code className="font-mono">codex plugin add harpoon@harpoon</code>.
          </p>
        </div>
      )}
    </div>
  )
}
