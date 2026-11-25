// Load in the simulator, in requests per second: the base load the entry points generate, the multiplier on it, what
// the pattern does to it right now, and how much the architecture holds (worked out off the click path, once per model
// and set of forced-healthy nodes).
import { useEffect, useState } from 'react'
import { profileFactor } from '@shared/sim/engine.ts'
import { baseLoad, headroom } from '@shared/sim/headroom.ts'
import type { Headroom } from '@shared/sim/headroom.ts'
import type { Model } from '@shared/model/schema.ts'
import { setScenario, simTime, useSim } from './simStore.ts'

export const fmtRps = (v: number): string => (v >= 10_000 ? `${Math.round(v / 1000)}k rps` : v >= 1000 ? `${(v / 1000).toFixed(1)}k rps` : `${Math.round(v)} rps`)
export const fmtX = (v: number): string => `${v < 1 ? v.toFixed(2).replace(/0$/, '') : v < 10 ? v.toFixed(1) : Math.round(v)}×`

export const LOAD_MIN = 0.1
export const LOAD_MAX = 10
/** The steps the − / + buttons move between. */
export const LOAD_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 7.5, 10] as const

export function setLoad(multiplier: number): void {
  setScenario({ multiplier: Math.min(LOAD_MAX, Math.max(LOAD_MIN, Math.round(multiplier * 100) / 100)) })
}

/** One step down (−1) or up (+1) from the current multiplier. */
export function stepLoad(dir: -1 | 1): void {
  const cur = useSim.getState().scenario.multiplier
  const next = dir > 0 ? LOAD_STEPS.find((s) => s > cur + 1e-9) : [...LOAD_STEPS].reverse().find((s) => s < cur - 1e-9)
  if (next !== undefined) setLoad(next)
}

/** Base load at 1×, the multiplier, the pattern's factor right now, and what that sends. */
export function useLoad(model: Model | undefined): { base: number; multiplier: number; pattern: number; now: number } {
  const multiplier = useSim((s) => s.scenario.multiplier)
  const profile = useSim((s) => s.scenario.profile)
  // Re-read the pattern as the clock moves.
  useSim((s) => s.frames.length)
  const base = model === undefined ? 0 : baseLoad(model).total
  const pattern = profileFactor(profile, simTime())
  return { base, multiplier, pattern, now: base * multiplier * pattern }
}

const cache = new WeakMap<Model, Map<string, Headroom>>()
const NONE: readonly string[] = []

/** Headroom for the model with these nodes forced healthy; null while it is being worked out. */
export function useHeadroom(model: Model | undefined): Headroom | null {
  const healthy = useSim((s) => s.scenario.healthy) ?? NONE
  const key = [...healthy].sort().join('\n')
  const cached = model === undefined ? undefined : cache.get(model)?.get(key)
  const [, bump] = useState(0)
  useEffect(() => {
    if (model === undefined || cached !== undefined) return
    // Off the render: a big model takes a moment.
    const t = setTimeout(() => {
      const per = cache.get(model) ?? new Map<string, Headroom>()
      per.set(key, headroom(model, healthy))
      cache.set(model, per)
      bump((n) => n + 1)
    }, 150)
    return () => clearTimeout(t)
  }, [model, key, cached, healthy])
  return cached ?? null
}
