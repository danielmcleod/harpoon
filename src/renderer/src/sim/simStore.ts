// Simulator state: the scenario, play/pause and speed, the recorded frames (for the charts and scrubbing), and flow
// tracing. The engine instance lives outside React state and is rebuilt when the model changes.
import { create } from 'zustand'
import { DEFAULT_SCENARIO, Simulator, TICK_SEC } from '@shared/sim/engine.ts'
import type { Fault, Frame, Scenario } from '@shared/sim/engine.ts'
import type { Model } from '@shared/model/schema.ts'

/** Frames kept for scrubbing and charts (10 simulated minutes). */
export const HISTORY_MAX = 2400

export interface SimState {
  playing: boolean
  speed: number
  scenario: Scenario
  frames: Frame[]
  /** Index into frames while scrubbing; null follows the live edge. */
  cursor: number | null
  trace: { flowId: string; step: number; playing: boolean } | null
}

export const useSim = create<SimState>(() => ({
  playing: false,
  speed: 1,
  scenario: DEFAULT_SCENARIO,
  frames: [],
  cursor: null,
  trace: null,
}))

let engine: Simulator | null = null
let engineModel: Model | null = null

export function resetSim(model: Model | null): void {
  engine = model === null ? null : new Simulator(model)
  engineModel = model
  useSim.setState({ frames: [], cursor: null })
}

/** Advance `ticks` engine steps on `model` (rebuilding the engine if the model changed). */
export function stepSim(model: Model, ticks: number): void {
  if (engine === null || engineModel !== model) {
    // A model edit restarts the simulation from zero (the topology changed).
    engine = new Simulator(model)
    engineModel = model
    useSim.setState({ frames: [] })
  }
  const sc = useSim.getState().scenario
  const out: Frame[] = []
  for (let i = 0; i < ticks; i++) out.push(engine.step(sc))
  useSim.setState((s) => {
    const frames = s.frames.length + out.length > HISTORY_MAX ? [...s.frames, ...out].slice(-HISTORY_MAX) : [...s.frames, ...out]
    return { frames }
  })
}

export function currentFrame(s: SimState): Frame | null {
  if (s.frames.length === 0) return null
  return s.cursor === null ? (s.frames.at(-1) ?? null) : (s.frames[Math.min(s.cursor, s.frames.length - 1)] ?? null)
}

export function simTime(): number {
  return engine?.time ?? 0
}

export function setScenario(patch: Partial<Scenario>): void {
  useSim.setState((s) => ({ scenario: { ...s.scenario, ...patch } }))
}

let faultSeq = 0
export function addFault(f: Omit<Fault, 'id' | 'from'> & { from?: number }): void {
  const fault: Fault = { ...f, id: `f${++faultSeq}`, from: f.from ?? simTime() }
  setScenario({ faults: [...useSim.getState().scenario.faults, fault] })
}

export function endFault(id: string): void {
  const t = simTime()
  setScenario({ faults: useSim.getState().scenario.faults.map((f) => (f.id === id && (f.until === null || f.until > t) ? { ...f, until: t } : f)) })
}

export function removeFault(id: string): void {
  setScenario({ faults: useSim.getState().scenario.faults.filter((f) => f.id !== id) })
}

export { TICK_SEC }
