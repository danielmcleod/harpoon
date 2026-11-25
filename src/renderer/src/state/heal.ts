// "Fix with AI" on an error toast: the AI finds out why an action failed and fixes what is in the project, or says
// what to do. It gets the action, the error and where the check failed, never the request's values (they may hold
// tokens or private text).
import { ask } from './ai.ts'
import { toast } from './actions.ts'
import { getState } from './store.ts'
import type { Toast } from './store.ts'

export function canHealWithAi(): boolean {
  const s = getState()
  return s.project !== null && s.ui.mode !== 'docs'
}

export function healWithAi(t: Toast): void {
  if (t.failed === undefined) return
  if (getState().project === null) return toast('Open a project to fix this with AI.', 'warn')
  const issues = t.failed.issues.length > 0 ? `\nWhere the check failed:\n${t.failed.issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}` : ''
  void ask(`This Harpoon action failed: ${t.failed.cmd}\nError (${t.failed.code}): ${t.message}${issues}\n\nFind out why, and fix it.`, { mode: 'heal' })
}
