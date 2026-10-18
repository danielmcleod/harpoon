// Saved simulator scenarios (`.harpoon/scenarios/`): load, traffic and faults together, so a failure drill can be
// replayed in a review or a presentation.
import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SavedScenario } from '@shared/ipc.ts'
import { uniqueId } from '@shared/model/ids.ts'
import { Button } from '../components/ui/Button.tsx'
import { invoke } from '../ipc/client.ts'
import { isViewer } from '../lib/viewer.ts'
import { toast } from '../state/actions.ts'
import { resetSim, useSim } from './simStore.ts'
import { useStore } from '../state/store.ts'

export function ScenarioBar(): React.JSX.Element | null {
  const [items, setItems] = useState<SavedScenario[]>([])
  const [name, setName] = useState('')
  const root = useStore((s) => s.project?.root)

  useEffect(() => {
    if (root === undefined) return
    void invoke('collection.list', { kind: 'scenarios' }).then((r) => r.ok && setItems(r.value as SavedScenario[]))
  }, [root])

  if (isViewer()) return null
  const save = async (): Promise<void> => {
    const n = name.trim()
    if (n === '') return
    const sc = useSim.getState().scenario
    const existing = items.find((x) => x.name === n)
    const item: SavedScenario = { id: existing?.id ?? uniqueId(n, (x) => items.some((i) => i.id === x)), name: n, multiplier: sc.multiplier, profile: sc.profile, faults: sc.faults }
    const r = await invoke('collection.put', { kind: 'scenarios', item })
    if (!r.ok) return toast(r.error.message, 'error')
    setItems((xs) => [...xs.filter((x) => x.id !== item.id), item])
    setName('')
    toast(`Saved scenario “${n}”.`)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {items.length > 0 && (
        <select
          aria-label="Load a scenario"
          value=""
          onChange={(e) => {
            const s = items.find((x) => x.id === e.target.value)
            if (s === undefined) return
            useSim.setState({ scenario: { multiplier: s.multiplier, profile: s.profile, faults: s.faults } })
            resetSim(useStore.getState().project?.model ?? null)
            toast(`Loaded “${s.name}”. Press play to run it from the start.`)
          }}
          className="h-7 rounded-md border bg-background px-1 text-xs"
        >
          <option value="">Load a saved scenario…</option>
          {items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name" className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring" />
        <Button size="sm" variant="outline" icon={<Save />} disabled={name.trim() === ''} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}
