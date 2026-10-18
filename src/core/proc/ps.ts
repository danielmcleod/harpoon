// Process snapshots for kill sweeps and the relaunch orphan sweep.
import { readdir, readFile, readlink } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { systemRoot } from './path-env.ts'
import { execCapture } from './spawn.ts'

export interface ProcInfo {
  pid: number
  /** null when the source cannot tell (tasklist fallback). */
  ppid: number | null
  pgid?: number
  /** Process start, epoch ms; null when unknown (tasklist fallback). */
  startMs: number | null
  /** Executable path when known, else the image/command name. */
  exe: string
}

export type SnapshotSource = 'cim' | 'tasklist' | 'proc' | 'ps'

export interface ProcSnapshot {
  source: SnapshotSource
  at: number
  procs: ProcInfo[]
  /** When this machine booted (epoch ms); null when the source cannot tell (tasklist). */
  bootMs?: number | null
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : null
}

// ---- win32 ------------------------------------------------------------------------------------------------

const EPOCH_MS = (expr: string): string =>
  `if(${expr}){[int64](${expr}.ToUniversalTime()-[datetime]'1970-01-01').TotalMilliseconds}else{$null}`

/** `{"b":<boot ms>,"p":[{ProcessId,ParentProcessId,c,Name,ExecutablePath}…]}` in one PowerShell run. */
export const CIM_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  '$o=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime;',
  '$p=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name |',
  `Select-Object ProcessId,ParentProcessId,@{n='c';e={${EPOCH_MS('$_.CreationDate')}}},Name,ExecutablePath);`,
  `[pscustomobject]@{b=${EPOCH_MS('$o.LastBootUpTime')};p=$p} | ConvertTo-Json -Compress -Depth 3`,
].join(' ')

/** Parse {@link CIM_SCRIPT} output: the `{b,p}` wrapper, or a bare process array / single object. */
export function parseCimSnapshot(text: string): { procs: ProcInfo[]; bootMs: number | null } {
  const trimmed = text.trim()
  if (trimmed === '') return { procs: [], bootMs: null }
  const parsed: unknown = JSON.parse(trimmed)
  const wrapper =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'p' in parsed
      ? (parsed as { b?: unknown; p?: unknown })
      : undefined
  if (wrapper === undefined) return { procs: cimRows(parsed), bootMs: null }
  // Windows PowerShell 5.1 can serialize an array property as {"value":[…],"Count":n}.
  const p = wrapper.p
  const rows = p !== null && typeof p === 'object' && !Array.isArray(p) && 'value' in p ? p.value : p
  return { procs: cimRows(rows), bootMs: toInt(wrapper.b) }
}

/** Parse the CIM process rows (an array, or a bare object when there is one process). */
export function parseCimJson(text: string): ProcInfo[] {
  return parseCimSnapshot(text).procs
}

function cimRows(parsed: unknown): ProcInfo[] {
  if (parsed === null || parsed === undefined) return []
  const rows = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]
  const out: ProcInfo[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const pid = toInt(r['ProcessId'])
    if (pid === null) continue
    const exePath = typeof r['ExecutablePath'] === 'string' ? r['ExecutablePath'] : null
    const name = typeof r['Name'] === 'string' ? r['Name'] : ''
    out.push({ pid, ppid: toInt(r['ParentProcessId']), startMs: toInt(r['c']), exe: exePath ?? name })
  }
  return out
}

/** tasklist quotes every CSV field. */
function parseCsvLine(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? '').replace(/""/g, '"'))
}

/** `tasklist /FO CSV /NH`: image name and pid only. */
export function parseTasklistCsv(text: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [name, pidText] = parseCsvLine(line)
    const pid = toInt(pidText)
    if (name === undefined || pid === null) continue
    out.push({ pid, ppid: null, startMs: null, exe: name })
  }
  return out
}

async function snapshotWin32(): Promise<ProcSnapshot> {
  const root = systemRoot()
  const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const r = await execCapture(
    ps,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CIM_SCRIPT],
    {
      timeoutMs: 15_000,
    },
  )
  if (r.code === 0 && r.error === undefined) {
    try {
      const { procs, bootMs } = parseCimSnapshot(r.stdout)
      if (procs.length > 0) return { source: 'cim', at: Date.now(), procs, bootMs }
    } catch {
      // fall through to tasklist
    }
  }
  const tl = await execCapture(win32.join(root, 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], {
    timeoutMs: 15_000,
  })
  if (tl.code !== 0 || tl.error !== undefined) {
    throw new Error(
      `process snapshot failed: powershell ${r.code ?? r.error?.code}, tasklist ${tl.code ?? tl.error?.code}`,
    )
  }
  return { source: 'tasklist', at: Date.now(), procs: parseTasklistCsv(tl.stdout), bootMs: null }
}

// ---- linux ------------------------------------------------------------------------------------------------

/** Parse /proc/<pid>/stat; `comm` may contain spaces and parentheses, so fields are read after the last ')'. */
export function parseProcStat(
  text: string,
  bootTimeMs: number,
  clockTicks = 100,
): { pid: number; comm: string; ppid: number; pgid: number; startMs: number } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open === -1 || close < open) return null
  const pid = toInt(text.slice(0, open))
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  // fields[0] is field 3 (state); ppid=4, pgrp=5, starttime=22.
  const ppid = toInt(fields[1])
  const pgid = toInt(fields[2])
  const start = toInt(fields[19])
  if (pid === null || ppid === null || pgid === null || start === null) return null
  return {
    pid,
    comm: text.slice(open + 1, close),
    ppid,
    pgid,
    startMs: Math.round(bootTimeMs + (start * 1000) / clockTicks),
  }
}

