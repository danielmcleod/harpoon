// The one https host allowlist for links that open in the default browser (the `open_docs` executor: https only,
// and only allowlisted hosts; boot hardening). Core validates `open_docs` actions with it and
// main checks every openExternal against it again, so the two can never disagree.

/** https hosts links may open in the default browser (subdomains included). */
export const EXTERNAL_HOSTS: readonly string[] = [
  'anthropic.com',
  'claude.ai',
  'claude.com',
  'openai.com',
  'chatgpt.com',
  'github.com',
  'google.dev',
  'ai.google.dev',
  'nodejs.org',
  'git-scm.com',
  'docs.x.ai',
  // Muse's docs (https://dev.meta.ai/docs/muse-code, with dev.meta.ai allowed for open_docs); without it, Muse's docs
  // link was dropped, because only heal/commands.ts DOCS_HOSTS had it.
  'dev.meta.ai',
]

/**
 * The href to open in the default browser, or null: https only, a host on the allowlist (or its subdomain), no
 * credentials and no custom port.
 */
export function allowedExternalUrl(raw: string, hosts: readonly string[] = EXTERNAL_HOSTS): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '' || u.port !== '') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? u.href : null
}
