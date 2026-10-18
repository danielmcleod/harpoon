// Adapter registry: id → Adapter, picker order (claude, codex, then "More"), and stubs for
// every known vendor not built yet. A built adapter registers itself and replaces its stub.
import type { RecoveryAction } from '../../shared/failure.ts'
import type { CheckResult } from '../../shared/preflight.ts'
import { vendorCheckId } from '../../shared/preflight.ts'
import { MODES } from '../../shared/run.ts'
import type { Mode } from '../../shared/run.ts'
import type {
  Capabilities,
  KnownVendor,
  ReadinessNeed,
  Support,
  Transport,
  VendorId,
} from '../../shared/vendors.ts'
import { KNOWN_VENDORS, TRANSPORT_ROUTE, isKnownVendor, localPresetIdOf } from '../../shared/vendors.ts'
import { commandFor, osFamily } from '../heal/commands.ts'
import { failedRunHandle, makeFailure } from './errors.ts'
import type { Adapter, ProbeResult, RunHandle } from './types.ts'

export const PRIMARY_VENDORS = ['claude', 'codex'] as const satisfies readonly KnownVendor[]

export const VENDOR_DISPLAY_NAMES: Readonly<Record<KnownVendor, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  muse: 'Muse',
}

export const VENDOR_TRANSPORTS: Readonly<Record<KnownVendor, Transport>> = {
  claude: 'claude-stdio',
  codex: 'codex-app-server',
  gemini: 'acp',
  grok: 'acp',
  muse: 'muse-exec',
}

/** Muse ships as Experimental and stays out of built-in profiles. */
export const EXPERIMENTAL_VENDORS: readonly VendorId[] = ['muse']

export const NOT_BUILT_COPY = 'Not available in this build'
export const NOT_BUILT_SUPPORT: Support = { status: 'unsupported', copy: NOT_BUILT_COPY, reason: 'not-built' }

const STUB_TTL_MS = 24 * 60 * 60 * 1000

export function unsupportedCapabilities(support: Support = NOT_BUILT_SUPPORT): Capabilities {
  return {
    planMode: 'emulated',
    askRelay: false,
    resume: 'none',
    preassignSessionId: false,
    modelList: 'static',
    usageCumulative: false,
    allowSession: 'harpoon',
    web: false,
    resumeModelSwitch: false,
    reasoningIncludedInOutput: true,
    modes: Object.fromEntries(MODES.map((m) => [m, support])) as Record<Mode, Support>,
  }
}

const alternativeTo = (vendor: VendorId): KnownVendor => (vendor === 'claude' ? 'codex' : 'claude')

/**
 * The vendor's install command (the commands table) for a stub's probe check, so the setup card and the vendor picker
 * can offer it before the adapter ships (first run: "Codex not installed [copy]"). null when the table has none.
 */
function stubInstallAction(vendor: KnownVendor): RecoveryAction | null {
  const cmd = commandFor('install', vendor, osFamily())
  if (cmd === null) return null
  return {
    id: `${vendor}.install`,
    label: 'Copy the install command',
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason: `Install it now to use it once Harpoon supports ${VENDOR_DISPLAY_NAMES[vendor]}`,
    recheck: vendorCheckId(vendor, 'bin'),
  }
}

/** A stub's failing check; the probe's (vendor-scoped) one also offers the install command. */
function stubCheck(vendor: KnownVendor, id: string, scope: CheckResult['scope'], at: number): CheckResult {
  const displayName = VENDOR_DISPLAY_NAMES[vendor]
  const alt = alternativeTo(vendor)
  const install = scope === 'vendor' ? stubInstallAction(vendor) : null
  return {
    id,
    scope,
    status: 'fail',
    blocking: true,
    category: 'capability_missing',
    title: `${displayName}: ${NOT_BUILT_COPY.toLowerCase()}`,
    detail: `This build of Harpoon has no ${displayName} adapter yet. Pick another vendor.`,
    recovery: [
      {
        id: `${vendor}.switch-vendor`,
        label: `Use ${VENDOR_DISPLAY_NAMES[alt]} instead`,
        kind: 'switch_vendor',
        pass: 'all',
        to: alt,
        model: null,
      },
      ...(install !== null ? [install] : []),
    ],
    at,
    ttlMs: STUB_TTL_MS,
  }
}

/** What a stub's probe answers (nothing is spawned): one blocking `vendor.<v>.protocol` failure. */
export function stubProbeResult(vendor: KnownVendor, at: number): ProbeResult {
  const transport = VENDOR_TRANSPORTS[vendor]
  return {
    vendor,
    at,
    ok: false,
    transport,
    route: TRANSPORT_ROUTE[transport],
    checks: [stubCheck(vendor, vendorCheckId(vendor, 'protocol'), 'vendor', at)],
    capabilities: unsupportedCapabilities(),
    models: [],
  }
}

