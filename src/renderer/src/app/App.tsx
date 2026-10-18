// The app shell: boots the store, routes push events into it, and shows the welcome screen or the workspace.
import { useEffect } from 'react'
import { Tooltip } from 'radix-ui'
import { subscribeEvents } from '../ipc/client.ts'
import { boot, handleEvents } from '../state/actions.ts'
import { useStore } from '../state/store.ts'
import { HelpDialog } from '../help/HelpDialog.tsx'
import { Toasts } from './Toasts.tsx'
import { Welcome } from './Welcome.tsx'
import { Workspace } from './Workspace.tsx'

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const hasProject = useStore((s) => s.project !== null)

  useEffect(() => {
    const off = subscribeEvents(handleEvents)
    void boot()
    return off
  }, [])

  return (
    <Tooltip.Provider delayDuration={350}>
      <div className="h-full bg-background text-foreground">
        {!ready ? null : hasProject ? <Workspace /> : <Welcome />}
      </div>
      {ready && <HelpDialog />}
      <Toasts />
    </Tooltip.Provider>
  )
}
