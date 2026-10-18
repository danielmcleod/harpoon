// Model and pricing catalog (HARPOON_HOME/catalog/*) and the AI refresh job.
import type { VendorId } from './vendors.ts'

export const MODEL_SOURCES = ['cli', 'ai-refresh', 'user'] as const
export type ModelSource = (typeof MODEL_SOURCES)[number]

export interface CatalogModel {
  id: string
  displayName?: string
  aliases?: string[]
  isDefault?: boolean
  hidden?: boolean
  contextWindow?: number
  maxOutput?: number
  reasoningEfforts?: string[]
  deprecated?: boolean
  source: ModelSource
  fetchedAt: number
}

export interface CatalogVendorModels {
  source: ModelSource
  fetchedAt: number
  cliVersion?: string
  models: CatalogModel[]
}

/** `catalog/models.json`; ships empty. CLI-reported lists are preferred. */
export interface ModelsFile {
  schemaVersion: 1
  updatedAt: number
  vendors: Record<VendorId, CatalogVendorModels>
}

export const PRICE_CONFIDENCES = ['verified', 'unverified', 'user'] as const
export type PriceConfidence = (typeof PRICE_CONFIDENCES)[number]

export const PRICE_FIELDS = [
  'inputPerMTok',
  'outputPerMTok',
  'cacheReadPerMTok',
  'cacheWritePerMTok',
] as const
export type PriceField = (typeof PRICE_FIELDS)[number]

/** USD per 1,000,000 tokens, standard tier. Keyed by concrete model id; aliases resolve to it. */
export interface PriceEntry {
  vendor: VendorId
  model: string
  aliases: string[]
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number | null
  cacheWritePerMTok: number | null
  sourceUrl: string
  /** Verbatim quote from sourceUrl, at most 200 characters. */
  sourceQuote?: string
  fetchedAt: number
  confidence: PriceConfidence
  deprecated?: boolean
}

/** `catalog/pricing.json` (seeded from `pricing.seed.json`, all `unverified`). */
export interface PricingFile {
  schemaVersion: 1
  updatedAt: number
  entries: PriceEntry[]
}

/** Manual edit from Settings → Catalog; stored with `confidence:'user'`. */
export type PriceEdit = Pick<
  PriceEntry,
  'vendor' | 'model' | 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'
> & { aliases?: string[]; sourceUrl?: string }

// ---- refresh job output (the AI pass's JSON, validated in core/catalog/validate.ts) ----

export interface ProposedPrice {
  vendor: VendorId
  model: string
  aliases?: string[]
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number | null
  cacheWritePerMTok: number | null
  sourceUrl: string
  sourceQuote: string
  deprecated?: boolean
}

export interface ProposedModel {
  vendor: VendorId
  id: string
  displayName?: string
  contextWindow?: number
  sourceUrl: string
}

export interface CatalogUnverifiable {
  vendor: VendorId
  model: string
  reason: string
}

export interface CatalogRefreshOutput {
  generatedAt: string
  entries: ProposedPrice[]
  newModels: ProposedModel[]
  unverifiable: CatalogUnverifiable[]
}

// ---- diff review -------------------------------------------------------------

/**
 * bigChange: >50% change (amber, unticked) · suspicious: >10× or <0.1× (unticked) · unofficial: source host not in
 * core/catalog/sources.ts · notReportedByCli · userEdited: current entry has confidence 'user' ·
 * deprecated: model missing from the proposal (tickable; deletions are never proposed) ·
 * inconsistent: output < input, or cacheRead > input · notFetched: the refresh read no page on the
 * source's host, so the price is not confirmed (never `verified`).
 */
export const CATALOG_DIFF_FLAGS = [
  'suspicious',
  'unofficial',
  'notFetched',
  'notReportedByCli',
  'userEdited',
  'bigChange',
  'deprecated',
  'inconsistent',
] as const
export type CatalogDiffFlag = (typeof CATALOG_DIFF_FLAGS)[number]

/**
 * `confirm` is an entry whose prices the official page confirmed unchanged; ticking it records that page,
 * its quote and today's date and marks the prices verified (nothing changes unless it is ticked).
 */
export type CatalogDiffRowKind = 'price' | 'confirm' | 'new-model' | 'deprecate'

export interface CatalogDiffRow {
  id: string
  vendor: VendorId
  model: string
  kind: CatalogDiffRowKind
  field?: PriceField
  current: number | null
  proposed: number | null
  /** (proposed − current) / current × 100; null when either side is missing. */
  deltaPct: number | null
  sourceUrl: string | null
  sourceQuote: string | null
  flags: CatalogDiffFlag[]
  /** Default tick state; any flag unticks the row. */
  ticked: boolean
  /** Why the row is flagged, one plain sentence per flag (core/catalog/validate.ts); absent when unflagged. */
  reason?: string
  /** The proposal's source is official for the vendor and quoted, so the applied price is `verified`. */
  verified?: boolean
}

