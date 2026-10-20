// The project workspace: top bar, left panel (architecture tree + palette), the canvas, and the right panel
// (inspector, or the simulation panel in traffic mode). Global shortcuts live here.
import { ViewRail } from './ViewRail.tsx'
import { NotesView } from '../notes/NotesView.tsx'
import { DecisionsView } from '../records/DecisionsView.tsx'
import { RoadmapBoard } from '../roadmap/RoadmapBoard.tsx'
import { TablesView } from '../tables/TablesView.tsx'
import { cn } from '../lib/cn.ts'
import { ProjectSettings } from '../settings/ProjectSettings.tsx'
import { useEffect, useMemo } from 'react'
import type { CanvasOverlays } from '../canvas/overlays.ts'
import { useNotes } from '../notes/notesStore.ts'
import { AiPanel } from '../ai/AiPanel.tsx'
import { Canvas } from '../canvas/Canvas.tsx'
import { CanvasChrome } from '../canvas/CanvasChrome.tsx'
import { registerShortcut, KEYS } from '../lib/keys.ts'
import { Inspector } from '../panels/inspector/Inspector.tsx'
import { LeftPanel } from '../panels/LeftPanel.tsx'
import { deleteSelection } from '../panels/selectionOps.ts'
import { focus, redo, select, setMode, undo } from '../state/actions.ts'
import { getState, setUi, useStore } from '../state/store.ts'
import { invoke } from '../ipc/client.ts'
import { SimPanel } from '../sim/SimPanel.tsx'
import { Timeline } from '../sim/Timeline.tsx'
import { useSimLoop } from '../sim/useSimLoop.ts'
import { useSimOverlays } from '../sim/useSimOverlays.ts'
import { TopBar } from './TopBar.tsx'
import { PresentationBar } from '../present/PresentationBar.tsx'
import { usePresent } from '../present/presentStore.ts'
import { useFlowOverlays } from '../canvas/useFlowOverlays.ts'

export function Workspace(): React.JSX.Element {
  const leftCollapsed = useStore((s) => s.ui.leftCollapsed)
  const rightCollapsed = useStore((s) => s.ui.rightCollapsed)
  const aiOpen = useStore((s) => s.ui.aiOpen)
  const simMode = useStore((s) => s.ui.mode === 'sim')
  useSimLoop(simMode)
  const simOverlays = useSimOverlays(simMode)
  const flowOverlays = useFlowOverlays(!simMode)
  const presenting = usePresent((s) => s.presenting)
  const notesOn = useStore((s) => s.ui.view === 'notes' && s.ui.mode !== 'sim')
  const notesDiagram = useStore((s) => s.ui.notesDiagram)
  const notesInspector = useStore((s) => s.ui.notesInspector)
  const mentioned = useNotes((s) => s.mentioned)
  // Beside a note, the diagram marks what the note mentions.
  const notesOverlays = useMemo<CanvasOverlays | undefined>(() => {
    if (!notesOn) return undefined
    return { ...flowOverlays, marks: new Map(mentioned.map((id) => [id, { label: '@', tone: 'info' as const, title: 'Mentioned in this note' }])) }
  }, [notesOn, flowOverlays, mentioned])
  const overlays = simOverlays ?? notesOverlays ?? flowOverlays
  const view = useStore((s) => s.ui.view)
  // The simulator and presentations run on the diagram.
  const board = !simMode && !presenting && view === 'roadmap'
  const decisionsView = !simMode && !presenting && view === 'decisions'
  const notesView = !simMode && !presenting && view === 'notes'
  const showTables = !simMode && !presenting && (view === 'tables' || view === 'split')
  const showCanvas = !board && !decisionsView && !notesView && (!showTables || view === 'split')

  useEffect(() => {
    const offs = [
      registerShortcut(KEYS.undo, () => void undo(), { allowInInputs: false }),
      registerShortcut(KEYS.redo, () => void redo(), { allowInInputs: false }),
      registerShortcut(KEYS.redoAlt, () => void redo(), { allowInInputs: false }),
      registerShortcut(KEYS.save, () => void invoke('project.save')),
      registerShortcut(KEYS.toggleMode, () => setMode(getState().ui.mode === 'edit' ? 'docs' : 'edit')),
      registerShortcut('delete', () => deleteSelection(), { allowInInputs: false }),
      registerShortcut('backspace', () => {
        const ui = getState().ui
        if (ui.selection !== null && ui.mode === 'edit') deleteSelection()
        else if (ui.focusId !== null) focus(getState().project?.model.nodes[ui.focusId]?.parentId ?? null)
      }, { allowInInputs: false }),
      registerShortcut('escape', () => {
        const ui = getState().ui
        if (ui.connectFrom !== null) setUi({ connectFrom: null })
        else if (ui.blast !== null) setUi({ blast: null })
        else if (ui.search !== '') setUi({ search: '' })
        else select(null)
      }, { allowInInputs: false }),
      registerShortcut(KEYS.ai, () => setUi((ui) => ({ aiOpen: !ui.aiOpen }))),
      registerShortcut(KEYS.focusNode, () => {
        const sel = getState().ui.selection
        if (sel?.kind === 'node' && sel.ids[0] !== undefined) focus(sel.ids[0])
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  return (
    <div className="flex h-full flex-col">
      {!presenting && <TopBar />}
      <div className="flex min-h-0 flex-1">
        {!presenting && <ViewRail />}
        {/* Notes need the room for the note and the diagram, not the tree and palette. */}
        {!leftCollapsed && !presenting && !notesView && <LeftPanel />}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {showCanvas && (
            <div className={cn('relative min-h-0', showTables ? 'basis-[56%]' : 'flex-1')}>
              <Canvas {...(overlays !== undefined ? { overlays } : {})}>
                {!presenting && <CanvasChrome />}
                {simMode && !presenting && <Timeline />}
              </Canvas>
            </div>
          )}
          {board && <RoadmapBoard />}
          {decisionsView && <DecisionsView />}
          {notesView && (
            <div className="flex min-h-0 flex-1">
              <div className={cn('min-w-0', notesDiagram ? 'min-w-[540px] flex-[5]' : 'flex-1')}>
                <NotesView />
              </div>
              {notesDiagram && (
                <div className="relative min-w-[320px] flex-[6] border-l">
                  <Canvas {...(overlays !== undefined ? { overlays } : {})}>
                    <CanvasChrome />
                  </Canvas>
                </div>
              )}
            </div>
          )}
          {showTables && (
            <div className={cn('min-h-0', showCanvas ? 'basis-[44%] border-t' : 'flex-1')}>
              <TablesView />
            </div>
          )}
          {presenting && <PresentationBar />}
        </main>
        {/* One right-hand panel at a time: the AI assistant or the inspector. */}
        {/* In notes the inspector opens only on request (the right-panel button), so the note and diagram keep the room. */}
        {presenting ? null : aiOpen ? <AiPanel /> : simMode ? <SimPanel /> : (notesView ? notesInspector : !rightCollapsed) && <Inspector />}
      </div>
      <ProjectSettings />
    </div>
  )
}
