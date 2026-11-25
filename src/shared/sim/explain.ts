// Why the simulation is failing, in words: each failing node's causes (engine.ts records them per tick), walked back
// to where the trouble starts. A root cause is a node with trouble of its own (down, overloaded, an injected fault)
// or a link that is cut or refusing calls; everything that fails only because of a root is a knock-on.
import type { Model } from '../model/schema.ts'
import type { EdgeCause, Frame, Health, NodeCause } from './engine.ts'

/** Something a reason points at, so the UI can select it. */
export type Ref = { kind: 'node' | 'connector'; id: string }

export interface Reason {
  text: string
  ref?: Ref
}

export interface RootCause {
  /** `n:<node id>` or `c:<connector id>`. */
  key: string
  ref: Ref
  name: string
  health: Health
  reasons: Reason[]
  /** Failing nodes that fail because of this (not counting itself). */
  affects: string[]
}

export interface KnockOn {
  nodeId: string
  name: string
  health: Health
  reasons: Reason[]
  /** Root cause keys. */
  roots: string[]
}

export interface FailureReport {
  roots: RootCause[]
  knockOn: KnockOn[]
}

const OWN: ReadonlySet<NodeCause['kind']> = new Set(['down', 'capacity', 'ratelimit', 'slow', 'errors', 'overload', 'own-errors', 'backlog'])
const LINK_ROOT: ReadonlySet<EdgeCause['kind']> = new Set(['partition', 'breaker', 'timeout'])

