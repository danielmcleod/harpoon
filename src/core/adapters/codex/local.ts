// The local-model preset's readiness and model list (`GET {baseUrl}/models`, the
// context length from Ollama `/api/show` or LM Studio `/api/v0/models`, warn below 32k; readiness HTTP goes to
// loopback presets only; readiness ids pass.<p>.readiness.local-{server,responses,context}). Nothing here spends
// tokens or loads a model: the Responses check posts an empty body, which a server with the endpoint refuses (4xx)
// and one without it answers 404. The API key named by `apiKeyEnv` is never read: Codex reads it itself.
import { isLoopbackHost } from '../../../shared/config-schema.ts'
import type { CheckResult, CheckStatus } from '../../../shared/preflight.ts'
import type { LocalPreset, ModelInfo, ReadinessPurpose } from '../../../shared/vendors.ts'
import { osFamily, repairCommand } from '../../heal/commands.ts'
import { arr, num, rec, str } from './wire.ts'

/** A context window under this warns (Codex's prompts and tools need room). */
export const LOCAL_MIN_CONTEXT = 32_000
export const LOCAL_HTTP_TIMEOUT_MS = 800
const READINESS_TTL_MS = 60_000

export type FetchFn = (
  url: string,
  init?: {
    method?: string
    body?: string
    headers?: Record<string, string>
    signal?: AbortSignal
    /** Always `manual`: a redirect is never followed (it could lead off this computer). */
    redirect?: 'manual' | 'error' | 'follow'
  },
) => Promise<{
  status: number
  ok: boolean
  /** `opaqueredirect` for a redirect a browser-style fetch did not follow. */
  type?: string
  /** The URL that answered (a fetch that followed a redirect names where it ended). */
  url?: string
  json(): Promise<unknown>
}>

/** The preset's base URL when it is on this computer (http(s) to localhost / 127.x / [::1]), else undefined. */
export function loopbackUrl(baseUrl: string): URL | undefined {
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname
    return isLoopbackHost(host) ? u : undefined
  } catch {
    return undefined
  }
}

