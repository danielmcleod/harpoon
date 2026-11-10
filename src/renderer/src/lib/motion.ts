// Reduced motion: the CSS covers transitions and keyframes; camera glides and the traffic particles ask here.

/** The system asks for less motion. */
export function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** A camera animation's duration: none when the system asks for less motion. */
export function glide(ms: number): number {
  return reducedMotion() ? 0 : ms
}
