// The 3D view's orbit camera and its perspective projection. World: x right, y up, z towards the viewer; decks lie in
// the x/z plane. The camera looks at `target` from `dist` away, turned by `yaw` around the vertical and lifted by
// `pitch` above the horizon (it never goes under a deck).

export interface Cam {
  tx: number
  ty: number
  tz: number
  yaw: number
  pitch: number
  dist: number
}

export const MIN_PITCH = 0.16
export const MAX_PITCH = 1.48
export const MIN_DIST = 220
export const MAX_DIST = 16_000
/** Vertical field of view. */
const FOV = (38 * Math.PI) / 180
const NEAR = 24

export interface View {
  w: number
  h: number
  /** Focal length in px: a world unit `d` away from the camera is f / d px. */
  f: number
  // Camera position and its right / up / forward unit vectors.
  px: number
  py: number
  pz: number
  rx: number
  rz: number
  ux: number
  uy: number
  uz: number
  fx: number
  fy: number
  fz: number
}

export interface Projected {
  x: number
  y: number
  /** Distance along the view direction (bigger: further away). */
  depth: number
  /** Px per world unit at that depth. */
  scale: number
}

export function viewOf(c: Cam, w: number, h: number): View {
  const sy = Math.sin(c.yaw)
  const cy = Math.cos(c.yaw)
  const sp = Math.sin(c.pitch)
  const cp = Math.cos(c.pitch)
  return {
    w,
    h,
    f: h / 2 / Math.tan(FOV / 2),
    px: c.tx + c.dist * cp * sy,
    py: c.ty + c.dist * sp,
    pz: c.tz + c.dist * cp * cy,
    rx: cy,
    rz: -sy,
    ux: -sy * sp,
    uy: cp,
    uz: -cy * sp,
    fx: -cp * sy,
    fy: -sp,
    fz: -cp * cy,
  }
}

/** A world point on screen, or null when it is behind the camera. */
export function project(v: View, x: number, y: number, z: number): Projected | null {
  const dx = x - v.px
  const dy = y - v.py
  const dz = z - v.pz
  const depth = dx * v.fx + dy * v.fy + dz * v.fz
  if (depth < NEAR) return null
  const scale = v.f / depth
  return {
    x: v.w / 2 + (dx * v.rx + dz * v.rz) * scale,
    y: v.h / 2 - (dx * v.ux + dy * v.uy + dz * v.uz) * scale,
    depth,
    scale,
  }
}

/** The distance from which a disc of `radius` on the ground fills the view comfortably. */
export function fitDistance(radius: number, w: number, h: number): number {
  const aspect = h === 0 ? 1 : w / h
  return clamp((radius * 1.02) / (Math.tan(FOV / 2) * Math.min(1, aspect)), MIN_DIST, MAX_DIST)
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Move `cur` towards `goal` by `k` (0..1); true once it has arrived. */
export function approach(cur: Cam, goal: Cam, k: number): boolean {
  let done = true
  for (const key of ['tx', 'ty', 'tz', 'yaw', 'pitch', 'dist'] as const) {
    const d = goal[key] - cur[key]
    const eps = key === 'yaw' || key === 'pitch' ? 0.0006 : 0.4
    if (Math.abs(d) < eps) cur[key] = goal[key]
    else {
      cur[key] += d * k
      done = false
    }
  }
  return done
}
