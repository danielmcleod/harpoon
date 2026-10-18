// harpoon.json schema (zod 4, strictObject everywhere), the fully-resolved shape stored in resolved.json, and
// file-level semantic rules. Mapping issue pointers to file:line:col is core's job.
import { z } from 'zod'
import { ISOLATION_MODES, MODES, MUTATING_PASSES, PASS_NAMES, READONLY_PASSES } from './run.ts'
import type { PassName } from './run.ts'
import { VENDOR_ID_PATTERN } from './vendors.ts'
import type { LocalPreset } from './vendors.ts'

export const CONFIG_SCOPES = ['user', 'project'] as const
export type ConfigScope = (typeof CONFIG_SCOPES)[number]

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]
export const ACCENTS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet'] as const
export type Accent = (typeof ACCENTS)[number]
export const STREAM_FONT_SIZES = [12, 13, 14] as const
export type StreamFontSize = (typeof STREAM_FONT_SIZES)[number]

export const PLANNING_NATIVE = ['auto', 'off'] as const
export const BRANCH_MODES = ['none', 'runBranch'] as const
export const INSTALL_POLICIES = ['ask', 'auto', 'never'] as const
export const VERIFY_RUN_AFTER = ['implement', 'fix'] as const
export const NOTIFICATION_EVENTS = ['ask', 'gate', 'completed', 'failed', 'catalog'] as const
export const TEMPLATE_LAYERS = ['builtin', 'user', 'project'] as const

export const DEFAULT_TIMEOUTS = {
  stallMs: 300_000,
  hardKillMs: 1_200_000,
  toolStallMs: 900_000,
  askMs: 600_000,
} as const satisfies Timeouts

/** A renamed flag must still look like a flag. */
export const FLAG_VALUE_PATTERN = /^--?[a-z][a-z0-9-]*$/

/** Env vars a config may not set for a vendor child: Harpoon owns them. */
const FORBIDDEN_ENV_PATTERN = /^(PATH|NODE_OPTIONS|ELECTRON_\w*)$/i

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * A host that is this computer: `localhost`, `127.x.x.x` or `[::1]`. A name under `.localhost` is not one:
 * Windows sends it to DNS (a hosts entry or a LAN responder can point it anywhere), and plain http to it would leave
 * the machine.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host)
}

/** Local preset base URLs: https anywhere, plain http only on a loopback host. */
export function isAllowedPresetUrl(url: string): boolean {
  const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/?#:@\s[\]]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(url)
  if (!m) return false
  return m[1]?.toLowerCase() === 'https' || isLoopbackHost(m[2] ?? '')
}

// ---- leaves ------------------------------------------------------------------

export const VendorIdZ = z.string().regex(VENDOR_ID_PATTERN)
/** null = omit the model flag and use the CLI default. */
export const ModelIdZ = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:@/[\]-]+$/)
  .nullable()
/** Template name (looked up project → user → builtin); null = `<pass>.md`. */
export const TemplateNameZ = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .nullable()
export const ProfileNameZ = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
export const ModeZ = z.enum(MODES)
export const PassNameZ = z.enum(PASS_NAMES)
const EnvNameZ = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((k) => !FORBIDDEN_ENV_PATTERN.test(k), { message: 'This variable is managed by Harpoon' })
const FlagNameZ = z.string().regex(/^--?[A-Za-z][\w-]*$/)
/** argv, or one string tokenized quote-aware by core (no shell; metacharacters are rejected there). */
const CommandLineZ = z.union([
  z.array(z.string().min(1).max(1000)).min(1).max(64),
  z.string().min(1).max(1000),
])

// ---- passes and profiles ---------------------------------------------------------

