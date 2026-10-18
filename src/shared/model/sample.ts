// A sample architecture (the mockups' commerce platform): gateway, an auth service with its own inner architecture,
// users, payments with an event stream, a notification worker, and third-party SaaS. Used by "New sample project" and
// by tests; built entirely from ops, like everything else.
import type { Op } from './ops.ts'
import { BoundaryZ, ChannelZ, ConnectorZ, FeatureZ, FlowZ, NodeZ } from './schema.ts'
import type { HexCoord, HxConnectorInput, HxNodeInput } from './schema.ts'

const SEED = { source: 'seed' as const, runId: null, at: 0 }

function node(n: HxNodeInput & { at: HexCoord }): Op {
  const { at, ...rest } = n
  return { op: 'addNode', node: NodeZ.parse({ provenance: SEED, ...rest }), at }
}

function conn(c: Omit<HxConnectorInput, 'channelA' | 'channelB'> & { a: string; b?: string | null; auth?: string }): Op {
  const { a, b, auth, ...rest } = c
  return {
    op: 'addConnector',
    connector: ConnectorZ.parse({
      provenance: SEED,
      ...rest,
      duplex: b !== null,
      channelA: ChannelZ.parse({ protocol: a, auth: auth ?? null }),
      channelB: b === null ? null : ChannelZ.parse({ protocol: b ?? a }),
    }),
  }
}

const feature = (f: Parameters<typeof FeatureZ.parse>[0]) => FeatureZ.parse(f)

