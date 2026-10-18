// Views menu in the top bar: save the current view (focus, expanded nodes, flow, blast radius, camera), jump to a
// saved one, reorder, and start the presentation.
import { DropdownMenu } from 'radix-ui'
import { ArrowDown, ArrowUp, Bookmark, ChevronDown, Milestone, Presentation, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button.tsx'
import { isViewer } from '../lib/viewer.ts'
import { useStore } from '../state/store.ts'
import { applyView, deleteView, loadViews, moveView, saveCurrentView, startPresentation, startRoadmapPresentation, usePresent } from './presentStore.ts'

export function PresentButton(): React.JSX.Element {
  const views = usePresent((s) => s.views)
  const root = useStore((s) => s.project?.root)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const viewer = isViewer()
  const phaseCount = useStore((s) => s.project?.model.meta.phases.length ?? 0)

  useEffect(() => {
    if (root !== undefined) void loadViews()
  }, [root])

  return (
    <div className="flex items-center">
      <Button size="sm" variant="outline" icon={<Presentation />} className="rounded-r-none" onClick={() => startPresentation(0)} title="Present the saved views" aria-label="Present">
        <span className="hidden xl:inline">Present</span>
      </Button>
      <DropdownMenu.Root onOpenChange={(o) => !o && setNaming(false)}>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="outline" className="rounded-l-none border-l-0 px-1.5" aria-label="Views">
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-72 rounded-lg border bg-popover p-1 text-sm shadow-lg">
            <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Views</DropdownMenu.Label>
            {views.length === 0 && <p className="px-2 pb-2 text-xs text-muted-foreground">Set up the canvas (open a service, expand nodes, pick a flow), then save it as a view. Views become presentation slides.</p>}
            {views.map((v, i) => (
              <div key={v.id} className="group flex items-center gap-1 rounded-md px-1 hover:bg-accent">
                <DropdownMenu.Item onSelect={() => applyView(v)} className="flex min-w-0 flex-1 cursor-default items-center gap-2 px-1 py-1.5 outline-none">
                  <span className="w-4 text-right text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
                  <Bookmark className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{v.name}</span>
                </DropdownMenu.Item>
                {!viewer && (
                  <span className="hidden items-center group-hover:flex">
                    <button type="button" aria-label="Move up" onClick={() => void moveView(v.id, -1)} className="p-0.5 text-muted-foreground hover:text-foreground">
                      <ArrowUp className="size-3" />
                    </button>
                    <button type="button" aria-label="Move down" onClick={() => void moveView(v.id, 1)} className="p-0.5 text-muted-foreground hover:text-foreground">
                      <ArrowDown className="size-3" />
                    </button>
                    <button type="button" aria-label="Delete view" onClick={() => void deleteView(v.id)} className="p-0.5 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                )}
              </div>
            ))}
            {phaseCount > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={() => startRoadmapPresentation()}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent"
                >
                  <Milestone className="size-4 text-muted-foreground" />
                  Present the roadmap, phase by phase
                </DropdownMenu.Item>
              </>
            )}
            {!viewer && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                {naming ? (
                  <form
                    className="flex flex-col gap-1.5 p-1.5"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (name.trim() === '') return
                      void saveCurrentView(name.trim(), notes)
                      setName('')
                      setNotes('')
                      setNaming(false)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name (slide title)" className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:border-ring" />
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Speaker notes (optional)" className="rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-ring" />
                    <Button size="sm" type="submit">
                      Save view
                    </Button>
                  </form>
                ) : (
                  <DropdownMenu.Item
                    onSelect={(e) => {
                      e.preventDefault()
                      setNaming(true)
                    }}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent"
                  >
                    <Bookmark className="size-4 text-muted-foreground" />
                    Save current view…
                  </DropdownMenu.Item>
                )}
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}
