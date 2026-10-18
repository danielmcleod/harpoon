// The hex canvas (React Flow). The model and view state produce a scene (shared/geometry/scene.ts); the scene becomes
// React Flow nodes and edges. Dragging, dropping from the palette and drawing connectors turn into ops on drop, so
// the model stays the only source of truth.
import { useRoadmap } from './RoadmapBar.tsx'
import { dataScope } from '@shared/model/governance.ts'
import { computeLens } from './lensMarks.ts'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import type { Node, NodeChange, OnConnectStartParams } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NODE_KINDS } from '@shared/model/schema.ts'
import type { NodeKind } from '@shared/model/schema.ts'
import { cancelConnect, completeConnect, edit, focus, select, startConnect, toggleExpanded } from '../state/actions.ts'
import { setUi, useStore } from '../state/store.ts'
import { useShortcut } from '../lib/keys.ts'
import { cn } from '../lib/cn.ts'
import { nodeBox } from './box.ts'
import { buildFlow } from './build.ts'
import { ContainerNode } from './ContainerNode.tsx'
import { cellAt, containerAt, moveOps, newConnectorOps, newNodeOps } from './edits.ts'
import { HarpoonEdge } from './HarpoonEdge.tsx'
import { HexNode } from './HexNode.tsx'
import type { HexFlowNode } from './types.ts'
import { useHighlight, useImpact, useModel, useScene } from './useScene.ts'
import { useReview } from './useReview.ts'
import { ZoneNode } from './ZoneNode.tsx'
import type { ZoneFlowNode } from './ZoneNode.tsx'
import type { CanvasOverlays } from './overlays.ts'
import { NodeMenu } from './NodeMenu.tsx'
import { registerCamera } from './camera.ts'
import { ParticleLayer } from '../sim/ParticleLayer.tsx'
import type { MenuState } from './NodeMenu.tsx'

const nodeTypes = { hex: HexNode, container: ContainerNode, zone: ZoneNode }
const edgeTypes = { harpoon: HarpoonEdge }

export const KIND_MIME = 'application/x-harpoon-kind'

type AnyNode = HexFlowNode | ZoneFlowNode

export function Canvas({ overlays, children }: { overlays?: CanvasOverlays; children?: React.ReactNode }): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner {...(overlays !== undefined ? { overlays } : {})}>{children}</CanvasInner>
    </ReactFlowProvider>
  )
}

