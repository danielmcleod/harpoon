// Deterministic repository seed (no AI, seconds): docker-compose, Kubernetes manifests and package manifests give
// the deployables, their data stores and brokers, and some of the links between them, each with evidence. The AI
// import pass then confirms, corrects and deepens this seed instead of starting from nothing.
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { NodeKind } from '../../shared/model/schema.ts'

export interface SeedNode {
  key: string
  name: string
  kind: NodeKind
  external: boolean
  techStack: string | null
  vendor: string | null
  description: string
  evidence: { path: string; line: number | null }[]
  namespace: string | null
}

export interface SeedLink {
  from: string
  to: string
  protocol: string
  async: boolean
  evidence: { path: string; line: number | null }
}

export interface Seed {
  nodes: SeedNode[]
  links: SeedLink[]
  files: string[]
  /** One line per source the seed read (shown in the prompt and the activity list). */
  notes: string[]
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.harpoon', 'coverage', '.idea', '.vscode', 'bin', 'obj'])
const MAX_FILES = 4000
const MAX_DEPTH = 5

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length > MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(p, depth + 1)
      } else out.push(p)
    }
  }
  await visit(root, 0)
  return out
}

/** Kind and display hints from a container image name. */
export function kindFromImage(image: string): { kind: NodeKind; tech: string | null } {
  const i = image.toLowerCase()
  const table: [RegExp, NodeKind, string][] = [
    [/postgres|postgis|timescale/, 'database', 'PostgreSQL'],
    [/mysql|mariadb|percona/, 'database', 'MySQL'],
    [/mongo/, 'database', 'MongoDB'],
    [/cassandra|scylla/, 'database', 'Cassandra'],
    [/elasticsearch|opensearch|solr|meilisearch|typesense/, 'search', 'Elasticsearch'],
    [/clickhouse/, 'database', 'ClickHouse'],
    [/redis|valkey|keydb|dragonfly/, 'cache', 'Redis'],
    [/memcached/, 'cache', 'Memcached'],
    [/rabbitmq/, 'queue', 'RabbitMQ'],
    [/nats/, 'queue', 'NATS'],
    [/kafka|redpanda|zookeeper/, 'stream', 'Kafka'],
    [/kong|tyk|krakend|apisix/, 'gateway', ''],
    [/nginx|traefik|envoy|haproxy|caddy/, 'network', ''],
    [/airflow|prefect|dagster|flink|spark|nifi|dbt/, 'pipeline', ''],
    [/ollama|vllm|triton|tensorflow-serving|torchserve|text-generation/, 'ml', ''],
    [/minio|localstack|azurite/, 'storage', ''],
    [/prometheus|grafana|jaeger|otel|loki|tempo|zipkin/, 'observability', ''],
    [/keycloak|dex|authelia/, 'identity', ''],
  ]
  for (const [re, kind, tech] of table) if (re.test(i)) return { kind, tech: tech === '' ? image.split(':')[0] ?? null : tech }
  return { kind: 'service', tech: null }
}

const protocolFor = (k: NodeKind): { protocol: string; async: boolean } =>
  k === 'database' ? { protocol: 'SQL', async: false } : k === 'cache' ? { protocol: 'Redis', async: false } : k === 'queue' ? { protocol: 'AMQP', async: true } : k === 'stream' ? { protocol: 'Kafka', async: true } : k === 'storage' ? { protocol: 'S3', async: false } : { protocol: 'HTTP', async: false }

