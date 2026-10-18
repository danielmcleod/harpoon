// One entry point for every text/picture export (the export menu and the CLI share it).
import { slugify } from '../../shared/model/ids.ts'
import type { DecisionRecord, ExportFormat, ExportResult, ExportView, Proposal } from '../../shared/ipc.ts'
import { withoutNotes } from '../../shared/model/governance.ts'
import type { Model } from '../../shared/model/schema.ts'
import { HarpoonError } from '../errors.ts'
import { architectureMarkdown, implementationBrief } from './docs.ts'
import { harpoonJson, interchangeJson, mermaidFlowchart, mermaidSequences, plantUml, projectJsonSchema } from './formats.ts'
import { renderDrawio, renderSvg } from '../../shared/export/svg.ts'

export function renderExport(full: Model, format: ExportFormat, view: ExportView, proposal?: Proposal, decisions: readonly DecisionRecord[] = []): ExportResult {
  const base = slugify(full.meta.name)
  // Harpoon JSON stays lossless; everything else leaves working notes out unless asked.
  const m = view.includeNotes === true ? full : withoutNotes(full)
  switch (format) {
    case 'harpoon-json':
      return { filename: `${base}.harpoon.json`, content: harpoonJson(full), mime: 'application/json' }
    case 'interchange-json':
      return { filename: `${base}.topology.json`, content: interchangeJson(m), mime: 'application/json' }
    case 'json-schema':
      return { filename: 'harpoon-project.schema.json', content: projectJsonSchema(), mime: 'application/schema+json' }
    case 'mermaid':
      return { filename: `${base}.mmd`, content: mermaidFlowchart(m), mime: 'text/plain' }
    case 'mermaid-sequence':
      return { filename: `${base}-flows.mmd`, content: mermaidSequences(m), mime: 'text/plain' }
    case 'plantuml':
      return { filename: `${base}.puml`, content: plantUml(m), mime: 'text/plain' }
    case 'drawio':
      return { filename: `${base}.drawio`, content: renderDrawio(m, view), mime: 'application/xml' }
    case 'svg':
      return { filename: `${base}.svg`, content: renderSvg(m, view), mime: 'image/svg+xml' }
    case 'markdown':
      return { filename: 'ARCHITECTURE.md', content: architectureMarkdown(m, decisions), mime: 'text/markdown' }
    case 'brief':
      if (proposal === undefined) throw new HarpoonError('VALIDATION', 'An implementation brief needs a proposal.')
      return { filename: `brief-${slugify(proposal.title)}.md`, content: implementationBrief(m, proposal), mime: 'text/markdown' }
  }
}
