// When things went bad in a recording: the frames where some node starts failing after a stretch with none (the first
// one is where it first went bad). Whether a frame has a failing node is worked out once per frame.
import type { Frame } from './engine.ts'

const failing = new WeakMap<Frame, boolean>()

/** Whether any node is failing in this frame (forced-healthy ones never are). */
export function hasFailure(f: Frame): boolean {
  let v = failing.get(f)
  if (v === undefined) {
    v = Object.values(f.nodes).some((n) => n.health === 'bad')
    failing.set(f, v)
  }
  return v
}

/** Indices of the frames where failure starts (at most `max`, earliest first). */
export function failureOnsets(frames: readonly Frame[], max = 12): number[] {
  const out: number[] = []
  let before = false
  for (let i = 0; i < frames.length && out.length < max; i++) {
    const f = frames[i]
    if (f === undefined) continue
    const now = hasFailure(f)
    if (now && !before) out.push(i)
    before = now
  }
  return out
}