const passFields = {
  vendor: VendorIdZ,
  model: ModelIdZ,
  mode: ModeZ,
  enabled: z.boolean(),
  promptTemplate: TemplateNameZ,
}
/** Per-pass keys are EXACTLY vendor/model/mode/enabled/promptTemplate. */
export const PassConfigZ = z.strictObject(passFields).partial()
export const FixConfigZ = z
  .strictObject({ ...passFields, inherit: z.literal('implement').nullable(), reuseSession: z.boolean() })
  .partial()
export const ProfileZ = z
  .strictObject({
    plan: PassConfigZ,
    implement: PassConfigZ,
    review: PassConfigZ,
    critic: PassConfigZ,
    fix: FixConfigZ,
  })
  .partial()

// ---- sections (full shapes are the resolved ones; files use .partial()) -----------------

export const TimeoutsZ = z.strictObject({
  stallMs: z.number().int().min(30_000).max(3_600_000),
  hardKillMs: z.number().int().min(60_000).max(14_400_000),
  toolStallMs: z.number().int().min(30_000).max(7_200_000),
  askMs: z.number().int().min(30_000).max(3_600_000),
})

const worktreeFields = {
  copy: z.array(z.string().min(1).max(260)).max(50),
  install: z.enum(INSTALL_POLICIES),
  installCommand: CommandLineZ.nullable(),
  autoApply: z.boolean(),
}
const isolationFields = {
  mode: z.enum(ISOLATION_MODES),
  branch: z.enum(BRANCH_MODES),
  branchPrefix: z.string().regex(/^[A-Za-z0-9._/-]{1,40}$/),
}

export const VerifyCommandConfigZ = z.strictObject({
  name: z.string().min(1).max(40),
  run: CommandLineZ,
  cwd: z.string().min(1).max(260).exactOptional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).exactOptional(),
  enabled: z.boolean().exactOptional(),
})
const verifyFields = {
  enabled: z.boolean(),
  commands: z.array(VerifyCommandConfigZ).max(20),
  runAfter: z.array(z.enum(VERIFY_RUN_AFTER)).max(2),
  failFast: z.boolean(),
  baseline: z.boolean(),
}

const SelfHealZ = z.strictObject({
  enabled: z.boolean(),
  vendor: VendorIdZ,
  model: ModelIdZ,
  autoApplyConfigPatches: z.boolean(),
})
const UiZ = z.strictObject({
  theme: z.enum(THEMES),
  accent: z.enum(ACCENTS),
  closeToTray: z.union([z.boolean(), z.literal('auto')]),
  streamFontSize: z.union([z.literal(12), z.literal(13), z.literal(14)]),
})
const NotificationEventsZ = z.strictObject({
  ask: z.boolean(),
  gate: z.boolean(),
  completed: z.boolean(),
  failed: z.boolean(),
  catalog: z.boolean(),
})
const notificationFields = { desktop: z.boolean(), sound: z.boolean(), onlyWhenUnfocused: z.boolean() }
const vendorFields = {
  path: z.string().min(1).max(1024).nullable(),
  defaultModel: ModelIdZ,
  extraArgs: z.array(z.string().min(1).max(200)).max(32),
  env: z.record(EnvNameZ, z.string().max(8192)),
  /** managed flag → replacement flag (a CLI renamed it). Keys are checked against managedFlags in core. */
  flagMap: z.record(FlagNameZ, z.string().min(1).max(64)),
}
const CatalogRefreshZ = z.strictObject({
  enabled: z.boolean(),
  intervalDays: z.number().int().min(1).max(365),
  vendor: VendorIdZ,
  model: ModelIdZ,
})
const StorageZ = z.strictObject({
  keepRuns: z.number().int().min(1).max(100_000),
  keepDays: z.number().int().min(1).max(3650),
  rawLogDays: z.number().int().min(0).max(3650),
})
export const LocalPresetZ = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
  label: z.string().min(1).max(60),
  baseUrl: z
    .string()
    .max(2048)
    .refine(isAllowedPresetUrl, { message: 'Use https, or http only for localhost / 127.0.0.1 / [::1]' }),
  model: z.string().min(1).max(128),
  apiKeyEnv: EnvNameZ.exactOptional(),
  contextWindow: z.number().int().positive().max(100_000_000).exactOptional(),
}) satisfies z.ZodType<LocalPreset>

