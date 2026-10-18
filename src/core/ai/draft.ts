// An AI run's draft: the model as it was when the run started, plus the ops the agent has staged through Harpoon's
// MCP tools. Nothing touches the live project until a person accepts the resulting proposal.
import { coordKey, nearestFreeCell } from '../../shared/geometry/hex.ts'
import { compareModels, diffModels } from '../../shared/model/diff.ts'
import type { ChangeSummary } from '../../shared/model/diff.ts'
import { slugify, uniqueId } from '../../shared/model/ids.ts'
import { applyOps } from '../../shared/model/ops.ts'
import type { Op } from '../../shared/model/ops.ts'
import type { HexCoord, Model } from '../../shared/model/schema.ts'

export class DraftError extends Error {}

export class Draft {
  readonly base: Model
  #model: Model
  #ops: Op[] = []
  /** Nodes added without a placement hint: re-placed next to their connections when the run finishes. */
  readonly #unplaced = new Set<string>()

  constructor(base: Model) {
    this.base = base
    this.#model = base
  }

  get model(): Model {
    return this.#model
  }

  get ops(): readonly Op[] {
    return this.#ops
  }

  summary(): ChangeSummary {
    return compareModels(this.base, this.#model)
  }

  /** Apply ops to the draft; a refusal throws DraftError with the model's own message (the agent reads it). */
  apply(ops: Op[]): void {
    try {
      this.#model = applyOps(this.#model, ops).model
    } catch (err) {
      throw new DraftError(err instanceof Error ? err.message : String(err))
    }
    this.#ops.push(...ops)
  }

  /** A node id from an id or an exact (case-insensitive) name; throws when unknown or ambiguous. */
  nodeRef(ref: string, what = 'node'): string {
    if (this.#model.nodes[ref] !== undefined) return ref
    const want = ref.trim().toLowerCase()
    const byName = Object.values(this.#model.nodes).filter((n) => n.name.toLowerCase() === want || n.id === slugify(ref))
    if (byName.length === 1 && byName[0] !== undefined) return byName[0].id
    if (byName.length > 1) throw new DraftError(`"${ref}" matches several nodes (${byName.map((n) => n.id).join(', ')}); use an id.`)
    throw new DraftError(`Unknown ${what} "${ref}". Call get_overview or search to find ids.`)
  }

  connectorRef(ref: string): string {
    if (this.#model.connectors[ref] !== undefined) return ref
    throw new DraftError(`Unknown connector "${ref}".`)
  }

  newNodeId(name: string, wanted?: string): string {
    const taken = (x: string): boolean => this.#model.nodes[x] !== undefined
    if (wanted !== undefined && wanted !== '') {
      const id = slugify(wanted, 80)
      if (taken(id)) throw new DraftError(`A node "${id}" already exists; pick another id or update it instead.`)
      return id
    }
    return uniqueId(name, taken)
  }

  newConnectorId(source: string, target: string, wanted?: string): string {
    const taken = (x: string): boolean => this.#model.connectors[x] !== undefined
    if (wanted !== undefined && wanted !== '') {
      const id = slugify(wanted, 80)
      if (taken(id)) throw new DraftError(`A connector "${id}" already exists.`)
      return id
    }
    return uniqueId(`${source}-${target}`, taken)
  }

  /** A free grid cell for a new node in `parentId`, next to `near` when it is a sibling. */
  cellFor(parentId: string | null, near: string | null): { at: HexCoord; placed: boolean } {
    const m = this.#model
    const taken = new Set(
      Object.values(m.nodes)
        .filter((n) => n.parentId === parentId)
        .map((n) => m.layout[n.id])
        .filter((c): c is HexCoord => c !== undefined)
        .map(coordKey),
    )
    const nearNode = near === null ? undefined : m.nodes[near]
    const origin = nearNode !== undefined && nearNode.parentId === parentId ? (m.layout[nearNode.id] ?? { q: 0, r: 0 }) : { q: 0, r: 0 }
    return { at: nearestFreeCell(origin, (c) => taken.has(coordKey(c))), placed: nearNode !== undefined }
  }

  markUnplaced(id: string): void {
    this.#unplaced.add(id)
  }

  /**
   * Move nodes that were added without a hint next to the siblings they connect to (the agent never gives
   * coordinates, and existing nodes never move).
   */
  settlePlacement(): void {
    const ops: Op[] = []
    for (const id of this.#unplaced) {
      const m = this.#model
      const n = m.nodes[id]
      if (n === undefined) continue
      const partners = Object.values(m.connectors)
        .flatMap((c) => (c.source === id ? [c.target] : c.target === id ? [c.source] : []))
        .map((p) => m.nodes[p])
        .filter((p) => p !== undefined && p.parentId === n.parentId && m.layout[p.id] !== undefined)
      if (partners.length === 0) continue
      const cells = partners.map((p) => m.layout[p?.id ?? ''] as HexCoord)
      const avg = { q: Math.round(cells.reduce((s, c) => s + c.q, 0) / cells.length), r: Math.round(cells.reduce((s, c) => s + c.r, 0) / cells.length) }
      const taken = new Set(
        Object.values(m.nodes)
          .filter((x) => x.parentId === n.parentId && x.id !== id)
          .map((x) => m.layout[x.id])
          .filter((c): c is HexCoord => c !== undefined)
          .map(coordKey),
      )
      const at = nearestFreeCell(avg, (c) => taken.has(coordKey(c)))
      ops.push({ op: 'setLayout', id, at })
      this.#model = applyOps(this.#model, [{ op: 'setLayout', id, at }]).model
    }
    this.#unplaced.clear()
    this.#ops.push(...ops)
  }

  /** The net change (base → draft) as ops, ready to apply on the live model: intermediate churn folds away. */
  proposalOps(): Op[] {
    return diffModels(this.base, this.#model)
  }
}

/**
 * A draft that forwards to whichever draft is current (solutions mode keeps one draft per option and the tools work
 * on the active one). Methods are bound to the real draft so its private state works.
 */
export function switchableDraft(current: () => Draft): Draft {
  return new Proxy({} as Draft, {
    get(_t, key) {
      const d = current()
      const v: unknown = Reflect.get(d, key, d)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v
    },
  })
}
