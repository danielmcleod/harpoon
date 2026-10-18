#!/usr/bin/env node
// Builds the fake vendor CLI launchers (claude, codex, gemini, grok and muse) used by integration and E2E tests.
//
//   tests/.bin/<platform>/
//     node_modules/harpoon-fake-cli/fake-cli.mjs   copy of tests/fake-cli/fake-cli.mjs (the entry)
//     <vendor>.cmd                                   win32: npm cmd-shim format, runs `node <entry>` via %dp0%
//     <vendor>                                       POSIX: '#!/usr/bin/env node' executable copy (chmod 755)
//     build.json                                     hash of fake-cli.mjs + this script + node version
//
// Idempotent: an unchanged hash skips every write. Run directly to print the result as JSON:
//   node scripts/build-fake-cli.mjs [--out-dir <dir>]
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const SOURCE = join(ROOT, 'tests', 'fake-cli', 'fake-cli.mjs')
const PACKAGE = 'harpoon-fake-cli'

/** @type {readonly ['claude', 'codex', 'gemini', 'grok', 'muse']} */
export const FAKE_VENDORS = Object.freeze(['claude', 'codex', 'gemini', 'grok', 'muse'])

const isWindows = process.platform === 'win32'

/** npm cmd-shim (v6+) output, CRLF, pointing at a %dp0%-relative JS entry. */
function cmdShim(relEntry) {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relEntry}" %*`,
    '',
  ].join('\r\n')
}

async function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, content)
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      // Windows: EPERM/EBUSY while another process has the target open; retry briefly.
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        await rm(tmp, { force: true })
        throw err
      }
      await delay(50 * (attempt + 1))
    }
  }
}

function describe(dir, entry, hash) {
  const byVendor = (fn) => Object.fromEntries(FAKE_VENDORS.map((v) => [v, fn(v)]))
  /** @type {Record<string, unknown>} */
  const launchers = { node: byVendor(() => [process.execPath, entry]) }
  if (isWindows) launchers.cmd = byVendor((v) => join(dir, `${v}.cmd`))
  else launchers.sh = byVendor((v) => join(dir, v))
  return { dir, entry, hash, launchers }
}

function launcherFiles(result) {
  const files = [result.entry]
  for (const kind of ['cmd', 'sh']) {
    const map = result.launchers[kind]
    if (map) files.push(...Object.values(map))
  }
  return files
}

async function readStamp(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8')).hash
  } catch {
    return undefined
  }
}

/**
 * Build (or reuse) the fake CLI launchers.
 * @param {{outDir?: string}} [options]
 */
export async function buildFakeCli({ outDir } = {}) {
  const dir = resolve(outDir ?? join(ROOT, 'tests', '.bin', process.platform))
  const source = await readFile(SOURCE)
  const hash = createHash('sha256')
    .update(source)
    .update(await readFile(SELF))
    .update(`${process.version}|${process.platform}|${process.execPath}`)
    .digest('hex')
    .slice(0, 16)
  const pkgDir = join(dir, 'node_modules', PACKAGE)
  const entry = join(pkgDir, 'fake-cli.mjs')
  const result = describe(dir, entry, hash)
  const stamp = join(dir, 'build.json')

  if ((await readStamp(stamp)) === hash && launcherFiles(result).every((f) => existsSync(f))) return result

  await mkdir(pkgDir, { recursive: true })
  await writeAtomic(entry, source)
  const pkg = { name: PACKAGE, version: '0.0.0', private: true, type: 'module', bin: {} }
  for (const v of FAKE_VENDORS) pkg.bin[v] = 'fake-cli.mjs'
  await writeAtomic(join(pkgDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Extensionless shebang copies resolve their module type from the nearest package.json.
  await writeAtomic(
    join(dir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  )

  if (isWindows) {
    for (const v of FAKE_VENDORS) {
      await writeAtomic(join(dir, `${v}.cmd`), cmdShim(`node_modules\\${PACKAGE}\\fake-cli.mjs`))
    }
  } else {
    for (const v of FAKE_VENDORS) {
      const target = join(dir, v)
      await writeAtomic(target, source)
      await chmod(target, 0o755)
    }
  }
  await writeAtomic(
    stamp,
    `${JSON.stringify({ hash, node: process.version, platform: process.platform }, null, 2)}\n`,
  )
  return result
}

function isMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const a = resolve(argv1)
  return isWindows ? a.toLowerCase() === SELF.toLowerCase() : a === SELF
}

if (isMain()) {
  const i = process.argv.indexOf('--out-dir')
  const outDir = i > 0 ? process.argv[i + 1] : undefined
  const result = await buildFakeCli(outDir ? { outDir } : {})
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
