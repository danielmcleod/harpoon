// window.harpoon, as the preload exposes it; included by the web and E2E tsconfigs.
import type { HarpoonApi } from '../shared/ipc.ts'

declare global {
  interface Window {
    harpoon: HarpoonApi
  }
}

export {}
