// Every export sends the canvas's current view; the request check must take all of it (detail included).
import { describe, expect, it } from 'vitest'
import { parseRequest } from '../../src/shared/ipc-schemas.ts'

const view = { focusId: null, expanded: ['auth-service'], detail: 'overview', style: 'flat', theme: 'dark', includeNotes: false }

describe('export view', () => {
  it('takes the detail level the canvas shows', () => {
    expect(parseRequest('export.render', { format: 'mermaid', view }).ok).toBe(true)
    expect(parseRequest('export.notion', { view, png: null }).ok).toBe(true)
    expect(parseRequest('export.render', { format: 'mermaid', view: { ...view, detail: 'everything' } }).ok).toBe(false)
  })
})