/** Registry stub for a vendor whose adapter is not in this build. Never spawns anything. */
export function createStubAdapter(vendor: KnownVendor, now: () => number = Date.now): Adapter {
  const displayName = VENDOR_DISPLAY_NAMES[vendor]
  const transport = VENDOR_TRANSPORTS[vendor]
  const failure = () =>
    makeFailure('capability_missing', `${displayName} is not available in this build.`, {
      classifiedBy: 'harpoon',
    })

  return {
    id: vendor,
    displayName,
    transport,
    managedFlags: [],
    testedUpTo: '',
    versionFloor: '',
    versionRecommended: '',
    probe(): Promise<ProbeResult> {
      return Promise.resolve(stubProbeResult(vendor, now()))
    },
    readiness(_cwd: string, need: ReadinessNeed): Promise<CheckResult[]> {
      return Promise.resolve([stubCheck(vendor, `pass.${need.pass}.readiness.mode`, 'pass', now())])
    },
    support: () => NOT_BUILT_SUPPORT,
    canResume: () => Promise.resolve({ ok: false, reason: 'cannot-resume' }),
    start(): RunHandle {
      return failedRunHandle({ vendor, route: TRANSPORT_ROUTE[transport], failure: failure() })
    },
    answer: () => {},
    stop: () => Promise.resolve(),
    listModels: () => Promise.resolve([]),
  }
}

export interface RegistryEntry {
  id: VendorId
  adapter: Adapter
  built: boolean
  experimental: boolean
  /** Picker section: claude and codex first, everything else under "More". */
  section: 'primary' | 'more'
}

export interface RegisterOptions {
  experimental?: boolean
}

export class AdapterRegistry {
  readonly #entries = new Map<VendorId, RegistryEntry>()
  readonly #now: () => number

  /** `stubs: false` starts empty (tests); by default every known vendor starts as a stub. */
  constructor(o: { stubs?: boolean; now?: () => number } = {}) {
    this.#now = o.now ?? Date.now
    if (o.stubs !== false) for (const v of KNOWN_VENDORS) this.#put(createStubAdapter(v, this.#now), false)
  }

  #put(adapter: Adapter, built: boolean, experimental?: boolean): void {
    const id = adapter.id
    this.#entries.set(id, {
      id,
      adapter,
      built,
      experimental: experimental ?? EXPERIMENTAL_VENDORS.includes(id),
      section: (PRIMARY_VENDORS as readonly string[]).includes(id) ? 'primary' : 'more',
    })
  }

  /** Registers a built adapter, replacing a stub or an earlier registration with the same id. */
  register(adapter: Adapter, o: RegisterOptions = {}): void {
    this.#put(adapter, true, o.experimental)
  }

  /** Removes a built adapter; a known vendor falls back to its stub. */
  unregister(id: VendorId): void {
    if (isKnownVendor(id)) this.#put(createStubAdapter(id, this.#now), false)
    else this.#entries.delete(id)
  }

  /** `local-<preset>` resolves to the Codex adapter (the local preset). */
  resolveId(id: VendorId): VendorId {
    return localPresetIdOf(id) !== null ? 'codex' : id
  }

  get(id: VendorId): Adapter | undefined {
    return this.#entries.get(this.resolveId(id))?.adapter
  }

  has(id: VendorId): boolean {
    return this.#entries.has(this.resolveId(id))
  }

  isBuilt(id: VendorId): boolean {
    return this.#entries.get(this.resolveId(id))?.built === true
  }

  /**
   * An Experimental vendor (Muse) is one the user picks under "More"; Harpoon never suggests it on its own
   * (a switch_vendor target, a Critic swap, Fix's "Fresh, different vendor").
   */
  isExperimental(id: VendorId): boolean {
    return this.#entries.get(this.resolveId(id))?.experimental === true
  }

  /** Picker order: claude, codex, then known vendors in KNOWN_VENDORS order, then others by id. */
  list(): RegistryEntry[] {
    const rank = (id: VendorId): number => {
      const i = (KNOWN_VENDORS as readonly string[]).indexOf(id)
      return i === -1 ? KNOWN_VENDORS.length : i
    }
    return [...this.#entries.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
  }

  primary(): RegistryEntry[] {
    return this.list().filter((e) => e.section === 'primary')
  }

  more(): RegistryEntry[] {
    return this.list().filter((e) => e.section === 'more')
  }

  /** Per-vendor managed flags (config SemanticOptions.managedFlags). */
  managedFlags(): Record<VendorId, readonly string[]> {
    return Object.fromEntries(this.list().map((e) => [e.id, e.adapter.managedFlags]))
  }
}

/** The process-wide registry. Built adapters call {@link registerAdapter} from their module. */
export const adapterRegistry = new AdapterRegistry()

export function registerAdapter(adapter: Adapter, o?: RegisterOptions): void {
  adapterRegistry.register(adapter, o)
}

export function getAdapter(id: VendorId): Adapter | undefined {
  return adapterRegistry.get(id)
}