function CanvasInner({ overlays, children }: { overlays?: CanvasOverlays; children?: React.ReactNode }): React.JSX.Element {
  const storeModel = useModel()
  const review = useReview()
  const roadmap = useRoadmap()
  // While a change is under review the canvas shows the proposed model (removed things kept, drawn red); with a
  // roadmap phase picked, the architecture at the end of that phase.
  const model = review?.model ?? roadmap?.model ?? storeModel
  const scene = useScene(model)
  const highlight = useHighlight(model)
  const impact = useImpact(model)
  const lensState = useStore((s) => s.ui.lens)
  const scope = useMemo(() => dataScope(model), [model])
  const lens = useMemo(() => (lensState === null ? null : { marks: computeLens(model, lensState.kind, scope).marks, hidden: new Set(lensState.hidden) }), [model, lensState, scope])
  const style = useStore((s) => s.prefs.nodeStyle)
  const mode = useStore((s) => s.ui.mode)
  const selection = useStore((s) => s.ui.selection)
  const fitNonce = useStore((s) => s.ui.fitNonce)
  const centerReq = useStore((s) => s.ui.centerOn)
  const resolvedTheme = useStore((s) => s.theme.resolved)
  const connectMode = useStore((s) => s.ui.connectFrom !== null)
  // C: connect from the selected node (a single key, so only while the canvas has focus).
  useShortcut('c', () => {
    const sel = useStore.getState().ui.selection
    if (sel?.kind === 'node' && sel.ids[0] !== undefined && editable) startConnect(sel.ids[0])
  }, { scope: 'canvas' })
  const editable = mode === 'edit' && overlays?.diff == null && review === null && roadmap === null
  const rf = useReactFlow<AnyNode>()
  useEffect(() => {
    registerCamera({ get: () => rf.getViewport(), set: (c, duration) => void rf.setViewport(c, { duration }) })
    return () => registerCamera(null)
  }, [rf])

  const built = useMemo(() => {
    const sel = (k: 'node' | 'connector' | 'boundary'): Set<string> => new Set(selection?.kind === k ? selection.ids : [])
    return buildFlow({
      model,
      scene,
      style,
      editable,
      selectedNodes: sel('node'),
      selectedConnectors: sel('connector'),
      selectedBoundaries: sel('boundary'),
      highlight: overlays?.highlight ?? highlight,
      diff: review?.summary ?? overlays?.diff ?? roadmap?.summary ?? null,
      health: overlays?.health ?? null,
      edgeHealth: overlays?.edgeHealth ?? null,
      emphasisConnectors: overlays?.emphasis ?? null,
      impact,
      lens,
    })
  }, [model, scene, style, editable, selection, highlight, overlays, review, roadmap, impact, lens])

  // Local copy so dragging moves nodes smoothly; replaced whenever the scene changes.
  const [nodes, setNodes] = useState<AnyNode[]>(built.nodes)
  useEffect(() => setNodes(built.nodes), [built.nodes])

  const onNodesChange = useCallback((changes: NodeChange<AnyNode>[]) => {
    // Selection is ours (store); only positions and sizes flow back into the local copy.
    const kept = changes.filter((c) => c.type === 'position' || c.type === 'dimensions')
    if (kept.length > 0) setNodes((ns) => applyNodeChanges(kept, ns))
  }, [])

  // Starting a review shows the proposed change in full.
  const reviewing = review !== null
  useEffect(() => {
    if (reviewing) setUi((ui) => ({ fitNonce: ui.fitNonce + 1 }))
  }, [reviewing])

  // Fit on open / focus change, once the new node set is on screen.
  const pendingFit = useRef(true)
  useEffect(() => {
    pendingFit.current = true
  }, [fitNonce])
  useEffect(() => {
    if (!pendingFit.current) return
    const t = setTimeout(() => {
      pendingFit.current = false
      void rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1.2 })
    }, 80)
    return () => clearTimeout(t)
  }, [nodes, fitNonce, rf])

  useEffect(() => {
    if (centerReq === null) return
    const n = rf.getInternalNode(centerReq.id)
    if (n === undefined) return
    const d = n.data as HexFlowNode['data']
    const box = nodeBox(d.r, d.style, d.expanded)
    const p = n.internals.positionAbsolute
    void rf.setCenter(p.x + box.center.x, p.y + box.center.y, { zoom: Math.max(rf.getZoom(), 0.9), duration: 350 })
  }, [centerReq, rf])

  const centerOfNode = useCallback(
    (id: string) => {
      const n = rf.getInternalNode(id)
      if (n === undefined || n.type === 'zone') return null
      const d = n.data as HexFlowNode['data']
      const box = nodeBox(d.r, d.style, d.expanded)
      const p = n.internals.positionAbsolute
      return { x: p.x + box.center.x, y: p.y + box.center.y }
    },
    [rf],
  )

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: Node, dragged: Node[]) => {
      const ids = new Set(dragged.map((d) => d.id))
      // A node dragged along with its container keeps its place inside it.
      const roots = dragged.filter((d) => {
        let p = model.nodes[d.id]?.parentId ?? null
        while (p !== null) {
          if (ids.has(p)) return false
          p = model.nodes[p]?.parentId ?? null
        }
        return true
      })
      const moves = roots.flatMap((d) => {
        const c = centerOfNode(d.id)
        return c === null ? [] : [{ id: d.id, center: c }]
      })
      const ops = moveOps(model, scene, moves)
      if (!edit(ops, { label: moves.length > 1 ? `move ${moves.length} nodes` : 'move' })) setNodes(built.nodes)
    },
    [model, scene, centerOfNode, built.nodes],
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const connectFrom = useRef<string | null>(null)
  const onConnectStart = useCallback((_e: unknown, p: OnConnectStartParams) => {
    connectFrom.current = p.nodeId
  }, [])
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent) => {
      const source = connectFrom.current
      connectFrom.current = null
      if (source === null) return
      const pt = 'changedTouches' in e ? e.changedTouches[0] : e
      if (pt === undefined) return
      const el = document
        .elementsFromPoint(pt.clientX, pt.clientY)
        .map((x) => x.closest<HTMLElement>('[data-node-id]'))
        .find((x) => x !== null && x.dataset['nodeId'] !== source)
      const target = el?.dataset['nodeId']
      if (target === undefined) return
      const made = newConnectorOps(model, source, target)
      if (made !== null && edit(made.ops, { label: 'connect' })) select({ kind: 'connector', ids: [made.id] })
    },
    [model],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const kind = e.dataTransfer.getData(KIND_MIME) as NodeKind
      if (!(NODE_KINDS as readonly string[]).includes(kind) || !editable) return
      e.preventDefault()
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const { parentId, origin } = containerAt(scene, p)
      const at = cellAt(model, scene, p, parentId, origin)
      const made = newNodeOps(model, kind, parentId, at)
      if (edit(made.ops)) select({ kind: 'node', ids: [made.id] })
    },
    [rf, scene, model, editable],
  )

  return (
    <div data-key-scope="canvas" className={cn('@container relative h-full w-full bg-canvas', connectMode && 'hx-connecting')} onDragOver={(e) => editable && e.dataTransfer.types.includes(KIND_MIME) && e.preventDefault()} onDrop={onDrop}>
      <ReactFlow<AnyNode>
        nodes={nodes}
        edges={built.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(e, n) => {
          if (n.type === 'zone') return
          if (useStore.getState().ui.connectFrom !== null) {
            const d = n.data
            if (!d.ghost && completeConnect(n.id)) return
            if (useStore.getState().ui.connectFrom === n.id) return
          }
          const sel = useStore.getState().ui.selection
          if ((e.shiftKey || e.metaKey || e.ctrlKey) && sel?.kind === 'node') {
            const ids = sel.ids.includes(n.id) ? sel.ids.filter((x) => x !== n.id) : [...sel.ids, n.id]
            select(ids.length > 0 ? { kind: 'node', ids } : null)
          } else select({ kind: 'node', ids: [n.id] })
        }}
        onNodeDoubleClick={(_e, n) => {
          const d = n.data as HexFlowNode['data']
          if (n.type === 'zone') return
          if (d.ghost) focus(d.node.parentId)
          else toggleExpanded(n.id)
        }}
        onEdgeClick={(_e, edge) => {
          const ids = (edge.data as { connectors: { id: string }[] } | undefined)?.connectors.map((c) => c.id) ?? []
          select(ids.length > 0 ? { kind: 'connector', ids } : null)
        }}
        onPaneClick={() => (useStore.getState().ui.connectFrom !== null ? cancelConnect() : select(null))}
        onNodeContextMenu={(e, n) => {
          if (n.type === 'zone' || (n.data).ghost) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id })
        }}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        selectNodesOnDrag={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        colorMode={resolvedTheme}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--canvas-dot)" />
        {overlays?.particles === true && <ParticleLayer scene={scene} />}
        {children}
      </ReactFlow>
      {menu !== null && <NodeMenu menu={menu} onClose={closeMenu} />}
    </div>
  )
}
