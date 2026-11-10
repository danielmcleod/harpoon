// Which nodes a note mentions (plain text in, ids out: no store, no window).

/** A mention's id as written: percent-decoded when it decodes, else as it stands (a stray `%` must not throw). */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Node ids a note body mentions (`[@Name](harpoon:node/<id>)`). */
export function mentionedNodes(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/\(harpoon:node\/([^)\s]+)\)/g)]
        .map((m) => decodeId(m[1] ?? ''))
        .filter((x) => x !== ''),
    ),
  ]
}
