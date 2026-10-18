// Findings contracts. Core parses Review/Critic output into
// these (src/core/findings/parse.ts) and persists them as runs/<id>/findings.json; the renderer only formats them.

/** Who produced a finding. `verify` findings come from failing checks. */
export const FINDING_SOURCES = ['review', 'critic', 'verify'] as const
export type FindingSource = (typeof FINDING_SOURCES)[number]

/** The reader passes whose output is parsed for findings. */
export const REVIEWER_SOURCES = ['review', 'critic'] as const satisfies readonly FindingSource[]
export type ReviewerSource = (typeof REVIEWER_SOURCES)[number]

export const SEVERITIES = ['must', 'should'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * - `untagged`: the source tagged nothing, so each top-level list item became a `should` ("didn't tag findings").
 * - `unstructured`: the source answered in prose only; the whole answer is one `should`.
 * - `preexisting`: a verify command that already failed before the run (does not block the Fix skip rule).
 */
export const FINDING_FLAGS = ['untagged', 'unstructured', 'preexisting'] as const
export type FindingFlag = (typeof FINDING_FLAGS)[number]

export interface Finding {
  /** `sha1(source + '\n' + normalizedFirstLine).slice(0, 12)`, `-2`, `-3`… on a collision. Stable across re-parses. */
  id: string
  /** Display number (F1…), must findings first. */
  n: number
  severity: Severity
  source: FindingSource
  /** The finding's first line without its marker and tag. */
  title: string
  /** Supporting lines, dedented; tagged descendants are cut out (they are findings of their own). */
  body: string
  flags: FindingFlag[]
  /** Review round that produced it (1 = the first Review ‖ Critic). */
  round: number
}

/**
 * - `none`: `NO FINDINGS` (or a short "no issues / LGTM") · `ok`: at least one tagged finding
 * - `untagged` / `unstructured`: see {@link FindingFlag} · `empty`: no output at all · `failed`: the pass failed.
 * A failed, empty or unparsed source never counts as zero findings.
 */
export const SOURCE_PARSE_STATUSES = ['none', 'ok', 'untagged', 'unstructured', 'empty', 'failed'] as const
export type SourceParseStatus = (typeof SOURCE_PARSE_STATUSES)[number]

export interface SourceParse {
  status: SourceParseStatus
  /** Findings produced by this source. */
  count: number
  /** The raw output artifact, relative to the run folder (e.g. `review.md`). */
  rawFile: string
}

/** Fix's closing report (`F<n> fixed|skipped|disputed`), parsed best-effort for display only. */
export const FIX_REPORT_STATUSES = ['fixed', 'skipped', 'disputed'] as const
export type FixReportStatus = (typeof FIX_REPORT_STATUSES)[number]

/** runs/<id>/findings.json */
export interface FindingsFile {
  schemaVersion: 1
  runId: string
  round: number
  sources: Partial<Record<FindingSource, SourceParse>>
  /** Must first, numbered F1…. */
  findings: Finding[]
  /** Finding id → sent to Fix. */
  selected: Record<string, boolean>
  /** Finding id → what Fix said it did. */
  fixReport?: Record<string, FixReportStatus>
}
