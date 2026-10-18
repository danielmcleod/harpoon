// What each node kind looks like and means: palette label, icon (a lucide name the renderer maps), canvas colour
// token, and the defaults a new node of that kind gets. Shared by the palette, the AI vocabulary and the importers.
import type { NodeKind } from './schema.ts'

export type KindColor = 'cyan' | 'violet' | 'blue' | 'green' | 'amber' | 'rose' | 'slate'

export interface KindInfo {
  label: string
  /** One line for the palette tooltip and the AI vocabulary. */
  hint: string
  icon: string
  color: KindColor
  /** Usually lives outside the system (saas, identity providers, clients). */
  externalByDefault: boolean
}

export const KIND_INFO: Readonly<Record<NodeKind, KindInfo>> = {
  system: { label: 'System', hint: 'A tier, domain or subsystem that groups services', icon: 'boxes', color: 'violet', externalByDefault: false },
  service: { label: 'Service', hint: 'A deployable service or microservice', icon: 'cpu', color: 'blue', externalByDefault: false },
  gateway: { label: 'Gateway', hint: 'API gateway, load balancer, ingress or BFF', icon: 'network', color: 'violet', externalByDefault: false },
  database: { label: 'Database', hint: 'Relational or document database', icon: 'database', color: 'blue', externalByDefault: false },
  cache: { label: 'Cache', hint: 'Redis, Memcached or an in-process cache', icon: 'layers', color: 'cyan', externalByDefault: false },
  queue: { label: 'Queue', hint: 'Message queue (SQS, RabbitMQ)', icon: 'list-ordered', color: 'amber', externalByDefault: false },
  stream: { label: 'Stream', hint: 'Event stream or bus (Kafka, Kinesis, Pub/Sub)', icon: 'waves', color: 'amber', externalByDefault: false },
  worker: { label: 'Worker', hint: 'Background worker or consumer', icon: 'cog', color: 'green', externalByDefault: false },
  function: { label: 'Function', hint: 'Serverless function or lambda', icon: 'zap', color: 'green', externalByDefault: false },
  storage: { label: 'Storage', hint: 'Object or file storage (S3, blob)', icon: 'hard-drive', color: 'slate', externalByDefault: false },
  cdn: { label: 'CDN', hint: 'Content delivery or edge network', icon: 'globe', color: 'cyan', externalByDefault: true },
  client: { label: 'Client', hint: 'Browser, mobile app, CLI or another caller', icon: 'monitor-smartphone', color: 'slate', externalByDefault: true },
  identity: { label: 'Identity', hint: 'Identity provider or auth server (Auth0, Okta)', icon: 'key-round', color: 'rose', externalByDefault: true },
  saas: { label: 'SaaS', hint: 'Third-party API or service (Stripe, Twilio)', icon: 'cloud', color: 'amber', externalByDefault: true },
  scheduler: { label: 'Scheduler', hint: 'Cron, workflow or job scheduler', icon: 'clock', color: 'green', externalByDefault: false },
  observability: { label: 'Observability', hint: 'Logs, metrics, traces, alerting', icon: 'activity', color: 'rose', externalByDefault: false },
  process: { label: 'Process', hint: 'A runtime process inside a service', icon: 'box', color: 'blue', externalByDefault: false },
  module: {
    label: 'Module',
    hint: 'A responsibility inside a service (billing, reporting…); need not connect to the other parts, but may have its own connections',
    icon: 'puzzle',
    color: 'cyan',
    externalByDefault: false,
  },
  frontend: { label: 'Web app', hint: 'Browser front end: SPA, SSR site, micro-frontend', icon: 'app-window', color: 'cyan', externalByDefault: false },
  mobile: { label: 'Mobile app', hint: 'iOS / Android / cross-platform app', icon: 'smartphone', color: 'cyan', externalByDefault: false },
  desktop: { label: 'Desktop app', hint: 'Desktop or thick-client application', icon: 'monitor', color: 'cyan', externalByDefault: false },
  device: { label: 'Device', hint: 'IoT / edge device, kiosk, sensor, PLC', icon: 'circuit-board', color: 'green', externalByDefault: false },
  search: { label: 'Search', hint: 'Search index (Elasticsearch, OpenSearch, Algolia)', icon: 'search', color: 'blue', externalByDefault: false },
  ml: { label: 'AI / ML', hint: 'Model serving, LLM, feature store, inference endpoint', icon: 'brain-circuit', color: 'violet', externalByDefault: false },
  warehouse: { label: 'Warehouse', hint: 'Data warehouse or lake (Snowflake, BigQuery, Databricks)', icon: 'warehouse', color: 'blue', externalByDefault: false },
  pipeline: { label: 'Pipeline', hint: 'ETL / ELT, stream processing, batch jobs (Airflow, Flink, Spark)', icon: 'workflow', color: 'green', externalByDefault: false },
  network: { label: 'Network', hint: 'Load balancer, firewall, WAF, VPN, DNS, service mesh', icon: 'router', color: 'slate', externalByDefault: false },
  legacy: { label: 'Legacy', hint: 'Mainframe, ERP or on-prem system of record', icon: 'server', color: 'slate', externalByDefault: false },
}

