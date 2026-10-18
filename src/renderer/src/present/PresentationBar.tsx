// While presenting: the slide title and speaker notes, position, previous/next, and keys (←/→, PageUp/PageDown,
// space, Esc to stop).
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '../components/ui/Button.tsx'
import { slides, stepPresentation, stopPresentation, usePresent } from './presentStore.ts'

export function PresentationBar(): React.JSX.Element | null {
  const views = usePresent(slides)
  const index = usePresent((s) => s.index)
  const v = views[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        stepPresentation(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        stepPresentation(-1)
      } else if (e.key === 'Escape') stopPresentation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (v === undefined) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-6">
      <div className="pointer-events-auto flex max-w-3xl items-center gap-3 rounded-2xl border bg-popover/95 px-4 py-3 shadow-2xl backdrop-blur">
        <Button variant="ghost" size="icon" aria-label="Previous" disabled={index === 0} onClick={() => stepPresentation(-1)}>
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{v.name}</div>
          {v.notes.trim() !== '' && <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted-foreground">{v.notes}</p>}
        </div>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {index + 1} / {views.length}
        </span>
        <Button variant="ghost" size="icon" aria-label="Next" disabled={index >= views.length - 1} onClick={() => stepPresentation(1)}>
          <ChevronRight />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Stop presenting" onClick={stopPresentation}>
          <X />
        </Button>
      </div>
    </div>
  )
}
