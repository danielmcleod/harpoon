// The exported HTML viewer runs the same renderer read-only; components hide authoring and app-only controls.
export function isViewer(): boolean {
  return (window as unknown as { __HARPOON_VIEWER__?: boolean }).__HARPOON_VIEWER__ === true
}
