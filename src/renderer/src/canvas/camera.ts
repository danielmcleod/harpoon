// The canvas camera, reachable from outside React Flow (saving and replaying views). The canvas registers its
// instance on mount.
export interface Camera {
  x: number
  y: number
  zoom: number
}

interface CameraHost {
  get(): Camera
  set(c: Camera, durationMs: number): void
}

let host: CameraHost | null = null

export function registerCamera(h: CameraHost | null): void {
  host = h
}

export function getCamera(): Camera | null {
  return host?.get() ?? null
}

export function setCamera(c: Camera, durationMs = 600): void {
  host?.set(c, durationMs)
}
