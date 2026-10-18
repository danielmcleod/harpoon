// Attaching a file to a Notion page through Notion's public API (the Notion MCP server cannot upload files): create
// a file upload, send the bytes, then append a file block to the page. Uses the integration token the user pasted in
// settings; nothing else is sent.
const API = 'https://api.notion.com/v1'
const VERSION = '2022-06-28'

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

export class NotionApiError extends Error {}

async function call(fetchFn: FetchFn, token: string, path: string, method: string, body?: unknown, form?: FormData): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetchFn(`${API}${path}`, { method, headers, ...(form !== undefined ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? text
    } catch {
      // not JSON
    }
    throw new NotionApiError(res.status === 401 ? 'Notion rejected the token (check the integration token).' : res.status === 404 ? 'Notion cannot see that page: share it with your integration (page ⋯ → Connections).' : `Notion API ${res.status}: ${msg.slice(0, 300)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

/** Upload `bytes` and add it to the end of the page as a file block. Returns the file upload id. */
export async function attachFileToPage(o: { fetch: FetchFn; token: string; pageId: string; filename: string; contentType: string; bytes: Uint8Array; caption?: string }): Promise<string> {
  if (o.bytes.byteLength > 20 * 1024 * 1024) throw new NotionApiError('The bundle is over 20 MB, the limit for a single Notion upload.')
  const created = await call(o.fetch, o.token, '/file_uploads', 'POST', { mode: 'single_part', filename: o.filename, content_type: o.contentType })
  const id = created['id']
  if (typeof id !== 'string') throw new NotionApiError('Notion did not return an upload id.')
  const form = new FormData()
  // Copied into a plain ArrayBuffer (a Node Buffer may sit on a shared pool).
  form.append('file', new Blob([new Uint8Array(o.bytes).buffer], { type: o.contentType }), o.filename)
  await call(o.fetch, o.token, `/file_uploads/${id}/send`, 'POST', undefined, form)
  await call(o.fetch, o.token, `/blocks/${o.pageId}/children`, 'PATCH', {
    children: [
      {
        object: 'block',
        type: 'file',
        file: { type: 'file_upload', file_upload: { id }, name: o.filename, ...(o.caption !== undefined ? { caption: [{ type: 'text', text: { content: o.caption } }] } : {}) },
      },
    ],
  })
  return id
}
