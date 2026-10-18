// `codex exec --json` items (snake_case, a lossy copy of the app-server's) → app-server ThreadItem shapes, so one
// mapper (map-item.ts) serves both routes.
// exec JSONL: thread.started{thread_id} · turn.started · turn.completed{usage} · turn.failed{error} ·
// item.started/updated/completed{item} · error{message}.
import type { Rec } from './wire.ts'
import { arr, rec, str } from './wire.ts'

const STATUS: Readonly<Record<string, string>> = {
  in_progress: 'inProgress',
  completed: 'completed',
  failed: 'failed',
  declined: 'declined',
}

/** exec's snake_case web search actions → the app-server's WebSearchAction tags. */
const ACTION: Readonly<Record<string, string>> = {
  open_page: 'openPage',
  find_in_page: 'findInPage',
}

const status = (v: unknown): string | undefined => {
  const s = str(v)
  return s === undefined ? undefined : (STATUS[s] ?? s)
}

/** One exec item as the app-server would report it; `todoList` / `error` keep exec's own payloads. */
export function execItemToThreadItem(item: unknown): Rec | undefined {
  const i = rec(item)
  if (i === undefined) return undefined
  const id = str(i['id']) ?? ''
  switch (str(i['type']) ?? '') {
    case 'agent_message':
      return { type: 'agentMessage', id, text: str(i['text']) ?? '' }
    case 'reasoning':
      return { type: 'reasoning', id, summary: [str(i['text']) ?? ''], content: [] }
    case 'command_execution':
      return {
        type: 'commandExecution',
        id,
        command: str(i['command']) ?? '',
        commandActions: [],
        aggregatedOutput: str(i['aggregated_output']) ?? null,
        exitCode: typeof i['exit_code'] === 'number' ? i['exit_code'] : null,
        status: status(i['status']) ?? 'inProgress',
      }
    case 'file_change':
      return {
        type: 'fileChange',
        id,
        changes: arr(i['changes']).flatMap((c) => {
          const r = rec(c)
          const path = str(r?.['path'])
          return path === undefined ? [] : [{ path, kind: { type: str(r?.['kind']) ?? 'update' }, diff: '' }]
        }),
        status: status(i['status']) ?? 'inProgress',
      }
    case 'mcp_tool_call':
      return {
        type: 'mcpToolCall',
        id,
        server: str(i['server']) ?? 'mcp',
        tool: str(i['tool']) ?? 'tool',
        arguments: i['arguments'] ?? null,
        error: i['error'] ?? null,
        status: status(i['status']) ?? 'inProgress',
      }
    case 'collab_tool_call':
      return {
        type: 'collabAgentToolCall',
        id,
        tool: str(i['tool']) ?? 'agent',
        prompt: str(i['prompt']) ?? null,
        status: status(i['status']) ?? 'inProgress',
      }
    case 'web_search': {
      const action = rec(i['action'])
      const type = str(action?.['type'])
      return {
        type: 'webSearch',
        id,
        query: str(i['query']) ?? '',
        action:
          action === undefined
            ? null
            : { ...action, ...(type !== undefined ? { type: ACTION[type] ?? type } : {}) },
        // The pages an opened-page item read (live X17 on app-server; kept should exec carry them too).
        results: Array.isArray(i['results']) ? i['results'] : null,
      }
    }
    case 'todo_list':
      return { type: 'todoList', id, items: arr(i['items']) }
    case 'error':
      return { type: 'error', id, message: str(i['message']) ?? '' }
    default:
      return undefined
  }
}

/** exec todo_list items `[{text, completed}]` as todo steps. */
export function execTodoSteps(items: unknown): { text: string; done: boolean }[] {
  return arr(items).flatMap((x) => {
    const r = rec(x)
    const text = str(r?.['text'])
    return text === undefined ? [] : [{ text, done: r?.['completed'] === true }]
  })
}