/** Price ≤ 0 or > 1000, or a zod failure: never offered for apply. */
export interface CatalogRejectedRow {
  vendor: VendorId
  model: string
  field?: PriceField
  value: unknown
  reason: string
}

export interface CatalogDiff {
  jobId: string
  generatedAt: number
  vendor: VendorId
  model: string | null
  rows: CatalogDiffRow[]
  rejected: CatalogRejectedRow[]
  unverifiable: CatalogUnverifiable[]
}

// ---- job, schedule, state -----------------------------------------------------

export const CATALOG_JOB_STATES = ['running', 'diff-ready', 'failed', 'applied', 'cancelled'] as const
export type CatalogJobState = (typeof CATALOG_JOB_STATES)[number]
/** AppEvent `catalog` states: the job states plus `due` from the scheduler. */
export type CatalogEventState = 'due' | CatalogJobState

export interface CatalogJob {
  id: string
  state: CatalogJobState
  vendor: VendorId
  model: string | null
  startedAt: number
  endedAt?: number
  progress?: string
  error?: string
  diff?: CatalogDiff
}

export interface CatalogSchedule {
  enabled: boolean
  /** UI presets Off/7/14/30; default 14. */
  intervalDays: number
  lastRefreshAt: number | null
  snoozedUntil: number | null
  nextDueAt: number | null
}

/** `catalog.setSchedule` request: Turn off, change interval, or "Not now (7 days)". */
export interface CatalogScheduleUpdate {
  enabled?: boolean
  intervalDays?: number
  snoozeDays?: number
}

export type PricingConfidenceSummary = 'verified' | 'unverified' | 'user' | 'mixed' | 'none'

export interface CatalogStatus {
  /**
   * When the prices were last checked against the vendors' pages (the newest fetchedAt of a price the user
   * did not set, or the last finished refresh if later; a manual edit never moves it). Null: no price recorded.
   */
  pricingUpdatedAt: number | null
  confidence: PricingConfidenceSummary
  /** Pricing (`pricingUpdatedAt`) older than 2× the refresh interval (shown amber). */
  stale: boolean
  refreshDue: boolean
  jobRunning: boolean
  schedule: CatalogSchedule
}

export interface CatalogHistoryEntry {
  id: string
  at: number
  source: 'refresh' | 'manual' | 'undo' | 'restore'
  entries: number
  jobId?: string
  /** A later `catalog.undo` put back the prices from before this change. */
  undone?: boolean
}

export interface CatalogState {
  models: ModelsFile
  pricing: PricingFile
  status: CatalogStatus
  job: CatalogJob | null
  /** Newest first; 20 kept in catalog/history/. */
  history: CatalogHistoryEntry[]
  /** The history entry `catalog.undo` would put back now (absent or null: nothing to undo). */
  undoId?: string | null
}

/** Shown on the consent card before any refresh: it never auto-runs. */
export interface CatalogRefreshPlan {
  vendor: VendorId
  model: string | null
  estDurationMs: number | null
  estCostUsd: number | null
  lastRefreshAt: number | null
  due: boolean
  /** Set when the configured refresh vendor is not ready or not web-capable. */
  fallbackNote?: string
  /** The vendor as the card names it ("Claude"). */
  vendorName?: string
  /** What the job may do, for the card: "Read-only, web search, cannot change files." */
  copy?: string
  /** Vendors whose prices the job checks, and the official hosts it may read pages from (catalog/sources.ts). */
  vendors?: VendorId[]
  hosts?: string[]
  /**
   * Whether the job can read pages only on `hosts`
   * (Claude: `WebFetch(domain:…)` with CLAUDE_CODE_EVAL_CONFINED). False where the vendor's web search takes no
   * domain list (Codex's `web_search`), so the card does not promise it; a price sourced on another site is flagged
   * `unofficial` in the review either way. Absent (an earlier core): the card reads as before.
   */
  hostsConfined?: boolean
  /** Past refreshes the estimates come from (0: a typical figure, no history yet). */
  estSamples?: number
  /** Subscription login: the cost is what the tokens would cost on the API ("API-equiv."). */
  apiEquivalent?: boolean
  /** A refresh runs now (its id); `catalog.refresh` answers CONFLICT until it ends. */
  runningJobId?: string
  /**
   * With `model` null (the CLI's default), the concrete model that default is (the probe's), which
   * `estCostUsd` is priced at; absent when not known. The card names it: "Claude (CLI default: claude-opus-5-5)".
   */
  defaultModel?: string
}
