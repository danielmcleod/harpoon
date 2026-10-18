// Codex's "CLI default", decided per pass. The live balanced run found that a pass with no model ran the model the
// user's Codex configuration names
// (`gpt-5.6-sol`), which a free ChatGPT login refuses (X09h: model_unavailable, at the turn). A pass with no model of its
// own still starts its thread without one, so the CLI resolves the model for the pass folder (project layers, profiles
// and overrides included) and thread/start (or thread/resume) names it. Only when the account cannot use that model (it
// is not in model/list, hidden models included) does the pass override it with model/list's default on turn/start
// (TurnStartParams.model). Only a ChatGPT login is judged so (listDecides): it is the login X09h showed refusing a model
// its list lacks. Every uncertainty (another login, the openai provider pointed elsewhere, no list, a list that could not
// be read whole, an unexpected shape, another provider) leaves the model to the CLI: Harpoon never overrides a model it
// is not sure the account lacks.
import type { ModelInfo } from '../../../shared/vendors.ts'
import { arr, rec, str } from './wire.ts'

/** The provider whose models model/list describes (the built-in one). */
export const OPENAI_PROVIDER = 'openai'
/** `codex login status`'s method (probe.ts LoginStatus) for a ChatGPT login: the only one whose list decides. */
export const CHATGPT_LOGIN = 'chatgpt'
/** The variable that points the built-in openai provider at another server (whose models model/list may not list). */
export const OPENAI_BASE_URL_ENV = 'OPENAI_BASE_URL'

/**
 * Whether the account's list may decide for a pass with no model (CodexFacts.accountModels is kept only then). Only a
 * ChatGPT login has shown a model/list that stands for what the account may run (X09h: a model it lacks is refused at
 * the turn). With an API key, an access token, an unknown login, or the openai provider behind OPENAI_BASE_URL, a model
 * the list lacks may be the user's own choice and run, so it is left to the CLI; a real refusal reaches
 * model_unavailable and its one-click fix.
 */
export function listDecides(o: { login: string | undefined; openaiBaseUrl: string | undefined }): boolean {
  return o.login === CHATGPT_LOGIN && (o.openaiBaseUrl ?? '').trim() === ''
}
/** model/list pages read for the decision; a list with more pages is not read whole, so it decides nothing. */
export const DECISION_LIST_PAGES = 5
/** The decision's model/list: every model the account has, hidden ones included (never shown in a picker). */
export const DECISION_LIST_PARAMS = { includeHidden: true } as const

/** What thread/start (or thread/resume) answered: the model the CLI resolved for the pass folder, and its provider. */
export interface ThreadModel {
  model: string
  provider: string
}

/** thread/start's (or thread/resume's) answer → the model it runs; undefined when it does not name both. */
export function threadModelOf(answer: unknown): ThreadModel | undefined {
  const r = rec(answer)
  const model = str(r?.['model'])?.trim() ?? ''
  const provider = str(r?.['modelProvider'])?.trim() ?? ''
  return model !== '' && provider !== '' ? { model, provider } : undefined
}

/** The account's models as a model/list answered them: every id a model answers to, and the default's. */
export interface AccountModels {
  ids: readonly string[]
  /** The one model/list marks `isDefault`; absent when none (or more than one) is marked. */
  defaultId?: string
}

/**
 * The probe's picker list (hidden models left out) as AccountModels: the decision's first look, so a pass whose model
 * the picker lists asks nothing more. Undefined when the list names no default (logged out, no list): a pass then
 * leaves its model to the CLI.
 */
export function accountModelsOf(models: readonly ModelInfo[]): AccountModels | undefined {
  const cli = models.filter((m) => m.source === 'cli')
  const defaults = cli.filter((m) => m.isDefault === true)
  const only = defaults.length === 1 ? defaults[0] : undefined
  if (only === undefined) return undefined
  return { ids: [...new Set(cli.flatMap((m) => [m.id, ...(m.aliases ?? [])]))], defaultId: only.id }
}

