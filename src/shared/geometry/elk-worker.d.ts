// elkjs ships its in-process worker as plain CommonJS without a matching declaration file.
declare module 'elkjs/lib/elk-worker.min.js' {
  export interface ElkMessage {
    id: number
    data?: unknown
    error?: unknown
  }
  export class Worker {
    dispatcher: { saveDispatch(m: { data: unknown }): void }
    onmessage: (e: { data: ElkMessage }) => void
  }
  const mod: { Worker?: typeof Worker; default?: typeof Worker | { Worker?: typeof Worker } }
  export default mod
}
