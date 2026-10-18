// Left panel: the architecture tree over the palette.
import { ArchitectureTree } from './ArchitectureTree.tsx'
import { Palette } from './Palette.tsx'
import { useStore } from '../state/store.ts'

export function LeftPanel(): React.JSX.Element {
  const editable = useStore((s) => s.ui.mode === 'edit')
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-panel">
      <ArchitectureTree />
      {editable && <Palette />}
    </aside>
  )
}
