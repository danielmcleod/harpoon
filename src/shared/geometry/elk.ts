// ELK's layered algorithm, run synchronously. elkjs normally answers through a (fake) Web Worker and a promise; here
// its in-process worker's dispatcher is called directly, so the same code lays out a level in Node (core, tests) and
// in the renderer, and callers such as Tidy and the AI's placement stay synchronous.
import * as elkModule from 'elkjs/lib/elk-worker.min.js'
import type { ElkMessage, Worker as ElkWorker } from 'elkjs/lib/elk-worker.min.js'
import type { Point } from './hex.ts'

export interface ElkBox {
  id: string
  width: number
  height: number
}

let worker: ElkWorker | null = null
let reply: ElkMessage | null = null
let seq = 0

function send(data: Record<string, unknown>): unknown {
  if (worker === null) {
    // Node hands back module.exports as the default export, bundlers honour __esModule: accept either shape.
    const ns = elkModule as unknown as { Worker?: typeof ElkWorker; default?: typeof ElkWorker | { Worker?: typeof ElkWorker } }
    const W = ns.Worker ?? (typeof ns.default === 'function' ? ns.default : ns.default?.Worker)
    if (W === undefined) throw new Error('elkjs worker not found')
    worker = new W()
    worker.onmessage = (e) => {
      reply = e.data
    }
    send({ cmd: 'register', algorithms: ['layered'] })
  }
  reply = null
  const id = ++seq
  worker.dispatcher.saveDispatch({ data: { ...data, id } })
  const r = reply as ElkMessage | null
  if (r === null || r.id !== id) throw new Error('elkjs did not answer')
  if (r.error !== undefined) throw r.error instanceof Error ? r.error : new Error(`elkjs failed: ${JSON.stringify(r.error)}`)
  return r.data
}

/**
 * Layered layout (callers left, callees right): the centre of each box. Edges are [source, target] pairs of box ids;
 * ones naming unknown boxes are dropped.
 */
export function elkLayered(boxes: readonly ElkBox[], edges: readonly (readonly [string, string])[], spacing: { node: number; layer: number }): Map<string, Point> {
  const ids = new Set(boxes.map((b) => b.id))
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(spacing.node),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.layer),
      'elk.spacing.componentComponent': String(spacing.node),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: boxes.map((b) => ({ id: b.id, width: b.width, height: b.height })),
    edges: edges.filter(([s, t]) => ids.has(s) && ids.has(t) && s !== t).map(([s, t], i) => ({ id: `e${i}`, sources: [s], targets: [t] })),
  }
  const out = send({ cmd: 'layout', graph, layoutOptions: {}, options: {} }) as { children?: { id: string; x?: number; y?: number; width: number; height: number }[] }
  const pos = new Map<string, Point>()
  for (const c of out.children ?? []) pos.set(c.id, { x: (c.x ?? 0) + c.width / 2, y: (c.y ?? 0) + c.height / 2 })
  return pos
}