// ---- harpoon.json ---------------------------------------------------------------

/** One config file (user or project). Every key optional; unknown keys anywhere are errors. */
export const HarpoonConfigZ = z
  .strictObject({
    $schema: z.string().max(2048),
    /** Absent ⇒ 1. */
    version: z.literal(1),
    profile: ProfileNameZ,
    profiles: z.record(ProfileNameZ, ProfileZ),
    /** Layer-level pass overrides applied after the selected profile (the "Save to project" target). */
    passes: ProfileZ,
    planning: z.strictObject({ native: z.enum(PLANNING_NATIVE) }).partial(),
    gates: z.strictObject({ afterPlan: z.boolean(), beforeFix: z.boolean() }).partial(),
    auto: z.boolean(),
    ask: z.strictObject({ denyPauses: z.boolean() }).partial(),
    timeouts: TimeoutsZ.partial(),
    isolation: z
      .strictObject({ ...isolationFields, worktree: z.strictObject(worktreeFields).partial() })
      .partial(),
    verify: z.strictObject(verifyFields).partial(),
    // ---- user-only (an error in a project file) ----
    selfHeal: SelfHealZ.partial(),
    ui: UiZ.partial(),
    notifications: z.strictObject({ ...notificationFields, events: NotificationEventsZ.partial() }).partial(),
    vendors: z.record(VendorIdZ, z.strictObject(vendorFields).partial()),
    catalog: z.strictObject({ refresh: CatalogRefreshZ.partial() }).partial(),
    storage: StorageZ.partial(),
    local: z.strictObject({ presets: z.array(LocalPresetZ).max(20) }).partial(),
  })
  .partial()

export type HarpoonConfig = z.infer<typeof HarpoonConfigZ>
export type PassConfig = z.infer<typeof PassConfigZ>
export type FixConfig = z.infer<typeof FixConfigZ>
export type ProfileConfig = z.infer<typeof ProfileZ>
export type Timeouts = z.infer<typeof TimeoutsZ>
export type VerifyCommandConfig = z.infer<typeof VerifyCommandConfigZ>

/** Keys a committed project file may not set (a project must never point `vendors.*.path` at an executable). */
export const USER_ONLY_KEYS = [
  'selfHeal',
  'ui',
  'notifications',
  'vendors',
  'catalog',
  'storage',
  'local',
] as const satisfies readonly (keyof HarpoonConfig)[]
export type UserOnlyKey = (typeof USER_ONLY_KEYS)[number]

export const RUN_OVERRIDE_KEYS = [
  'profile',
  'auto',
  'passes',
  'gates',
  'planning',
  'isolation',
  'verify',
] as const satisfies readonly (keyof HarpoonConfig)[]

/** The in-memory run layer (composer overrides, CLI `--set`). Strict: user-only keys are unrecognized. */
export const RunOverridesZ = HarpoonConfigZ.pick({
  profile: true,
  auto: true,
  passes: true,
  gates: true,
  planning: true,
  isolation: true,
  verify: true,
})
export type RunOverrides = z.infer<typeof RunOverridesZ>

// ---- resolved config (resolved.json `config`; Re-run loads it through ResolvedConfigZ) ----------

