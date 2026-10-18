// Estimates, Dashboard aggregates and attention items.
// Core computes all of these from RunSummary.steps[] (final attempt only); the renderer formats them.
import type { CatalogStatus } from './catalog.ts'
import type { FailureCategory } from './failure.ts'
import type { CheckResult } from './preflight.ts'
import type { AskView, CardKind, PauseReason, RunSummary, StepKey } from './run.ts'
import type { ProbeView, VendorId } from './vendors.ts'

/** Where a cost figure came from: vendor-reported, tokens × catalog price, or unknown (shown as "No price"). */
export const COST_BASES = ['vendor', 'catalog', 'none'] as const
export type CostBasis = (typeof COST_BASES)[number]

export interface Percentiles {
  p50: number
  p80: number
}

export type Estimate = {
  durationMs: Percentiles
  costUsd: Percentiles | null
  /** Tokens; the only figure when the model (and so its price) is unknown. */
  tokens?: Percentiles
  /** Successful samples behind the figure (0 = priors). */
  samples: number
  /** Human basis, e.g. "from 12 runs (codex · implement)" or "typical (no history yet)". */
  basis: string
  /** `vendor/model` pairs without a price. */
  missingPricing: string[]
}

export const ESTIMATE_LEVELS = ['exact', 'model', 'vendor', 'step', 'prior'] as const
/** Lookup level actually used: (vendor,model,mode,step,bucket) → (vendor,model,step) → (vendor,step) → (step) → prior. */
export type EstimateLevel = (typeof ESTIMATE_LEVELS)[number]

export interface StepEstimate extends Estimate {
  level: EstimateLevel
}

/**
 * total = prepare + plan + implement + verify·[implement∈runAfter] + max(review, critic)
 *       + P(fix)·(fix + verify·[fix∈runAfter]). Waits on the user are excluded ("+ your review time").
 */
export interface RunEstimate {
  total: Estimate
  steps: Partial<Record<StepKey, StepEstimate>>
  pFix: { value: number; basis: 'folder' | 'global' | 'prior' }
}

// ---- attention ----------------------------------------------------------------

export const ATTENTION_KINDS = ['ask', 'card', 'stalled', 'paused', 'failed'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

interface AttentionBase {
  id: string
  runId: string
  displayNo: number
  /** Run title. */
  title: string
  folder: string
  since: number
}

/**
 * needsYou = pending asks + open blocking cards (gates included) + stalled steps + paused steps + failed steps
 * with an open snag. Computed only by core's attention.ts.
 */
export type AttentionItem = AttentionBase &
  (
    | { kind: 'ask'; ask: AskView }
    | { kind: 'card'; cardId: string; cardKind: CardKind; cardTitle: string; blocking: boolean }
    | { kind: 'stalled'; step: StepKey }
    | { kind: 'paused'; step: StepKey; pause: PauseReason }
    | { kind: 'failed'; step: StepKey; category: FailureCategory }
  )

// ---- dashboard / stats ------------------------------------------------------------

export const DASHBOARD_PERIODS = ['today', 'd7', 'd30'] as const
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]

/** failed = status failed OR outcome failed. */
export interface PeriodTotals {
  runs: number
  completed: number
  failed: number
  costUsd: number
  tokens: number
}

export interface VendorSpend {
  vendor: VendorId
  costUsd: number
  tokens: number
  /** Any part was priced from the catalog under subscription auth ("API-equiv."). */
  apiEquivalent: boolean
}

export interface DashboardData {
  generatedAt: number
  active: RunSummary[]
  /** Last 20. */
  recent: RunSummary[]
  totals: Record<DashboardPeriod, PeriodTotals>
  spendByVendor7d: VendorSpend[]
  vendorHealth: ProbeView[]
  attention: { needsYou: number; items: AttentionItem[] }
  catalog: CatalogStatus
  /**
   * The app-scope checks of a folder-less live preflight (git, Harpoon's home, free space), so the setup card
   * can show git's state and its install fix before a folder is chosen (the setup card probes vendors and git).
   */
  appChecks?: CheckResult[]
}

export const STATS_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
export type StatsRange = (typeof STATS_RANGES)[number]

/** Summary tiles for `stats.get{range}`. */
export interface StatsData {
  range: StatsRange
  from: number | null
  to: number
  runs: number
  completed: number
  failed: number
  cancelled: number
  /** completed / (completed + failed); cancelled excluded; null when n = 0. */
  successRate: number | null
  successSamples: number
  medianDurationMs: number | null
  costUsd: number
  tokens: number
  spendByVendor: VendorSpend[]
}