export function parseBootTime(procStat: string): number | null {
  const m = /^btime\s+(\d+)/m.exec(procStat)
  return m === null ? null : Number(m[1]) * 1000
}

async function snapshotLinux(): Promise<ProcSnapshot> {
  const boot = parseBootTime(await readFile('/proc/stat', 'utf8'))
  if (boot === null) throw new Error('process snapshot failed: no btime in /proc/stat')
  const procs: ProcInfo[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let stat: ReturnType<typeof parseProcStat>
    try {
      stat = parseProcStat(await readFile(`/proc/${name}/stat`, 'utf8'), boot)
    } catch {
      continue
    }
    if (stat === null) continue
    let exe = stat.comm
    try {
      exe = await readlink(`/proc/${name}/exe`)
    } catch {
      // other users' processes: comm only
    }
    procs.push({ pid: stat.pid, ppid: stat.ppid, pgid: stat.pgid, startMs: stat.startMs, exe })
  }
  return { source: 'proc', at: Date.now(), procs, bootMs: boot }
}

// ---- darwin -----------------------------------------------------------------------------------------------

/** `LC_ALL=C ps -A -o pid=,ppid=,pgid=,lstart=,comm=` (lstart is local time, e.g. "Mon Oct  5 16:56:01 2026"). */
export function parseDarwinPs(text: string): ProcInfo[] {
  const out: ProcInfo[] = []
  const re = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*?)\s*$/
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line)
    if (m === null) continue
    const start = new Date((m[4] ?? '').replace(/\s+/g, ' ')).getTime()
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      startMs: Number.isFinite(start) ? start : null,
      exe: m[5] ?? '',
    })
  }
  return out
}

/** `sysctl -n kern.boottime`: "{ sec = 1700000000, usec = 123456 } Mon Oct  5 09:00:01 2026". */
export function parseDarwinBootTime(text: string): number | null {
  const m = /\bsec\s*=\s*(\d+)/.exec(text)
  return m === null ? null : Number(m[1]) * 1000
}

async function snapshotDarwin(): Promise<ProcSnapshot> {
  const env = { ...process.env, LC_ALL: 'C' }
  const [r, boot] = await Promise.all([
    execCapture('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], { env, timeoutMs: 15_000 }),
    execCapture('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { env, timeoutMs: 5_000 }),
  ])
  if (r.code !== 0 || r.error !== undefined)
    throw new Error(`process snapshot failed: ps ${r.code ?? r.error?.code}`)
  const bootMs = boot.code === 0 ? parseDarwinBootTime(boot.stdout) : null
  return { source: 'ps', at: Date.now(), procs: parseDarwinPs(r.stdout), bootMs }
}

export function snapshotProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcSnapshot> {
  if (platform === 'win32') return snapshotWin32()
  if (platform === 'linux') return snapshotLinux()
  return snapshotDarwin()
}

// ---- tree helpers -----------------------------------------------------------------------------------------

export interface DescendantOptions {
  /** Only processes started at or after this time count (pid reuse guard). */
  minStartMs?: number
  /**
   * Direct children of a root must have started by this time: a root that is dead (or was) held its pid only
   * until then, so a later process whose ppid still names that pid is someone else's (Windows keeps stale ppids).
   */
  maxChildStartMs?: number
}

/**
 * BFS over ppid from `roots` (which may already be dead: Windows does not reparent orphans). Returns descendants
 * only, never the roots themselves. A process never starts before its parent, so a child that predates its
 * parent hangs off a stale ppid and is skipped with its subtree. With a time bound set, an unknown start time
 * never counts. Limitation: a process whose parent already exited is invisible below that parent (its ppid names
 * a pid that is not in the snapshot); only a dead root is followed.
 */
export function findDescendants(
  procs: readonly ProcInfo[],
  roots: Iterable<number>,
  opts: DescendantOptions = {},
): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>()
  const byPid = new Map<number, ProcInfo>()
  for (const p of procs) {
    byPid.set(p.pid, p)
    if (p.ppid === null || p.ppid === p.pid) continue
    const list = byParent.get(p.ppid) ?? []
    list.push(p)
    byParent.set(p.ppid, list)
  }
  const bounded = opts.minStartMs !== undefined || opts.maxChildStartMs !== undefined
  const rootSet = new Set(roots)
  const seen = new Set<number>(rootSet)
  const queue = [...rootSet]
  const out: ProcInfo[] = []
  while (queue.length > 0) {
    const pid = queue.shift()!
    // A root's pid may now belong to another process; its children are bounded by the options instead.
    const parentStart = rootSet.has(pid) ? null : (byPid.get(pid)?.startMs ?? null)
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      const s = child.startMs
      if (s === null && bounded) continue
      if (s !== null) {
        if (opts.minStartMs !== undefined && s < opts.minStartMs) continue
        if (parentStart !== null && s < parentStart) continue
        if (rootSet.has(pid) && opts.maxChildStartMs !== undefined && s > opts.maxChildStartMs) continue
      }
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

/** Executable basename for matching: lowercased on win32 with `.exe` dropped. */
export function exeKey(exe: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32')
    return win32
      .basename(exe)
      .toLowerCase()
      .replace(/\.exe$/, '')
  return posix.basename(exe)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
