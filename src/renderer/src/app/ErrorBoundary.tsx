// The last line of defence: an exception while rendering (or in an effect) would otherwise unmount the whole app and
// leave a blank window. Shows what went wrong with a way back, and writes it to main's log. Uncaught errors and
// rejected promises outside React are logged too.
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { logToMain } from '../ipc/client.ts'

const describe = (err: unknown): { message: string; stack?: string } =>
  err instanceof Error
    ? { message: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) }
    : { message: String(err) }

/** Log what nothing caught (once, at startup). */
export function installErrorLogging(): void {
  window.addEventListener('error', (e) =>
    logToMain('error', 'renderer: uncaught error', {
      ...describe(e.error ?? e.message),
      at: `${e.filename}:${e.lineno}`,
    }),
  )
  window.addEventListener('unhandledrejection', (e) =>
    logToMain('error', 'renderer: unhandled rejection', describe(e.reason)),
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(err: unknown): { error: Error } {
    return { error: err instanceof Error ? err : new Error(String(err)) }
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    logToMain('error', 'renderer: render failed', {
      ...describe(err),
      componentStack: info.componentStack ?? '',
    })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div role="alert" className="flex h-full items-center justify-center bg-background p-8 text-foreground">
        <div className="w-full max-w-lg rounded-xl border bg-card p-5">
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Harpoon hit an error it could not recover from on its own. Your project is saved as you work, so
            reloading is safe.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap selectable">
            {error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => window.location.reload()}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="h-8 rounded-md border px-3 text-sm hover:bg-accent"
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    )
  }
}
