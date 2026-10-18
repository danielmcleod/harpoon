// One private `codex app-server --listen stdio://` and its JSON-RPC peer (JsonRpcPeer with `header:'omit'`):
// spawn, the initialize → initialized handshake, close. Shared by a pass,
// the probe handshake and vendorSetup. Never the shared daemon.
import { setTimeout as delay } from 'node:timers/promises'
import { stopChild } from '../../proc/kill.ts'
import { JsonRpcError, JsonRpcPeer, JsonRpcPeerError } from '../../proc/jsonrpc.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle, SpawnLabel, TapFn } from '../../proc/spawn.ts'
import { INITIALIZE_TIMEOUT_MS } from './capabilities.ts'
import { initializeParams } from './params.ts'
import { isCollaborationModeRejected, isUnknownMethodError } from './protocol.ts'
import type { Rec } from './wire.ts'
import { rec } from './wire.ts'

export interface AppServerSpawn {
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs'>
  /** `appServerArgv(...)`: root `-c` extraArgs, then `app-server --listen stdio://`. */
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  label: SpawnLabel
  tap?: TapFn | undefined
}

export class AppServer {
  readonly child: ChildHandle
  readonly peer: JsonRpcPeer

  private constructor(child: ChildHandle) {
    this.child = child
    this.peer = JsonRpcPeer.fromChild(child, { header: 'omit' })
  }

  /** Spawns the process (SpawnError on failure). The peer starts reading stdout at once. */
  static async spawn(o: AppServerSpawn): Promise<AppServer> {
    const child = await spawnChild({
      cli: o.cli,
      args: o.args,
      cwd: o.cwd,
      env: o.env,
      label: o.label,
      ...(o.tap !== undefined ? { tap: o.tap } : {}),
    })
    return new AppServer(child)
  }

  /** `initialize` (bounded: a silent CLI has drifted), then the `initialized` notification. */
  async initialize(experimentalApi: boolean, timeoutMs = INITIALIZE_TIMEOUT_MS): Promise<Rec> {
    const result = await this.peer.request('initialize', initializeParams(experimentalApi), {
      timeoutMs,
      retry: true,
    })
    await this.peer.notify('initialized')
    return rec(result) ?? {}
  }

  /** Closing stdin ends the app-server (it exits within ~50 ms once its input is gone). */
  closeStdin(): void {
    this.child.closeStdin()
  }

  /** Close stdin, wait up to `waitMs` for the exit, then kill the tree. */
  async shutdown(waitMs = 3_000): Promise<void> {
    if (this.child.exitInfo() !== null) return
    this.child.closeStdin()
    const exited = await Promise.race([
      this.child.exited.then(() => true),
      delay(waitMs, false, { ref: false }),
    ])
    if (!exited) await stopChild(this.child, { stdinWaitMs: 0 }).catch(() => undefined)
    await this.child.exited
  }
}

/** A JSON-RPC method the server does not know: -32601, or 0.160's -32600 "unknown variant `x`" (protocol.ts). */
export function isUnknownMethod(err: unknown): boolean {
  return err instanceof JsonRpcError && isUnknownMethodError(err)
}

/** turn/start refused `collaborationMode` (-32602, or 0.160's -32600 form): run the plan emulated. */
export function isCollaborationRejected(err: unknown): boolean {
  return err instanceof JsonRpcError && isCollaborationModeRejected(err)
}

export const isPeerTimeout = (err: unknown): boolean =>
  err instanceof JsonRpcPeerError && err.kind === 'timeout'
export const isPeerClosed = (err: unknown): boolean =>
  err instanceof JsonRpcPeerError && err.kind === 'closed'
