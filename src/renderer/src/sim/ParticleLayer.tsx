// Traffic particles: dots moving along each harpoon (requests on channel A, responses back on channel B), drawn on
// one canvas over the React Flow viewport. Density follows requests per second, speed follows latency, colour
// follows health. Positions come from the same harpoon geometry as the edges, so dots ride exactly on the lines.
import { useStore as useFlowStore } from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'
import { harpoonGeometry, pointAlong } from '@shared/geometry/harpoon.ts'
import type { HarpoonLine } from '@shared/geometry/harpoon.ts'
import { ISO_SQUASH } from '@shared/geometry/hex.ts'
import type { Scene } from '@shared/geometry/scene.ts'
import { protocolFamily } from '@shared/model/kinds.ts'
import { currentFrame, useSim } from './simStore.ts'

interface Track {
  ids: string[]
  target: string
  a: HarpoonLine
  b: HarpoonLine | null
  family: ReturnType<typeof protocolFamily>
  async: boolean
}

const FAMILY_VAR: Record<Track['family'], string> = { http: '--hx-cyan', rpc: '--hx-violet', stream: '--hx-amber', data: '--hx-blue', other: '--hx-edge' }

export function ParticleLayer({ scene }: { scene: Scene }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const transform = useFlowStore((s) => s.transform)
  const tRef = useRef(transform)
  tRef.current = transform

  const tracks = useMemo<Track[]>(() => {
    const out: Track[] = []
    for (const e of scene.edges) {
      const s = scene.nodes.get(e.source)
      const t = scene.nodes.get(e.target)
      const first = e.connectors[0]
      if (s === undefined || t === undefined || first === undefined) continue
      const sq = (expanded: boolean): number => (scene.style === 'iso' && !expanded ? ISO_SQUASH : 1)
      const g = harpoonGeometry({ center: s.center, r: s.r, squash: sq(s.expanded) }, { center: t.center, r: t.r, squash: sq(t.expanded) }, { duplex: first.duplex })
      out.push({ ids: e.connectors.map((c) => c.id), target: e.target, a: g.a, b: g.b, family: protocolFamily(first.channelA.protocol), async: first.sync === 'async' })
    }
    return out
  }, [scene])

  useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const css = getComputedStyle(document.documentElement)
    const colorOf = (v: string): string => css.getPropertyValue(v).trim() || '#7dd3fc'
    const colors = {
      ok: Object.fromEntries(Object.entries(FAMILY_VAR).map(([k, v]) => [k, colorOf(v)])) as Record<Track['family'], string>,
      warn: colorOf('--hx-warn'),
      bad: colorOf('--hx-bad'),
    }
    let raf = 0
    const start = performance.now()
    const draw = (now: number): void => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const sim = useSim.getState()
      const frame = currentFrame(sim)
      if (frame !== null) {
        const [tx, ty, zoom] = tRef.current
        // Paused: dots stop where they are; playing: they flow at the simulation speed.
        const time = sim.playing && sim.cursor === null ? ((now - start) / 1000) * Math.max(0.25, Math.min(sim.speed, 4)) : frame.t
        const r = Math.max(1.4, Math.min(3.2, 2.4 * zoom))
        for (const tr of tracks) {
          let rps = 0
          let health: 'ok' | 'warn' | 'bad' = 'ok'
          const latency = frame.nodes[tr.target]?.latencyMs ?? 0
          for (const id of tr.ids) {
            const e = frame.edges[id]
            if (e === undefined) continue
            rps += e.rps
            if (e.health === 'bad' || (e.health === 'warn' && health === 'ok')) health = e.health
          }
          if (rps <= 0.01) continue
          const count = Math.max(1, Math.min(14, Math.round(Math.log2(1 + rps) * 1.2)))
          const speed = 0.55 / (1 + latency / 200)
          const color = health === 'ok' ? colors.ok[tr.family] : colors[health]
          ctx.fillStyle = color
          ctx.shadowColor = color
          ctx.shadowBlur = 6
          const lines: HarpoonLine[] = tr.b !== null && !tr.async ? [tr.a, tr.b] : [tr.a]
          lines.forEach((line, li) => {
            for (let i = 0; i < count; i++) {
              const t = (time * speed + i / count + li * 0.37) % 1
              const p = pointAlong(line, t)
              ctx.beginPath()
              ctx.arc(p.x * zoom + tx, p.y * zoom + ty, li === 0 ? r : r * 0.8, 0, Math.PI * 2)
              ctx.fill()
            }
          })
        }
        ctx.shadowBlur = 0
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [tracks])

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 z-[4] h-full w-full" />
}
