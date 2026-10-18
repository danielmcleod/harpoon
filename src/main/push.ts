// Push sink: core bus events → batched `harpoon:evt` sends to the main window (one send per animation-frame-ish
// window, so a burst of AI stream deltas costs one IPC message). Events emitted while the window is gone are dropped;
// the renderer refetches state on load.
import type { WebContents } from 'electron'
import type { AppEvent } from '@shared/ipc.ts'
import { EVT_CHANNEL } from '@shared/ipc.ts'

export const PUSH_INTERVAL_MS = 24

export class PushSink {
  #queue: AppEvent[] = []
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #target: () => WebContents | null

  constructor(target: () => WebContents | null) {
    this.#target = target
  }

  push(e: AppEvent): void {
    this.#queue.push(e)
    this.#timer ??= setTimeout(() => this.flush(), PUSH_INTERVAL_MS)
  }

  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const batch = this.#queue
    this.#queue = []
    const wc = this.#target()
    if (batch.length === 0 || wc === null || wc.isDestroyed()) return
    wc.send(EVT_CHANNEL, batch)
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#queue = []
  }
}
