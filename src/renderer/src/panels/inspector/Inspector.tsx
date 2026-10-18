// The right panel: whatever is selected (service, connector, boundary, several nodes) or the project overview.
// A selected feature opens a second column with its technical contract (master/detail).
import { useStore } from '../../state/store.ts'
import { useModel } from '../../canvas/useScene.ts'
import { BoundaryInspector } from './BoundaryInspector.tsx'
import { ConnectorInspector } from './ConnectorInspector.tsx'
import { FeatureDetail } from './FeatureDetail.tsx'
import { MultiInspector } from './MultiInspector.tsx'
import { NodeInspector } from './NodeInspector.tsx'
import { ProjectOverview } from './ProjectOverview.tsx'

export function Inspector(): React.JSX.Element {
  const model = useModel()
  const sel = useStore((s) => s.ui.selection)
  const featureId = useStore((s) => s.ui.featureId)
  const readOnly = useStore((s) => s.ui.mode !== 'edit')

  const nodeId = sel?.kind === 'node' && sel.ids.length === 1 ? sel.ids[0] : undefined
  const node = nodeId !== undefined ? model.nodes[nodeId] : undefined
  const feature = node !== undefined && featureId !== null ? node.features.find((f) => f.id === featureId) : undefined

  let body: React.JSX.Element
  if (sel === null) body = <ProjectOverview readOnly={readOnly} />
  else if (sel.kind === 'node' && sel.ids.length > 1) body = <MultiInspector ids={sel.ids} readOnly={readOnly} />
  else if (node !== undefined) body = <NodeInspector node={node} readOnly={readOnly} />
  else if (sel.kind === 'connector') body = <ConnectorInspector ids={sel.ids} readOnly={readOnly} />
  else if (sel.kind === 'boundary' && sel.ids[0] !== undefined) body = <BoundaryInspector id={sel.ids[0]} readOnly={readOnly} />
  else body = <ProjectOverview readOnly={readOnly} />

  return (
    <aside className="flex shrink-0 border-l bg-panel">
      <div className="scroll-region w-[360px] overflow-y-auto">{body}</div>
      {node !== undefined && feature !== undefined && (
        <div className="scroll-region w-[340px] overflow-y-auto border-l">
          <FeatureDetail node={node} feature={feature} readOnly={readOnly} />
        </div>
      )}
    </aside>
  )
}
