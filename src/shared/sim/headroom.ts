// How much load the architecture takes. The base load is what the entry points generate (their "Generates" setting,
// or the default); the scenario's multiplier and pattern scale it. Headroom is the multiplier where something first
// fails, found by running a fresh engine at steady load with no faults, and what fails there.
import type { Model } from '../model/schema.ts'
import { DEFAULT_ENTRY_RPS, Simulator } from './engine.ts'
import type { Frame, LoadProfile } from './engine.ts'
import { failureReport } from './explain.ts'
import type { RootCause } from './explain.ts'
import { hasFailure } from './onsets.ts'
import { entryNodes } from './paths.ts'

export interface EntryLoad {
  id: string
  rps: number
  /** False when the node has no load of its own set and generates the default. */
  set: boolean
}

/** What each entry point generates at 1×, and the total. */
export function baseLoad(m: Model): { total: number; entries: EntryLoad[] } {
  const entries = entryNodes(m).map((id) => {
    const v = m.nodes[id]?.sim?.entryRps ?? null
    return { id, rps: v ?? DEFAULT_ENTRY_RPS, set: v !== null }
  })
  return { total: entries.reduce((a, e) => a + e.rps, 0), entries }
}

/** The most each pattern multiplies the base load by. */
export const PROFILE_PEAK: Record<LoadProfile, number> = { constant: 1, ramp: 3, spike: 4, diurnal: 1.6 }

export const PROFILE_TEXT: Record<LoadProfile, string> = {
  constant: 'The same load the whole time.',
  ramp: 'Starts at 0.2× and climbs to 3× over three minutes.',
  spike: 'Jumps to 4× for 10 seconds every minute.',
  diurnal: 'Swings between 0.4× and 1.6× every two minutes.',
}

export interface Headroom {
  /** The highest multiplier that runs with nothing failing: 0 when it fails with almost no load, null past HEADROOM_MAX. */
  limit: number | null
  /** What fails just past the limit (or at almost no load). */
  roots: RootCause[]
  /** Flows that pass through what fails. */
  flows: string[]
}

export const HEADROOM_MIN = 0.05
export const HEADROOM_MAX = 20
/** Simulated time each trial runs (30 s), and the stretch at its end that must be free of failure. */
const TRIAL_TICKS = 120
const SETTLE_TICKS = 20

/** Run at steady load; the first failing frame of the settled stretch, or null when it holds. */
function trial(m: Model, multiplier: number, healthy: readonly string[]): Frame | null {
  const sim = new Simulator(m)
  const sc = { multiplier, profile: 'constant' as const, faults: [], healthy: [...healthy] }
  let bad: Frame | null = null
  for (let i = 0; i < TRIAL_TICKS; i++) {
    const f = sim.step(sc)
    if (i >= TRIAL_TICKS - SETTLE_TICKS && bad === null && hasFailure(f)) bad = f
  }
  return bad
}

/** Round down to two significant figures, so the limit shown is one that holds. */
function floor2(v: number): number {
  const p = 10 ** (Math.floor(Math.log10(v)) - 1)
  return Number((Math.floor(v / p + 1e-9) * p).toPrecision(2))
}

function flowsThrough(m: Model, roots: readonly RootCause[]): string[] {
  const nodes = new Set(roots.flatMap((r) => (r.ref.kind === 'node' ? [r.ref.id] : [])))
  const conns = new Set(roots.flatMap((r) => (r.ref.kind === 'connector' ? [r.ref.id] : [])))
  const inside = (id: string): boolean => {
    for (let cur = m.nodes[id]; cur !== undefined; cur = cur.parentId === null ? undefined : m.nodes[cur.parentId]) if (nodes.has(cur.id)) return true
    return false
  }
  return Object.values(m.flows)
    .filter((fl) => fl.steps.some((s) => {
      const c = m.connectors[s.connectorId]
      return c !== undefined && (conns.has(c.id) || inside(c.source) || inside(c.target))
    }))
    .map((fl) => fl.name)
}

/** The multiplier the architecture holds at steady load with no faults (nodes forced healthy stay healthy). */
export function headroom(m: Model, healthy: readonly string[] = []): Headroom {
  const done = (limit: number | null, f: Frame | null): Headroom => {
    const roots = f === null ? [] : failureReport(m, f).roots.filter((r) => r.health === 'bad')
    return { limit, roots, flows: flowsThrough(m, roots) }
  }
  const low = trial(m, HEADROOM_MIN, healthy)
  if (low !== null) return done(0, low)
  let high = trial(m, HEADROOM_MAX, healthy)
  if (high === null) return done(null, null)
  // Binary search in log space: lo holds, hi fails.
  let lo = HEADROOM_MIN
  let hi = HEADROOM_MAX
  for (let i = 0; i < 10; i++) {
    const mid = Math.sqrt(lo * hi)
    const f = trial(m, mid, healthy)
    if (f === null) lo = mid
    else {
      hi = mid
      high = f
    }
  }
  return done(floor2(lo), high)
}
