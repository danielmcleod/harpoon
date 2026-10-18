// Drives the simulator while Traffic Simulator mode is on and playing: real time × speed → engine ticks. Flow traces
// advance one step per second of their own.
import { useEffect } from 'react'
import { useStore } from '../state/store.ts'
import { TICK_SEC, stepSim, useSim } from './simStore.ts'

export function useSimLoop(active: boolean): void {
  const model = useStore((s) => s.project?.model)
  useEffect(() => {
    if (!active || model === undefined) return
    let raf = 0
    let last = performance.now()
    let carry = 0
    let traceCarry = 0
    const loop = (now: number): void => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const s = useSim.getState()
      if (s.playing && s.cursor === null) {
        carry += dt * s.speed
        const ticks = Math.floor(carry / TICK_SEC)
        if (ticks > 0) {
          carry -= ticks * TICK_SEC
          stepSim(model, Math.min(ticks, 40))
        }
      }
      const tr = s.trace
      if (tr !== null && tr.playing) {
        traceCarry += dt
        if (traceCarry >= 1.1) {
          traceCarry = 0
          const flow = useStore.getState().project?.model.flows[tr.flowId]
          const n = flow?.steps.length ?? 0
          useSim.setState({ trace: tr.step + 1 >= n ? { ...tr, playing: false } : { ...tr, step: tr.step + 1 } })
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, model])
}