/** One model/list page; undefined when it is not the 0.160 shape (`data` an array of models, `nextCursor`). */
function pageOf(answer: unknown): { ids: string[]; defaults: string[]; next: string | null } | undefined {
  const r = rec(answer)
  if (r === undefined || !Array.isArray(r['data'])) return undefined
  const next = r['nextCursor']
  if (next !== null && next !== undefined && typeof next !== 'string') return undefined
  const ids: string[] = []
  const defaults: string[] = []
  for (const m of arr(r['data'])) {
    const e = rec(m)
    const model = str(e?.['model'])?.trim() ?? ''
    const id = str(e?.['id'])?.trim() ?? ''
    if (e === undefined || (model === '' && id === '')) return undefined
    for (const x of [model, id]) if (x !== '') ids.push(x)
    if (e['isDefault'] === true) defaults.push(model !== '' ? model : id)
  }
  return { ids, defaults, next: typeof next === 'string' && next !== '' ? next : null }
}

/**
 * Every model the account has (model/list with hidden models), read page by page through `request`. Undefined when the
 * list cannot be read whole: a refused or unanswered request, a page that is not the expected shape, more pages than
 * DECISION_LIST_PAGES. Such a list decides nothing (the model is left to the CLI).
 */
export async function fetchAccountModels(
  request: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<AccountModels | undefined> {
  const ids = new Set<string>()
  const defaults = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < DECISION_LIST_PAGES; page++) {
    let answer: unknown
    try {
      answer = await request({ ...DECISION_LIST_PARAMS, ...(cursor !== null ? { cursor } : {}) })
    } catch {
      return undefined
    }
    const p = pageOf(answer)
    if (p === undefined) return undefined
    for (const id of p.ids) ids.add(id)
    for (const d of p.defaults) defaults.add(d)
    cursor = p.next
    if (cursor === null) {
      const only = defaults.size === 1 ? [...defaults][0] : undefined
      return { ids: [...ids], ...(only !== undefined ? { defaultId: only } : {}) }
    }
  }
  return undefined
}

/**
 * Why a pass with no model runs the model it does:
 *  - `listed`: the account lists the model the CLI resolved (hidden ones count): it runs, nothing is sent;
 *  - `unlisted`: the account's list lacks it (X09h: refused), so turn/start carries model/list's default instead;
 *  - `no-list`: no list to judge by, or one without a single default: left to the CLI;
 *  - `other-provider`: the folder's configuration runs another provider, whose models model/list does not describe;
 *  - `unknown-model`: the thread named no model (nothing to judge, nothing recorded).
 */
export type CodexModelWhy = 'listed' | 'unlisted' | 'no-list' | 'other-provider' | 'unknown-model'

export interface CodexModelDecision {
  why: CodexModelWhy
  /** The model the pass runs, when known: what the step records (StepView.modelUsed) and is priced at. */
  runs?: string
  /** `unlisted` only: the model turn/start carries (model/list's default), in place of the one the CLI resolved. */
  override?: string
  /** `unlisted` only: the model the CLI resolved, which the account does not list. */
  replaced?: string
}

/** The decision (pure): the model the thread answered against the account's list. */
export function decideModel(
  thread: ThreadModel | undefined,
  list: AccountModels | undefined,
): CodexModelDecision {
  if (thread === undefined) return { why: 'unknown-model' }
  const runs = { runs: thread.model }
  if (thread.provider.toLowerCase() !== OPENAI_PROVIDER) return { why: 'other-provider', ...runs }
  if (list === undefined) return { why: 'no-list', ...runs }
  if (list.ids.includes(thread.model)) return { why: 'listed', ...runs }
  const fallback = list.defaultId
  if (fallback === undefined || fallback === thread.model) return { why: 'no-list', ...runs }
  return { why: 'unlisted', runs: fallback, override: fallback, replaced: thread.model }
}