export function sampleOps(): Op[] {
  return [
    node({ id: 'clients', name: 'Web & Mobile', kind: 'client', boundary: 'external', at: { q: -4, r: 2 }, sim: { entryRps: 900, capacityRps: null, latencyMs: null, errorRate: null } }),
    node({
      id: 'api-gateway',
      name: 'API Gateway',
      kind: 'gateway',
      techStack: 'Envoy',
      at: { q: -2, r: 1 },
      description: 'Edge gateway: TLS termination, routing, per-client rate limits.',
      features: [
        feature({ id: 'routing', name: 'Routing', category: 'api', protocol: 'HTTPS', endpoint: '/api/*' }),
        feature({ id: 'rate-limit', name: 'Rate Limiting', category: 'security', description: '1000 req/min per API key.' }),
      ],
      sim: { capacityRps: 5000, latencyMs: 3, errorRate: 0.001, entryRps: null },
    }),
    node({
      id: 'auth-service',
      name: 'auth-service',
      kind: 'service',
      techStack: 'Go',
      role: 'Go Microservice',
      at: { q: 0, r: -1 },
      description: 'Issues and validates tokens; owns users and sessions.',
      features: [
        feature({
          id: 'jwt-validation',
          name: 'JWT validation',
          category: 'security',
          protocol: 'gRPC',
          endpoint: 'rpc ValidateToken(TokenReq) returns (Claims)',
          contract: {
            kind: 'example',
            body: 'func ValidateToken(ctx context.Context, t string) (*Claims, error) {\n  config := Config{Issuer: "hexflow.auth"}\n  return verify(t, config)\n}',
          },
          sla: { p50Ms: 4, p99Ms: 12, maxRps: 8000 },
        }),
        feature({ id: 'oauth2', name: 'OAuth2', category: 'security', protocol: 'HTTPS', endpoint: 'POST /oauth/token' }),
        feature({ id: 'auth-rate-limit', name: 'Rate Limiting', category: 'security' }),
        feature({ id: 'mtls', name: 'mTLS Termination', category: 'security' }),
        feature({ id: 'audit-log', name: 'Audit Logging', category: 'data', protocol: 'Kafka' }),
      ],
      sim: { capacityRps: 2500, latencyMs: 12, errorRate: 0.002, entryRps: null },
    }),
    node({ id: 'user-api', parentId: 'auth-service', name: 'user-api', kind: 'process', at: { q: -1, r: 0 } }),
    node({ id: 'auth-worker', parentId: 'auth-service', name: 'auth-worker', kind: 'worker', at: { q: 0, r: -1 } }),
    node({ id: 'session-manager', parentId: 'auth-service', name: 'session-manager', kind: 'process', at: { q: 1, r: 0 } }),
    node({ id: 'user-db', parentId: 'auth-service', name: 'user-db', kind: 'database', techStack: 'PostgreSQL', at: { q: -1, r: 1 } }),
    node({ id: 'cache-redis', parentId: 'auth-service', name: 'cache-redis', kind: 'cache', techStack: 'Redis', at: { q: 0, r: 1 } }),
    node({
      id: 'user-service',
      name: 'user-service',
      kind: 'service',
      techStack: 'Node.js',
      at: { q: 0, r: 1 },
      features: [feature({ id: 'profiles', name: 'Profiles', protocol: 'gRPC', endpoint: 'rpc GetProfile(Id) returns (Profile)' })],
      sim: { capacityRps: 3000, latencyMs: 8, errorRate: 0.001, entryRps: null },
    }),
    node({
      id: 'payment-api',
      name: 'payment-api',
      kind: 'service',
      techStack: 'Kotlin',
      at: { q: 2, r: 0 },
      features: [
        feature({ id: 'charge', name: 'Charge', protocol: 'HTTPS', endpoint: 'POST /v1/charge', sla: { p50Ms: 120, p99Ms: 600, maxRps: 400 } }),
        feature({ id: 'refund', name: 'Refund', protocol: 'HTTPS', endpoint: 'POST /v1/refund' }),
      ],
      sim: { capacityRps: 600, latencyMs: 40, errorRate: 0.004, entryRps: null },
    }),
    node({ id: 'payments-core', parentId: 'payment-api', name: 'payments-core', kind: 'process', at: { q: 0, r: 0 } }),
    node({ id: 'ledger-db', parentId: 'payment-api', name: 'ledger-db', kind: 'database', techStack: 'PostgreSQL', at: { q: 1, r: 0 } }),
    node({ id: 'payment-events', name: 'payment-events', kind: 'stream', techStack: 'Kafka', at: { q: 2, r: 1 } }),
    node({
      id: 'notification-worker',
      name: 'notification-worker',
      kind: 'worker',
      techStack: 'Python',
      at: { q: 1, r: 2 },
      sim: { capacityRps: 300, latencyMs: 25, errorRate: 0.002, entryRps: null },
    }),
    node({ id: 'stripe', name: 'Stripe API', kind: 'saas', boundary: 'external', vendor: 'Stripe', at: { q: 4, r: -1 }, sim: { capacityRps: 2000, latencyMs: 180, errorRate: 0.003, entryRps: null } }),
    node({ id: 'sendgrid', name: 'SendGrid', kind: 'saas', boundary: 'external', vendor: 'Twilio SendGrid', at: { q: 4, r: 0 } }),
    node({ id: 'external-directory', name: 'External Directory', kind: 'identity', boundary: 'external', vendor: 'Okta', at: { q: 2, r: -3 } }),

    conn({ id: 'clients-gateway', source: 'clients', target: 'api-gateway', a: 'HTTPS', auth: 'OAuth2 bearer' }),
    conn({ id: 'gateway-auth', source: 'api-gateway', target: 'user-api', a: 'gRPC', auth: 'mTLS', sim: { fanout: 1, payloadKb: 2 } }),
    conn({ id: 'gateway-users', source: 'api-gateway', target: 'user-service', a: 'gRPC', auth: 'mTLS', sim: { fanout: 0.6, payloadKb: 4 } }),
    conn({ id: 'gateway-payments', source: 'api-gateway', target: 'payments-core', a: 'HTTPS', auth: 'mTLS', sim: { fanout: 0.15, payloadKb: 3 } }),
    conn({ id: 'users-auth', source: 'user-service', target: 'user-api', a: 'gRPC', auth: 'mTLS' }),
    conn({ id: 'userapi-db', source: 'user-api', target: 'user-db', a: 'SQL' }),
    conn({ id: 'userapi-worker', source: 'user-api', target: 'auth-worker', a: 'gRPC' }),
    conn({ id: 'userapi-session', source: 'user-api', target: 'session-manager', a: 'In-process', b: null }),
    conn({ id: 'session-cache', source: 'session-manager', target: 'cache-redis', a: 'Redis' }),
    conn({ id: 'worker-cache', source: 'auth-worker', target: 'cache-redis', a: 'Redis' }),
    conn({ id: 'worker-directory', source: 'auth-worker', target: 'external-directory', a: 'HTTPS', b: 'HTTPS', auth: 'OAuth2 client credentials', sync: 'sync' }),
    conn({ id: 'payments-ledger', source: 'payments-core', target: 'ledger-db', a: 'SQL' }),
    conn({ id: 'payments-stripe', source: 'payments-core', target: 'stripe', a: 'HTTPS', b: 'Webhook', auth: 'API key', policies: { timeoutMs: 3000, retries: 2, backoff: 'exponential', circuitBreaker: true } }),
    conn({ id: 'payments-events', source: 'payments-core', target: 'payment-events', a: 'Kafka', b: null, sync: 'async' }),
    conn({ id: 'events-notify', source: 'payment-events', target: 'notification-worker', a: 'Kafka', b: 'Ack', sync: 'async' }),
    conn({ id: 'notify-sendgrid', source: 'notification-worker', target: 'sendgrid', a: 'HTTPS', auth: 'API key' }),
    conn({ id: 'notify-users', source: 'notification-worker', target: 'user-service', a: 'gRPC' }),

    {
      op: 'addBoundary',
      boundary: BoundaryZ.parse({
        id: 'internal-vpc',
        name: 'Internal VPC',
        type: 'vpc',
        nodeIds: ['api-gateway', 'auth-service', 'user-service', 'payment-api', 'payment-events', 'notification-worker'],
      }),
    },
    {
      op: 'addBoundary',
      boundary: BoundaryZ.parse({ id: 'third-party', name: 'Third-Party SaaS', type: 'third-party', nodeIds: ['stripe', 'sendgrid'] }),
    },
    {
      op: 'addFlow',
      flow: FlowZ.parse({
        id: 'login',
        name: 'Login',
        description: 'A user signs in and gets a session.',
        steps: [
          { connectorId: 'clients-gateway' },
          { connectorId: 'gateway-auth' },
          { connectorId: 'userapi-db' },
          { connectorId: 'userapi-session' },
          { connectorId: 'session-cache' },
          { connectorId: 'gateway-auth', direction: 'B' },
          { connectorId: 'clients-gateway', direction: 'B' },
        ],
      }),
    },
    {
      op: 'addFlow',
      flow: FlowZ.parse({
        id: 'checkout',
        name: 'Checkout',
        description: 'A customer pays; the receipt is emailed asynchronously.',
        weight: 0.3,
        steps: [
          { connectorId: 'clients-gateway' },
          { connectorId: 'gateway-payments' },
          { connectorId: 'payments-stripe' },
          { connectorId: 'payments-ledger' },
          { connectorId: 'payments-events' },
          { connectorId: 'events-notify' },
          { connectorId: 'notify-sendgrid' },
        ],
      }),
    },
    { op: 'updateMeta', patch: { description: 'Sample commerce platform: edge gateway, auth, users, payments and notifications.' } },
  ]
}
