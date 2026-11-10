// The Time Machine's bar: the commits that changed the project (a slider, oldest on the left), Today, then each
// roadmap phase. Picking a commit shows the architecture as it was committed, with what that commit added, changed
// and removed marked like a diff; picking a phase shows it as it will be at the end of that phase. Play steps
// through all of it. Read-only anywhere but Today.
import { ChevronLeft, ChevronRight, History, Pause, Play } from 'lucide-react'
import { useEffect } from 'react'
import { summaryCounts } from '@shared/model/diff.ts'
import { phasesInOrder } from '@shared/model/governance.ts'
import { cn } from '../lib/cn.ts'
import { isViewer } from '../lib/viewer.ts'
import { useStore } from '../state/store.ts'
import { goCommit, goPhase, goToday, loadHistory, useProjection, useTime } from './timeStore.ts'

/** How long each step stays on screen while playing. */
const STEP_MS = 1300

const day = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function TimeBar(): React.JSX.Element | null {
  const root = useStore((s) => s.project?.root)
  const model = useStore((s) => s.project?.model)
  const asOf = useStore((s) => s.ui.asOf)
  const commits = useTime((s) => s.commits)
  const at = useTime((s) => s.at)
  const pending = useTime((s) => s.pending)
  const playing = useTime((s) => s.playing)
  const unreadable = useTime((s) => {
    const snap = s.at === null ? undefined : s.snapshots[s.at]
    return snap !== undefined && 'error' in snap ? snap.error : null
  })
  const projection = useProjection()
  const viewer = isViewer()

  // An exported view has no repository behind it.
  useEffect(() => {
    if (root !== undefined && !viewer) void loadHistory(root)
  }, [root, viewer])

  const phases = model === undefined ? [] : phasesInOrder(model.meta)
  const n = commits.length
  // One sequence: every commit, today, every phase.
  const last = n + phases.length
  const phaseAt = phases.findIndex((p) => p.id === asOf)
  // The commit being read counts as where we are, so quick steps add up instead of repeating the same one.
  const commitAt = commits.findIndex((c) => c.sha === (pending ?? at))
  const pos = phaseAt >= 0 ? n + 1 + phaseAt : commitAt >= 0 ? commitAt : n
  const go = async (i: number): Promise<void> => {
    const to = Math.max(0, Math.min(last, i))
    const commit = commits[to]
    const phase = phases[to - n - 1]
    if (commit !== undefined) await goCommit(commit.sha)
    else if (phase !== undefined) goPhase(phase.id)
    else goToday()
  }
  const step = (i: number): void => {
    useTime.setState({ playing: false })
    void go(i)
  }

  // Playing: one step at a time, each shown for a moment once it has loaded; it stops at the end of the line.
  useEffect(() => {
    if (!playing) return
    if (pos >= last) {
      useTime.setState({ playing: false })
      return
    }
    const t = window.setTimeout(() => void go(pos + 1), STEP_MS)
    return () => window.clearTimeout(t)
    // `go` is rebuilt every render from the same inputs as `pos` and `last`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, pos, last])

  if (model === undefined || last === 0) return null

  const commit = commits[commitAt]
  const phase = phases[phaseAt]
  const counts = projection === null ? null : summaryCounts(projection.summary)
  const btn = 'rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30'
  const pill = (on: boolean, before: boolean): string =>
    cn(
      'rounded-md px-2 py-0.5 whitespace-nowrap',
      on
        ? 'bg-primary text-primary-foreground'
        : before
          ? 'text-foreground hover:bg-accent'
          : 'text-muted-foreground hover:bg-accent',
    )
  return (
    <div
      className="flex flex-col items-center gap-1"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {(commit !== undefined || phase !== undefined) && (
        <div className="max-w-[min(680px,90vw)] rounded-md border bg-popover/95 px-2.5 py-1 text-center text-[11px] text-muted-foreground shadow-sm">
          {commit !== undefined ? (
            <>
              <strong className="text-foreground">{day(commit.at)}</strong>
              {commit.author !== '' && ` · ${commit.author}`} ·{' '}
              <span className="text-foreground">
                {commit.subject === '' ? commit.sha.slice(0, 7) : commit.subject}
              </span>
              {unreadable !== null ? (
                <span className="text-[var(--hx-del)]"> · could not be read: {unreadable}</span>
              ) : (
                counts !== null && (
                  <>
                    : <span className="text-[var(--hx-add)]">{counts.added} new</span>,{' '}
                    <span className="text-[var(--hx-mod)]">{counts.modified} changed</span>,{' '}
                    <span className="text-[var(--hx-del)]">{counts.removed} removed</span>
                  </>
                )
              )}
              . Read-only; pick Today to edit.
            </>
          ) : (
            phase !== undefined && (
              <>
                End of <strong className="text-foreground">{phase.name}</strong>
                {phase.target !== null && ` (${phase.target})`}
                {counts !== null && (
                  <>
                    : <span className="text-[var(--hx-add)]">{counts.added} new</span>,{' '}
                    <span className="text-[var(--hx-del)]">{counts.removed} retired</span>
                  </>
                )}
                . Read-only; pick Today to edit.
              </>
            )
          )}
        </div>
      )}
      <div
        role="group"
        aria-label="Time: history, today and roadmap"
        className="flex items-center gap-0.5 rounded-lg border bg-popover/95 p-0.5 text-xs shadow-md backdrop-blur"
      >
        <History
          aria-hidden
          className={cn(
            'mx-1 size-3.5',
            pending !== null ? 'animate-pulse text-primary' : 'text-muted-foreground',
          )}
        />
        <button
          type="button"
          aria-label="One step back in time"
          title="One step back"
          disabled={pos === 0}
          onClick={() => step(pos - 1)}
          className={btn}
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play through time'}
          title={playing ? 'Pause' : 'Play: step through the history, today and the roadmap'}
          onClick={() => {
            if (playing) useTime.setState({ playing: false })
            else {
              // From the end, play starts over at the beginning.
              void (pos >= last ? go(0) : Promise.resolve()).then(() => useTime.setState({ playing: true }))
            }
          }}
          className={btn}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        {n > 0 && (
          <input
            type="range"
            aria-label="Commit shown"
            aria-valuetext={commit === undefined ? 'Today' : `${day(commit.at)}: ${commit.subject}`}
            title={`${n} commit${n === 1 ? '' : 's'} changed this project: drag back through them`}
            min={0}
            max={n}
            step={1}
            value={Math.min(pos, n)}
            onChange={(e) => step(Number(e.target.value))}
            className="mx-1 h-1 cursor-pointer accent-[var(--primary)]"
            style={{ width: Math.max(96, Math.min(300, n * 9)) }}
          />
        )}
        <button
          type="button"
          aria-pressed={pos === n}
          title="The architecture as it is (planned work dotted)"
          onClick={() => step(n)}
          className={pill(pos === n, pos > n)}
        >
          Today
        </button>
        {phases.map((p, i) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={pos === n + 1 + i}
            title={`${p.name}${p.target !== null ? `, target ${p.target}` : ''}: as it will be at the end of this phase`}
            onClick={() => step(n + 1 + i)}
            className={pill(pos === n + 1 + i, pos > n + 1 + i)}
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          aria-label="One step forward in time"
          title="One step forward"
          disabled={pos === last}
          onClick={() => step(pos + 1)}
          className={btn}
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
