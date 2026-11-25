// The exported HTML viewer runs the same renderer read-only; components hide authoring and app-only controls.
export function isViewer(): boolean {
  return (window as unknown as { __HARPOON_VIEWER__?: boolean }).__HARPOON_VIEWER__ === true
}

/**
 * Whether to offer AI actions (and the fixes they make) in this mode: never in the exported viewer, which is read-only
 * and has no AI, and not while reading in Docs mode.
 */
export function offersAi(mode: string): boolean {
  return mode !== 'docs' && !isViewer()
}