export const ResolvedTemplateZ = z.strictObject({
  name: z.string().min(1).max(64),
  path: z.string().min(1),
  layer: z.enum(TEMPLATE_LAYERS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export const ResolvedPassZ = z.strictObject({
  vendor: VendorIdZ,
  model: ModelIdZ,
  mode: ModeZ,
  enabled: z.boolean(),
  promptTemplate: ResolvedTemplateZ,
})
export const ResolvedFixPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  inherit: z.literal('implement').nullable(),
  reuseSession: z.boolean(),
})

export type ResolvedTemplate = z.infer<typeof ResolvedTemplateZ>
export type ResolvedPass = z.infer<typeof ResolvedPassZ>
export type ResolvedFixPass = z.infer<typeof ResolvedFixPassZ>

const ResolvedShapeZ = z.strictObject({
  profile: ProfileNameZ,
  auto: z.boolean(),
  passes: z.strictObject({
    plan: ResolvedPassZ,
    implement: ResolvedPassZ,
    review: ResolvedPassZ,
    critic: ResolvedPassZ,
    fix: ResolvedFixPassZ,
  }),
  planning: z.strictObject({ native: z.enum(PLANNING_NATIVE) }),
  gates: z.strictObject({ afterPlan: z.boolean(), beforeFix: z.boolean() }),
  ask: z.strictObject({ denyPauses: z.boolean() }),
  timeouts: TimeoutsZ,
  isolation: z.strictObject({ ...isolationFields, worktree: z.strictObject(worktreeFields) }),
  verify: z.strictObject(verifyFields),
  selfHeal: SelfHealZ,
  ui: UiZ,
  notifications: z.strictObject({ ...notificationFields, events: NotificationEventsZ }),
  vendors: z.record(VendorIdZ, z.strictObject(vendorFields)),
  catalog: z.strictObject({ refresh: CatalogRefreshZ }),
  storage: StorageZ,
  local: z.strictObject({ presets: z.array(LocalPresetZ).max(20) }),
})

/**
 * Every key populated. Accepts mode "full" for implement/fix only together with `auto: true`, and skips the
 * file-only rules (user-only keys, "full" in a file).
 */
export const ResolvedConfigZ = ResolvedShapeZ.superRefine((cfg, ctx) => {
  for (const pass of READONLY_PASSES) {
    if (cfg.passes[pass].mode !== 'readonly') {
      ctx.addIssue({ code: 'custom', path: ['passes', pass, 'mode'], message: `${pass} must be read-only` })
    }
  }
  for (const pass of MUTATING_PASSES) {
    if (cfg.passes[pass].mode === 'full' && !cfg.auto) {
      ctx.addIssue({
        code: 'custom',
        path: ['passes', pass, 'mode'],
        message: 'mode "full" is only valid together with auto: true',
      })
    }
  }
  for (const issue of timeoutOrderIssues(cfg.timeouts)) {
    ctx.addIssue({ code: 'custom', path: ['timeouts', issue.key], message: issue.message })
  }
})
export type ResolvedConfig = z.infer<typeof ResolvedConfigZ>

// ---- provenance --------------------------------------------------------------------

export const PROVENANCE_SOURCES = [
  'default',
  'user',
  'project',
  'run',
  'auto',
  'inherit',
  'vendor',
  'cli',
] as const
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

export interface Provenance {
  source: ProvenanceSource
  file?: string
  line?: number
  /** e.g. `profile:balanced`, `passes`, `inherit:implement`. */
  via?: string
}

/** JSON pointer into ResolvedConfig → where the value came from (drives composer badges). */
export type ProvenanceMap = Record<string, Provenance>

// ---- semantic rules (after zod) -------------------------------------------------------------

export const SEMANTIC_ISSUE_CODES = [
  'readonly-pass',
  'full-in-file',
  'timeout-order',
  'flag-map-value',
  'flag-map-key',
  'managed-flag',
  'forbidden-flag',
  'user-only-key',
  'duplicate-preset',
] as const
export type SemanticIssueCode = (typeof SEMANTIC_ISSUE_CODES)[number]

export interface SemanticIssue {
  /** RFC 6901 pointer into the file's JSON value. */
  pointer: string
  code: SemanticIssueCode
  message: string
  severity: 'error' | 'warning'
}

export interface SemanticOptions {
  scope: ConfigScope
  /** Timeouts from lower layers; builtin defaults fill the rest. */
  inheritedTimeouts?: Partial<Timeouts>
  /** Per-vendor `adapter.managedFlags`; when given, extraArgs and flagMap keys are checked against them. */
  managedFlags?: Readonly<Record<string, readonly string[]>>
  /**
   * per-vendor `adapter.forbiddenFlags`, the flags that widen what a pass may do (Gemini `--yolo`,
   * `-y`; Claude `--add-dir`; Codex `--profile`). When given, extraArgs may not carry one, nor `--dangerously-*`, nor a
   * forbidden letter inside a combined short flag (`-dy`), so the load check (`file:line:col`) refuses what the spawn
   * check, support() and the recovery guard already refuse.
   */
  forbiddenFlags?: Readonly<Record<string, readonly string[]>>
}

/** Spelling-insensitive identity of a long flag (`--skip-trust` ≡ `--skip_trust` ≡ `--skipTrust`), as the adapters read it. */
const longFlagKey = (arg: string): string =>
  (arg.split('=', 1)[0] ?? arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')

/**
 * The reason an extraArgs entry is a forbidden flag for its vendor, or undefined. A long flag is
 * matched in any spelling, as the adapters' spawn checks match it, and `--dangerously-*` always; a single letter is
 * matched exactly, alone or as one letter of a combined short flag (`-dy` is `-d -y` to the CLI's parser).
 */
function forbiddenFlagProblem(arg: string, forbidden: readonly string[]): string | undefined {
  if (!arg.startsWith('-') || arg === '-') return undefined
  const name = arg.split('=', 1)[0] ?? arg
  if (arg.startsWith('--')) {
    const key = longFlagKey(arg)
    const long = forbidden.filter((f) => f.startsWith('--')).map(longFlagKey)
    if (long.includes(key) || /^dangerously/.test(key))
      return `${name} widens what a pass may do; extraArgs may not set it`
    return undefined
  }
  const short = forbidden.filter((f) => /^-[^-]$/.test(f))
  if (arg.length === 2) {
    return short.includes(arg) ? `${arg} widens what a pass may do; extraArgs may not set it` : undefined
  }
  const letter = [...arg.slice(1)].map((ch) => `-${ch}`).find((l) => short.includes(l))
  return letter !== undefined
    ? `${arg} combines ${letter} with other short flags; ${letter} widens what a pass may do`
    : undefined
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
export function toJsonPointer(segments: readonly (string | number)[]): string {
  return segments.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

const isReadonlyPass = (p: PassName): boolean => (READONLY_PASSES as readonly PassName[]).includes(p)

function timeoutOrderIssues(t: Timeouts): { key: 'stallMs' | 'toolStallMs'; message: string }[] {
  const out: { key: 'stallMs' | 'toolStallMs'; message: string }[] = []
  for (const key of ['stallMs', 'toolStallMs'] as const) {
    if (t[key] >= t.hardKillMs) {
      out.push({ key, message: `${key} (${t[key]}) must be less than hardKillMs (${t.hardKillMs})` })
    }
  }
  return out
}

/** File-level rules zod cannot express. Returns pointer-addressed issues; line/col mapping happens in core. */
export function validateSemantics(cfg: HarpoonConfig, opts: SemanticOptions): SemanticIssue[] {
  const issues: SemanticIssue[] = []
  const add = (path: (string | number)[], code: SemanticIssueCode, message: string): void => {
    issues.push({ pointer: toJsonPointer(path), code, message, severity: 'error' })
  }

  if (opts.scope === 'project') {
    for (const key of USER_ONLY_KEYS) {
      if (cfg[key] !== undefined) {
        add(
          [key],
          'user-only-key',
          `"${key}" can only be set in your user harpoon.json, not in a project file`,
        )
      }
    }
  }

  const passBlocks: [(string | number)[], ProfileConfig][] = Object.entries(cfg.profiles ?? {}).map(
    ([name, profile]) => [['profiles', name], profile],
  )
  if (cfg.passes) passBlocks.push([['passes'], cfg.passes])
  for (const [prefix, block] of passBlocks) {
    for (const pass of PASS_NAMES) {
      const mode = block[pass]?.mode
      if (mode === undefined) continue
      if (isReadonlyPass(pass) && mode !== 'readonly') {
        add([...prefix, pass, 'mode'], 'readonly-pass', `The ${pass} pass must be "readonly"`)
      } else if (mode === 'full') {
        add(
          [...prefix, pass, 'mode'],
          'full-in-file',
          '"full" is only set by Auto mode; use "auto": true instead',
        )
      }
    }
  }

  const t = cfg.timeouts
  if (t) {
    const inherited = opts.inheritedTimeouts ?? {}
    const effective: Timeouts = {
      stallMs: t.stallMs ?? inherited.stallMs ?? DEFAULT_TIMEOUTS.stallMs,
      hardKillMs: t.hardKillMs ?? inherited.hardKillMs ?? DEFAULT_TIMEOUTS.hardKillMs,
      toolStallMs: t.toolStallMs ?? inherited.toolStallMs ?? DEFAULT_TIMEOUTS.toolStallMs,
      askMs: t.askMs ?? inherited.askMs ?? DEFAULT_TIMEOUTS.askMs,
    }
    for (const issue of timeoutOrderIssues(effective)) {
      // Only report pairs this file touches, at the key it set.
      if (t[issue.key] !== undefined) add(['timeouts', issue.key], 'timeout-order', issue.message)
      else if (t.hardKillMs !== undefined) add(['timeouts', 'hardKillMs'], 'timeout-order', issue.message)
    }
  }

  for (const [vendor, vc] of Object.entries(cfg.vendors ?? {})) {
    const managed = opts.managedFlags?.[vendor]
    for (const [flag, value] of Object.entries(vc.flagMap ?? {})) {
      if (!FLAG_VALUE_PATTERN.test(value)) {
        add(
          ['vendors', vendor, 'flagMap', flag],
          'flag-map-value',
          `"${value}" is not a flag (expected e.g. --new-name)`,
        )
      }
      if (managed && !managed.includes(flag)) {
        add(
          ['vendors', vendor, 'flagMap', flag],
          'flag-map-key',
          `${flag} is not a flag Harpoon manages for ${vendor}`,
        )
      }
    }
    const forbidden = opts.forbiddenFlags?.[vendor]
    if (managed || forbidden) {
      ;(vc.extraArgs ?? []).forEach((arg, i) => {
        const name = arg.split('=', 1)[0] ?? arg
        // `-pc` is `-p -c` to the CLI's parser, so a combined short flag names every letter in it.
        const letter =
          managed && /^-[^-]/.test(arg) && arg.length > 2
            ? [...arg.slice(1)].map((ch) => `-${ch}`).find((l) => managed.includes(l))
            : undefined
        const widens = forbidden !== undefined ? forbiddenFlagProblem(arg, forbidden) : undefined
        if (managed?.includes(name) === true) {
          add(
            ['vendors', vendor, 'extraArgs', i],
            'managed-flag',
            `${name} is managed by Harpoon; use flagMap to rename it`,
          )
        } else if (letter !== undefined) {
          add(
            ['vendors', vendor, 'extraArgs', i],
            'managed-flag',
            `${arg} combines ${letter} with other short flags; Harpoon manages ${letter}`,
          )
        } else if (widens !== undefined) {
          add(['vendors', vendor, 'extraArgs', i], 'forbidden-flag', widens)
        }
      })
    }
  }

  const seen = new Set<string>()
  ;(cfg.local?.presets ?? []).forEach((preset, i) => {
    if (seen.has(preset.id))
      add(['local', 'presets', i, 'id'], 'duplicate-preset', `Duplicate preset id "${preset.id}"`)
    seen.add(preset.id)
  })

  return issues
}