/** `{baseUrl}/<path>` (base `http://127.0.0.1:11434/v1` → `…/v1/models`). */
export function under(base: URL, path: string): string {
  const b = base.href.endsWith('/') ? base.href : `${base.href}/`
  return new URL(path.replace(/^\//, ''), b).href
}

/** The server's root (`/api/show` and `/api/v0/models` live there, not under `/v1`). */
const rootOf = (base: URL): string => `${base.protocol}//${base.host}/`

/** The words for an answer that pointed somewhere else (a 3xx): Harpoon never follows it. */
export const REDIRECT_REFUSED = 'it answered with a redirect, which Harpoon does not follow'

/**
 * One request to the preset's server. Redirects are never followed (`redirect: 'manual'`): a loopback server (or a
 * local proxy) that answers 3xx could send the request, and the trust in its answer, to another computer.
 * A 3xx, an opaque redirect, or an answer from a URL that is not on this computer counts as no answer.
 */
async function request(
  fetchFn: FetchFn,
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  timeoutMs = LOCAL_HTTP_TIMEOUT_MS,
): Promise<{ status: number; ok: boolean; body: unknown } | { error: string }> {
  if (loopbackUrl(url) === undefined) return { error: 'not on this computer' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  timer.unref()
  try {
    const r = await fetchFn(url, { ...init, signal: ctl.signal, redirect: 'manual' })
    const redirected =
      r.type === 'opaqueredirect' ||
      (r.status >= 300 && r.status < 400) ||
      (r.status === 0 && !r.ok) ||
      (r.url !== undefined && r.url !== '' && loopbackUrl(r.url) === undefined)
    if (redirected) return { error: REDIRECT_REFUSED }
    let body: unknown
    try {
      body = await r.json()
    } catch {
      body = undefined
    }
    return { status: r.status, ok: r.ok, body }
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string }
    return {
      error: ctl.signal.aborted
        ? `no answer within ${timeoutMs} ms`
        : (e.cause?.code ?? e.message ?? String(err)),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** OpenAI `GET /models` → ids. */
export function modelIdsOf(body: unknown): string[] {
  return arr(rec(body)?.['data'])
    .map((m) => str(rec(m)?.['id']))
    .filter((id): id is string => id !== undefined && id !== '')
}

/** The models a loopback preset's server lists (picker rows; `source:'local-server'`). Anything else: none. */
export async function listLocalModels(
  preset: LocalPreset,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ModelInfo[]> {
  const base = loopbackUrl(preset.baseUrl)
  if (base === undefined) return []
  const r = await request(fetchFn, under(base, 'models'))
  if ('error' in r || !r.ok) return []
  return modelIdsOf(r.body).map((id) => ({
    id,
    source: 'local-server' as const,
    ...(id === preset.model ? { isDefault: true } : {}),
    ...(id === preset.model && preset.contextWindow !== undefined
      ? { contextWindow: preset.contextWindow }
      : {}),
  }))
}

/** Ollama `/api/show` `model_info["<arch>.context_length"]` (or a `num_ctx` parameter). */
export function ollamaContext(body: unknown): number | undefined {
  const r = rec(body)
  const info = rec(r?.['model_info'])
  if (info !== undefined) {
    for (const [k, v] of Object.entries(info))
      if (k.endsWith('.context_length') && num(v) !== undefined) return num(v)
  }
  const params = str(r?.['parameters'])
  const m = params !== undefined ? /\bnum_ctx\s+(\d+)/.exec(params) : null
  return m?.[1] !== undefined ? Number(m[1]) : undefined
}

/** LM Studio `/api/v0/models` `data[].{id, loaded_context_length, max_context_length}` for the preset's model. */
export function lmStudioContext(body: unknown, model: string): number | undefined {
  const m = arr(rec(body)?.['data'])
    .map(rec)
    .find((x) => str(x?.['id']) === model)
  return num(m?.['loaded_context_length']) ?? num(m?.['max_context_length'])
}

export interface LocalChecksInput {
  pass: ReadinessPurpose
  preset: LocalPreset
  at: number
  fetchFn?: FetchFn
  timeoutMs?: number
}

/** pass.<p>.readiness.local-{server,responses,context}: reachability, the Responses API, the context length. */
export async function localReadiness(i: LocalChecksInput): Promise<CheckResult[]> {
  const fetchFn = i.fetchFn ?? globalThis.fetch
  const timeoutMs = i.timeoutMs ?? LOCAL_HTTP_TIMEOUT_MS
  const p = i.preset
  const check = (
    id: 'local-server' | 'local-responses' | 'local-context',
    status: CheckStatus,
    title: string,
    detail: string,
    extra: Partial<CheckResult> = {},
  ): CheckResult => ({
    id: `pass.${i.pass}.readiness.${id}`,
    scope: 'pass',
    status,
    blocking: status === 'fail',
    title,
    detail,
    recovery: [],
    at: i.at,
    ttlMs: READINESS_TTL_MS,
    ...extra,
  })
  const settings = {
    id: `pass.${i.pass}.readiness.local-preset`,
    label: 'Open the local model presets',
    kind: 'settings_link' as const,
    route: 'settings/vendors',
    pointer: '/local/presets',
  }
  const base = loopbackUrl(p.baseUrl)
  if (base === undefined) {
    const why = 'Harpoon only checks local servers on this computer (localhost, 127.0.0.1 or [::1]).'
    return [
      check('local-server', 'skip', `${p.label}: server not checked`, why),
      check('local-responses', 'skip', `${p.label}: Responses API not checked`, why),
      check('local-context', 'skip', `${p.label}: context length not checked`, why),
    ]
  }
  const serve = repairCommand('ollamaServe', osFamily())
  const serveAction =
    serve !== null
      ? [
          {
            id: `pass.${i.pass}.readiness.local-serve`,
            label: 'Copy the command that starts Ollama',
            kind: 'shell_copy' as const,
            command: serve.command,
            shell: serve.shell,
            reason: `${p.label} did not answer at ${p.baseUrl}`,
            recheck: `pass.${i.pass}.readiness.local-server`,
          },
        ]
      : []

  const [models, responses] = await Promise.all([
    request(fetchFn, under(base, 'models'), {}, timeoutMs),
    request(
      fetchFn,
      under(base, 'responses'),
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      timeoutMs,
    ),
  ])
  const out: CheckResult[] = []
  if ('error' in models) {
    const redirected = models.error === REDIRECT_REFUSED
    out.push(
      check(
        'local-server',
        'fail',
        redirected ? `${p.label} points somewhere else` : `${p.label} is not reachable`,
        redirected
          ? `GET ${under(base, 'models')}: ${models.error}. Use the address of the server itself.`
          : `GET ${under(base, 'models')}: ${models.error}`,
        {
          category: 'local_server',
          recovery: redirected ? [settings] : [...serveAction, settings],
        },
      ),
    )
    out.push(
      check('local-responses', 'skip', `${p.label}: Responses API not checked`, 'The server did not answer.'),
    )
    out.push(
      check('local-context', 'skip', `${p.label}: context length not checked`, 'The server did not answer.'),
    )
    return out
  }
  const ids = models.ok ? modelIdsOf(models.body) : []
  if (!models.ok) {
    out.push(
      check(
        'local-server',
        'fail',
        `${p.label} has no model list`,
        `GET ${under(base, 'models')} answered ${models.status}.`,
        {
          category: 'local_server',
          recovery: [settings],
        },
      ),
    )
  } else if (!ids.includes(p.model)) {
    out.push(
      check(
        'local-server',
        'fail',
        `${p.label} does not have ${p.model}`,
        ids.length > 0 ? `The server lists: ${ids.slice(0, 10).join(', ')}.` : 'The server lists no models.',
        { category: 'local_server', recovery: [settings] },
      ),
    )
  } else {
    out.push(
      check('local-server', 'pass', `${p.label} is running`, `${p.model} is available at ${p.baseUrl}.`),
    )
  }

  if ('error' in responses) {
    out.push(
      check(
        'local-responses',
        'warn',
        `${p.label}: Responses API not confirmed`,
        `POST ${under(base, 'responses')}: ${responses.error}`,
      ),
    )
  } else if (responses.status === 404) {
    out.push(
      check(
        'local-responses',
        'fail',
        `${p.label} has no Responses API`,
        'Codex talks to local models through /responses (Ollama 0.13.4 or newer, LM Studio 0.3.29 or newer). Update the server.',
        { category: 'local_server', recovery: [settings] },
      ),
    )
  } else {
    out.push(
      check(
        'local-responses',
        'pass',
        `${p.label} speaks the Responses API`,
        `/responses answered ${responses.status}.`,
      ),
    )
  }

  // Context length: the preset's own setting, else Ollama /api/show, else LM Studio /api/v0/models.
  let context = p.contextWindow
  let source = 'the preset'
  if (context === undefined) {
    const show = await request(
      fetchFn,
      `${rootOf(base)}api/show`,
      {
        method: 'POST',
        body: JSON.stringify({ model: p.model }),
        headers: { 'content-type': 'application/json' },
      },
      timeoutMs,
    )
    if (!('error' in show) && show.ok) {
      context = ollamaContext(show.body)
      source = 'Ollama'
    }
    if (context === undefined) {
      const lm = await request(fetchFn, `${rootOf(base)}api/v0/models`, {}, timeoutMs)
      if (!('error' in lm) && lm.ok) {
        context = lmStudioContext(lm.body, p.model)
        source = 'LM Studio'
      }
    }
  }
  if (context === undefined) {
    out.push(
      check(
        'local-context',
        'warn',
        `${p.label}: context length unknown`,
        `Harpoon assumes ${LOCAL_MIN_CONTEXT.toLocaleString('en-US')} tokens. Set the preset's context window if you know it.`,
        { recovery: [settings] },
      ),
    )
  } else if (context < LOCAL_MIN_CONTEXT) {
    out.push(
      check(
        'local-context',
        'warn',
        `${p.label}: ${context.toLocaleString('en-US')}-token context is small`,
        `Codex needs room for its instructions and your files; ${LOCAL_MIN_CONTEXT.toLocaleString('en-US')} tokens or more works better (from ${source}).`,
        { recovery: [settings] },
      ),
    )
  } else {
    out.push(
      check(
        'local-context',
        'pass',
        `${p.label}: ${context.toLocaleString('en-US')}-token context`,
        `From ${source}.`,
      ),
    )
  }
  return out
}