export const HOSTING_LABEL = {
  cloud: 'Cloud',
  'on-prem': 'On-prem',
  hybrid: 'Hybrid',
  saas: 'SaaS',
  edge: 'Edge',
  device: 'On device',
  serverless: 'Serverless',
} as const

/** Common protocols offered in pickers and told to the AI (free text is still allowed). */
export const PROTOCOLS = [
  // web & APIs
  'HTTPS',
  'HTTP',
  'REST',
  'GraphQL',
  'gRPC',
  'gRPC-Web',
  'SOAP',
  'JSON-RPC',
  'Thrift',
  'WebSocket',
  'SSE',
  'WebRTC',
  'Webhook',
  // messaging & streaming
  'Kafka',
  'AMQP',
  'MQTT',
  'NATS',
  'Pub/Sub',
  'SQS',
  'SNS',
  'JMS',
  'IBM MQ',
  'Event Hubs',
  'Kinesis',
  // data
  'SQL',
  'JDBC',
  'ODBC',
  'Redis',
  'MongoDB',
  'S3',
  'NFS',
  'SMB',
  // identity & security
  'OAuth2',
  'OIDC',
  'SAML',
  'LDAP',
  'Kerberos',
  // mobile, devices & industrial
  'APNs',
  'FCM',
  'BLE',
  'CoAP',
  'Modbus',
  'OPC UA',
  // files, email, B2B, health
  'SFTP',
  'FTP',
  'SMTP',
  'AS2',
  'EDI',
  'HL7',
  'FHIR',
  // transport & local
  'TCP',
  'UDP',
  'SSH',
  'VPN',
  'IPC',
  'In-process',
] as const

export type ProtocolFamily = 'http' | 'rpc' | 'stream' | 'data' | 'other'

/** Colour family of a protocol badge. */
export function protocolFamily(protocol: string | null | undefined): ProtocolFamily {
  const p = (protocol ?? '').toLowerCase()
  if (/grpc|thrift|rpc|soap|ipc|in-process/.test(p)) return 'rpc'
  if (/kafka|amqp|mqtt|pub\/?sub|sqs|sns|queue|stream|event|websocket|wss|sse|nats|jms|\bmq\b|kinesis|apns|fcm|coap/.test(p)) return 'stream'
  if (/sql|redis|s3|mongo|postgres|mysql|dynamo|cache|jdbc|odbc|nfs|smb|ftp|edi|as2|hl7|fhir/.test(p)) return 'data'
  if (/http|rest|graphql|webhook|api|webrtc|oauth|oidc|saml/.test(p)) return 'http'
  return 'other'
}
