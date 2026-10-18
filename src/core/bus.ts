// The core's event bus: handlers and long-running jobs (AI runs, ingest) emit AppEvents; main's push sink batches
// them to the renderer, the CLI prints them, tests collect them.
import type { AppEvent } from '../shared/ipc.ts'

export type BusListener = (e: AppEvent) => void

export class EventBus {
  readonly #listeners = new Set<BusListener>()

  on(l: BusListener): () => void {
    this.#listeners.add(l)
    return () => this.#listeners.delete(l)
  }

  emit(e: AppEvent): void {
    for (const l of [...this.#listeners]) {
      try {
        l(e)
      } catch {
        // a broken listener never stops the others
      }
    }
  }
}