const pct = (v: number): string => `${Math.round(v * 100)}%`
const rps = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k rps` : `${Math.round(v)} rps`)
const ms = (v: number): string => `${Math.round(v)} ms`

function nodeName(m: Model, id: string): string {
  return m.nodes[id]?.name ?? id
}

export function linkName(m: Model, id: string): string {
  const c = m.connectors[id]
  return c === undefined ? id : `${nodeName(m, c.source)} → ${nodeName(m, c.target)}`
}

const LOST: Record<string, string> = { down: 'crashed', instance: 'lost an instance', zone: 'zone outage', region: 'region outage' }

/** The node a cause's injected fault sits on, when that is a container rather than the node that suffers it. */
function faultOn(c: NodeCause): string | undefined {
  return 'fault' in c ? c.fault : undefined
}

/** Where a node's own trouble starts: the node a fault was injected on, else the unit that runs it. */
function ownRoot(c: NodeCause, nodeId: string): string {
  return faultOn(c) ?? ('at' in c ? c.at : nodeId)
}

/** One of a node's causes in words. */
export function describeNodeCause(m: Model, nodeId: string, c: NodeCause, f?: Frame): Reason {
  const on = faultOn(c)
  const elsewhere = on !== undefined && on !== nodeId ? on : 'at' in c && c.at !== nodeId ? c.at : undefined
  const via = elsewhere === undefined ? '' : elsewhere === on ? ` (injected on ${nodeName(m, elsewhere)}, which it is inside)` : ` (on ${nodeName(m, elsewhere)}, which runs it)`
  const at: Ref | undefined = elsewhere === undefined ? undefined : { kind: 'node', id: elsewhere }
  const injected = via === '' ? ' (injected fault)' : via
  const r = (text: string, ref?: Ref): Reason => (ref === undefined ? { text } : { text, ref })
  switch (c.kind) {
    case 'down':
      return r(`Down: ${c.by.map((b) => LOST[b] ?? b).join(', ') || 'no capacity left'}${injected}`, at)
    case 'capacity':
      return r(`Running on ${pct(c.left)} of its capacity: ${c.by.map((b) => LOST[b] ?? b).join(', ')}${injected}`, at)
    case 'ratelimit':
      return r(`Rate-limited to ${rps(c.cap)}${injected}`, at)
    case 'slow':
      return r(`Slowed ×${c.factor}${injected}`, at)
    case 'errors':
      return r(`Error burst: ${pct(c.rate)} of requests fail${injected}`, at)
    case 'overload':
      return c.dropped > 0
        ? r(`Overloaded: ${rps(c.rps)} arriving for ${rps(c.capacity)} of capacity, turning away ${pct(c.dropped)}${via}`, at)
        : r(`Near capacity: ${pct(c.util)} used (${rps(c.rps)} of ${rps(c.capacity)}), so it slows down${via}`, at)
    case 'own-errors':
      return r(`Its own error rate is set to ${pct(c.rate)} (Simulation settings)${via}`, at)
    case 'backlog':
      return r(`${Math.round(c.messages).toLocaleString()} messages waiting: its consumers cannot keep up`)
    case 'dependency': {
      const link = f?.edges[c.connector]?.causes?.find((x) => LINK_ROOT.has(x.kind))
      const how = link === undefined ? `fails ${pct(c.errorRate)}` : describeEdgeCause(m, link).toLowerCase()
      return r(`Waits on ${nodeName(m, c.node)}: ${how}`, { kind: 'node', id: c.node })
    }
    case 'calls':
      return r(`The calls of ${nodeName(m, c.node)} (the service it is part of) fail ${pct(c.errorRate)}`, { kind: 'node', id: c.node })
    case 'inner':
      return r(`A part inside it fails: ${nodeName(m, c.node)} (${pct(c.errorRate)})`, { kind: 'node', id: c.node })
  }
}

/** One of a connector's causes in words. */
export function describeEdgeCause(_m: Model, c: EdgeCause): string {
  switch (c.kind) {
    case 'partition':
      return 'Cut off by a network partition (injected fault)'
    case 'breaker':
      return 'Circuit breaker open: calls are refused until it retries'
    case 'timeout':
      return `Calls time out: the callee answers in ${ms(c.latencyMs)}, past the ${ms(c.timeoutMs)} timeout`
    case 'callee':
      return `The callee fails ${pct(c.errorRate)}`
    case 'retries':
      return `Retries multiply calls ×${c.factor.toFixed(1)} into a failing callee (retry storm)`
  }
}

/** Where a node's trouble starts: root cause keys (empty when it has none). */
function rootsOf(f: Frame, id: string, seen: Set<string>): Set<string> {
  const out = new Set<string>()
  if (seen.has(id)) return out
  seen.add(id)
  for (const c of f.nodes[id]?.causes ?? []) {
    if (OWN.has(c.kind)) out.add(`n:${ownRoot(c, id)}`)
    else if (c.kind === 'dependency') {
      const link = f.edges[c.connector]?.causes ?? []
      if (link.some((x) => x.kind === 'partition')) {
        out.add(`c:${c.connector}`)
        continue
      }
      const sub = rootsOf(f, c.node, seen)
      // A breaker still open or a timeout with nothing wrong behind it: the link is where it starts.
      if (sub.size === 0 && link.some((x) => LINK_ROOT.has(x.kind))) out.add(`c:${c.connector}`)
      for (const k of sub) out.add(k)
    } else if (c.kind === 'calls' || c.kind === 'inner') {
      for (const k of rootsOf(f, c.node, seen)) out.add(k)
    }
  }
  return out
}

const RANK: Record<Health, number> = { ok: 0, warn: 1, bad: 2 }

/** What is strained or failing in a frame, split into root causes and knock-on failures. */
export function failureReport(m: Model, f: Frame): FailureReport {
  const failing = Object.entries(f.nodes).filter(([id, n]) => n.health !== 'ok' && m.nodes[id] !== undefined)
  const rootsBy = new Map<string, Set<string>>()
  for (const [id] of failing) {
    const rs = rootsOf(f, id, new Set())
    // Failing with nothing recorded to explain it: count it as its own root.
    rootsBy.set(id, rs.size > 0 ? rs : new Set([`n:${id}`]))
  }
  const rootKeys = new Set([...rootsBy.values()].flatMap((s) => [...s]))
  const roots: RootCause[] = [...rootKeys].map((key) => {
    const id = key.slice(2)
    if (key.startsWith('c:')) {
      const e = f.edges[id]
      return {
        key,
        ref: { kind: 'connector', id },
        name: linkName(m, id),
        health: e?.health ?? 'bad',
        reasons: (e?.causes ?? []).filter((x) => x.kind !== 'callee').map((x) => ({ text: describeEdgeCause(m, x) })),
        affects: [...rootsBy].filter(([, s]) => s.has(key)).map(([n]) => n),
      }
    }
    const nf = f.nodes[id]
    let own = (nf?.causes ?? []).filter((c) => OWN.has(c.kind) && ownRoot(c, id) === id)
    // A fault on a container with no capacity of its own: say it from what it does to the parts inside.
    if (own.length === 0) {
      const seen = new Set<string>()
      own = Object.values(f.nodes)
        .flatMap((n) => n.causes ?? [])
        .filter((c) => OWN.has(c.kind) && faultOn(c) === id)
        .map((c) => ({ ...c, at: id }) as NodeCause)
        .filter((c) => !seen.has(c.kind) && (seen.add(c.kind), true))
    }
    return {
      key,
      ref: { kind: 'node', id },
      name: nodeName(m, id),
      health: nf?.health ?? 'ok',
      reasons: own.length > 0 ? own.map((c) => describeNodeCause(m, id, c, f)) : [{ text: 'No cause recorded' }],
      affects: [...rootsBy].filter(([n, s]) => n !== id && s.has(key)).map(([n]) => n),
    }
  })
  roots.sort((a, b) => RANK[b.health] - RANK[a.health] || b.affects.length - a.affects.length || a.name.localeCompare(b.name))
  const knockOn: KnockOn[] = failing
    .filter(([id]) => !rootKeys.has(`n:${id}`))
    .map(([id, n]) => ({
      nodeId: id,
      name: nodeName(m, id),
      health: n.health,
      reasons: (n.causes ?? []).map((c) => describeNodeCause(m, id, c, f)),
      roots: [...(rootsBy.get(id) ?? [])],
    }))
    .sort((a, b) => RANK[b.health] - RANK[a.health] || a.name.localeCompare(b.name))
  return { roots, knockOn }
}

/** A node's state and why, in a few lines (canvas tooltips); null while it is healthy. */
export function nodeWhy(m: Model, f: Frame, id: string): string | null {
  const nf = f.nodes[id]
  if (nf === undefined || m.nodes[id] === undefined) return null
  if (nf.forced === true) return `${nodeName(m, id)}: forced healthy\nIt serves everything and passes no failure on.`
  if (nf.health === 'ok') return null
  const lines = [`${nodeName(m, id)}: ${nf.health === 'bad' ? 'failing' : 'strained'}, ${pct(nf.errorRate)} errors`]
  for (const c of nf.causes ?? []) lines.push(`• ${describeNodeCause(m, id, c, f).text}`)
  if ((nf.causes ?? []).length === 0) lines.push('• No cause recorded')
  const roots = [...rootsOf(f, id, new Set())].filter((k) => k !== `n:${id}`)
  if (roots.length > 0) lines.push(`Root cause: ${roots.map((k) => (k.startsWith('c:') ? linkName(m, k.slice(2)) : nodeName(m, k.slice(2)))).join(', ')}`)
  return lines.join('\n')
}

/** The report as plain text (for the AI, or copying). */
export function failureText(m: Model, f: Frame): string {
  const r = failureReport(m, f)
  if (r.roots.length === 0) return 'Nothing is strained or failing.'
  const rootName = new Map(r.roots.map((x) => [x.key, x.name]))
  const lines = [`At ${f.t.toFixed(1)} s: throughput ${rps(f.throughput)}, errors ${pct(f.errorRate)}, latency ${ms(f.latencyMs)}.`, '', 'Root causes:']
  for (const x of r.roots) lines.push(`- ${x.name} (${x.ref.kind} ${x.ref.id}, ${x.health === 'bad' ? 'failing' : 'strained'}): ${x.reasons.map((y) => y.text).join('; ')}${x.affects.length > 0 ? `. Takes ${x.affects.length} more with it.` : ''}`)
  if (r.knockOn.length > 0) {
    lines.push('', 'Knock-on failures:')
    for (const x of r.knockOn) lines.push(`- ${x.name} (node ${x.nodeId}): ${x.reasons.map((y) => y.text).join('; ')} [root: ${x.roots.map((k) => rootName.get(k) ?? k).join(', ')}]`)
  }
  return lines.join('\n')
}
