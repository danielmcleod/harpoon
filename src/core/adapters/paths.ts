// Paths in tool lines (PassCard tool rows): a file inside the pass folder reads relative to it, so
// a clipped one-line summary keeps the file name. Codex (live X03a) and Claude (live balanced run) report absolute
// paths; a path anywhere else stays as given.

/**
 * A path inside the pass folder, relative to it with forward slashes; any other path as given. Codex reports a file
 * change by its absolute path (live X03a), which would push the file name out of a clipped summary.
 */
export function relativeTo(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const unify = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = unify(path)
  const c = unify(cwd)
  // A drive-letter folder compares case-insensitively, as Windows does.
  const fold = /^[A-Za-z]:\//.test(c)
  const head = p.slice(0, c.length)
  const inside = p.length > c.length + 1 && p[c.length] === '/'
  if (inside && (fold ? head.toLowerCase() === c.toLowerCase() : head === c)) return p.slice(c.length + 1)
  return path
}
