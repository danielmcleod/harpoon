// Preflight results. `adapter.probe()` and `adapter.readiness()` both return CheckResult[].
// The registry definition type lives in core.
import type { FailureCategory, RecoveryAction } from './failure.ts'
import type { PassName } from './run.ts'

export const CHECK_SCOPES = ['app', 'vendor', 'folder', 'run', 'pass'] as const
export type CheckScope = (typeof CHECK_SCOPES)[number]

export const CHECK_STATUSES = ['pass', 'warn', 'fail', 'skip'] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]

/**
 * ids: `app.*` · `vendor.<v>.{bin,version,auth,protocol,plan,winSandbox,env}` · `folder.*` · `run.*` ·
 * `pass.<p>.*` · `pass.<p>.readiness.<id>`.
 */
export interface CheckResult {
  id: string
  scope: CheckScope
  status: CheckStatus
  blocking: boolean
  category?: FailureCategory
  title: string
  detail: string
  recovery: RecoveryAction[]
  at: number
  ttlMs: number
}

export const PREFLIGHT_MODES = ['live', 'authoritative', 'passBoundary'] as const
export type PreflightMode = (typeof PREFLIGHT_MODES)[number]

export interface PreflightReport {
  mode: PreflightMode
  ok: boolean
  blocking: CheckResult[]
  warnings: CheckResult[]
  info: CheckResult[]
}

export const VENDOR_CHECKS = ['bin', 'version', 'auth', 'protocol', 'plan', 'winSandbox', 'env'] as const
export type VendorCheck = (typeof VENDOR_CHECKS)[number]

export function vendorCheckId(vendor: string, check: VendorCheck): string {
  return `vendor.${vendor}.${check}`
}

export function passCheckId(pass: PassName, check: string): string {
  return `pass.${pass}.${check}`
}

export function readinessCheckId(pass: PassName, id: string): string {
  return `pass.${pass}.readiness.${id}`
}