function lineOf(text: string, needle: RegExp): number | null {
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex((l) => needle.test(l))
  return i === -1 ? null : i + 1
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function readText(p: string): Promise<string | null> {
  try {
    const s = await stat(p)
    if (s.size > 1_000_000) return null
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

interface ComposeService {
  image?: string
  build?: unknown
  depends_on?: unknown
  environment?: unknown
  links?: unknown
}

async function fromCompose(root: string, file: string, seed: Seed): Promise<void> {
  const text = await readText(file)
  if (text === null) return
  const rel = relative(root, file).replace(/\\/g, '/')
  let doc: unknown
  try {
    doc = parseAllDocuments(text)[0]?.toJS()
  } catch {
    return
  }
  const services = (doc as { services?: Record<string, ComposeService> } | null)?.services
  if (services === undefined || typeof services !== 'object') return
  seed.notes.push(`${rel}: ${Object.keys(services).length} compose services`)
  const names = Object.keys(services)
  for (const [name, svc] of Object.entries(services)) {
    const image = typeof svc.image === 'string' ? svc.image : ''
    const guess = image !== '' ? kindFromImage(image) : { kind: 'service' as NodeKind, tech: null }
    // A reverse proxy named like an entry point is the system's gateway.
    const kind: NodeKind = guess.kind === 'network' && /gateway|gw|ingress|proxy|edge|api/i.test(name) ? 'gateway' : guess.kind
    const tech = guess.tech
    upsertNode(seed, {
      key: name,
      name,
      kind,
      external: false,
      techStack: tech,
      vendor: null,
      description: image !== '' ? `Container image ${image}.` : 'Built from source.',
      evidence: [{ path: rel, line: lineOf(text, new RegExp(`^\\s{2}${esc(name)}:`)) }],
      namespace: null,
    })
  }
  for (const [name, svc] of Object.entries(services)) {
    const deps = Array.isArray(svc.depends_on) ? svc.depends_on : svc.depends_on !== null && typeof svc.depends_on === 'object' ? Object.keys(svc.depends_on) : []
    const env = Array.isArray(svc.environment) ? svc.environment.join('\n') : svc.environment !== null && typeof svc.environment === 'object' ? Object.values(svc.environment as Record<string, unknown>).join('\n') : ''
    const targets = new Set<string>(deps.filter((d): d is string => typeof d === 'string'))
    // URLs and hostnames in the environment that name another service (http://orders:8080, redis://cache:6379).
    for (const other of names) if (other !== name && new RegExp(`(//|@|\\b)${esc(other)}(:\\d+|\\b)`).test(env)) targets.add(other)
    for (const t of targets) {
      const target = seed.nodes.find((n) => n.key === t)
      if (target === undefined) continue
      const p = protocolFor(target.kind)
      seed.links.push({ from: name, to: t, protocol: p.protocol, async: p.async, evidence: { path: rel, line: lineOf(text, new RegExp(`^\\s{2}${esc(name)}:`)) } })
    }
  }
}

async function fromK8s(root: string, file: string, seed: Seed): Promise<void> {
  const text = await readText(file)
  if (text === null || !/^kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob)/m.test(text)) return
  const rel = relative(root, file).replace(/\\/g, '/')
  let docs: unknown[]
  try {
    docs = parseAllDocuments(text).map((d) => d.toJS() as unknown)
  } catch {
    return
  }
  for (const d of docs) {
    const o = d as { kind?: string; metadata?: { name?: string; namespace?: string }; spec?: { template?: { spec?: { containers?: { image?: string }[] } }; jobTemplate?: unknown } } | null
    if (o === null || typeof o !== 'object' || o.metadata?.name === undefined) continue
    if (!['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'].includes(o.kind ?? '')) continue
    const image = o.spec?.template?.spec?.containers?.[0]?.image ?? ''
    const guess = image !== '' ? kindFromImage(image) : { kind: 'service' as NodeKind, tech: null }
    const kind: NodeKind = o.kind === 'CronJob' ? 'scheduler' : guess.kind
    upsertNode(seed, {
      key: o.metadata.name,
      name: o.metadata.name,
      kind,
      external: false,
      techStack: guess.tech,
      vendor: null,
      description: `Kubernetes ${o.kind}${image !== '' ? ` running ${image}` : ''}.`,
      evidence: [{ path: rel, line: lineOf(text, new RegExp(`name:\\s*${esc(o.metadata.name)}\\b`)) }],
      namespace: o.metadata.namespace ?? null,
    })
  }
  seed.notes.push(`${rel}: Kubernetes workloads`)
}

const MANIFESTS: Record<string, string> = {
  'package.json': 'Node.js',
  'go.mod': 'Go',
  'pyproject.toml': 'Python',
  'requirements.txt': 'Python',
  'pom.xml': 'Java',
  'build.gradle': 'Java/Kotlin',
  'build.gradle.kts': 'Kotlin',
  'Cargo.toml': 'Rust',
  'Gemfile': 'Ruby',
  'composer.json': 'PHP',
}

async function fromManifests(root: string, files: string[], seed: Seed): Promise<void> {
  // Only when infrastructure files named nothing: each manifest directory becomes a candidate service.
  if (seed.nodes.length > 0) return
  const dirs = new Map<string, { tech: string; file: string }>()
  for (const f of files) {
    const tech = MANIFESTS[basename(f)]
    if (tech === undefined) continue
    const d = dirname(f)
    if (!dirs.has(d)) dirs.set(d, { tech, file: f })
  }
  // A monorepo root manifest alongside app manifests is not itself a service.
  const all = [...dirs.entries()]
  const nested = all.filter(([d]) => d !== root)
  for (const [d, { tech, file }] of nested.length > 0 ? nested : all) {
    const name = d === root ? basename(root) : basename(d)
    const rel = relative(root, file).replace(/\\/g, '/')
    let description = `${tech} project.`
    if (basename(file) === 'package.json') {
      const t = await readText(file)
      try {
        const pkg = JSON.parse(t ?? '{}') as { description?: string; name?: string }
        if (pkg.description) description = pkg.description
      } catch {
        // keep the generic description
      }
    }
    upsertNode(seed, { key: name, name, kind: 'service', external: false, techStack: tech, vendor: null, description, evidence: [{ path: rel, line: null }], namespace: null })
  }
  if (nested.length > 0 || all.length > 0) seed.notes.push(`${dirs.size} package manifests`)
}

function upsertNode(seed: Seed, n: SeedNode): void {
  const cur = seed.nodes.find((x) => x.key === n.key)
  if (cur === undefined) seed.nodes.push(n)
  else {
    cur.evidence.push(...n.evidence)
    if (cur.techStack === null) cur.techStack = n.techStack
    if (cur.namespace === null) cur.namespace = n.namespace
  }
}

export async function seedRepository(root: string): Promise<Seed> {
  const files = await walk(root)
  const seed: Seed = { nodes: [], links: [], files: [], notes: [] }
  for (const f of files) {
    const b = basename(f).toLowerCase()
    if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b)) {
      seed.files.push(f)
      await fromCompose(root, f, seed)
    }
  }
  for (const f of files) {
    if (!/\.ya?ml$/i.test(f) || /compose/i.test(basename(f))) continue
    if (/[\\/](k8s|kubernetes|manifests|deploy|charts|helm|kustomize|infra|ops)[\\/]/i.test(f)) {
      seed.files.push(f)
      await fromK8s(root, f, seed)
    }
  }
  await fromManifests(root, files, seed)
  return seed
}
