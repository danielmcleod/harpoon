// A single-series time chart for the simulator panel: one measure per chart (never two y-scales), a 2px line with a
// soft area, a recessive baseline and max label, and a crosshair tooltip on hover.
import { useMemo, useRef, useState } from 'react'

export interface SparklineProps {
  label: string
  values: readonly number[]
  times: readonly number[]
  color: string
  format: (v: number) => string
  height?: number
}

const W = 320

export function Sparkline({ label, values, times, color, format, height = 64 }: SparklineProps): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const { path, area, max } = useMemo(() => {
    const max = Math.max(1e-9, ...values) * 1.15
    const n = values.length
    const x = (i: number): number => (n <= 1 ? W : (i / (n - 1)) * W)
    const y = (v: number): number => height - 4 - (v / max) * (height - 12)
    let path = ''
    values.forEach((v, i) => {
      path += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    })
    const area = n > 0 ? `${path}L${W},${height - 4}L0,${height - 4}Z` : ''
    return { path, area, max }
  }, [values, height])
  const last = values.at(-1)
  const hi = hover !== null ? values[hover] : undefined
  const hx = hover !== null && values.length > 1 ? (hover / (values.length - 1)) * W : 0

  return (
    <figure className="rounded-lg border bg-background/60 p-2">
      <figcaption className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-xs font-semibold tabular-nums">{last === undefined ? '—' : format(hi ?? last)}</span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        className="h-16 w-full overflow-visible"
        role="img"
        aria-label={`${label} over the last ${Math.round((times.at(-1) ?? 0) - (times[0] ?? 0))} simulated seconds`}
        onPointerMove={(e) => {
          const r = ref.current?.getBoundingClientRect()
          if (r === undefined || values.length === 0) return
          const i = Math.round(((e.clientX - r.left) / r.width) * (values.length - 1))
          setHover(Math.max(0, Math.min(values.length - 1, i)))
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={0} x2={W} y1={height - 4} y2={height - 4} stroke="var(--border)" strokeWidth={1} />
        <text x={2} y={9} fontSize={9} fill="var(--muted-foreground)">
          {format(max / 1.15)}
        </text>
        {area !== '' && <path d={area} fill={color} opacity={0.12} />}
        {path !== '' && <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {hover !== null && hi !== undefined && (
          <>
            <line x1={hx} x2={hx} y1={4} y2={height - 4} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            <circle cx={hx} cy={height - 4 - (hi / max) * (height - 12)} r={3.5} fill={color} stroke="var(--background)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {hover !== null && times[hover] !== undefined && <div className="mt-0.5 text-right font-mono text-[10px] text-muted-foreground">t = {times[hover]?.toFixed(1)}s</div>}
    </figure>
  )
}
