// Share menu: the zip bundle, the interactive HTML viewer, pictures (SVG, PNG, draw.io), docs (ARCHITECTURE.md), diagram code
// (Mermaid, PlantUML) and data (native JSON, the LLM interchange JSON, the JSON Schema). Pictures use the current
// view: what is focused and expanded, the node style and the theme.
import { publishWithAi } from '../settings/NotionTab.tsx'
import { openSettings } from '../settings/ProjectSettings.tsx'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { BookOpen, Braces, Check, ChevronDown, Code2, FileCode2, FileImage, FileText, Globe, Image, Package, Send, Settings2, Share2, Workflow } from 'lucide-react'
import type { ExportFormat, ExportView } from '@shared/ipc.ts'
import { Button } from '../components/ui/Button.tsx'
import { MenuItem } from '../app/TopBar.tsx'
import { invoke } from '../ipc/client.ts'
import { toast } from '../state/actions.ts'
import { getState } from '../state/store.ts'

/** Whether shared exports include working notes (per session; off by default). */
let includeNotes = false

export function currentExportView(): ExportView {
  const s = getState()
  return { focusId: s.ui.focusId, expanded: Object.keys(s.ui.expanded), style: s.prefs.nodeStyle, theme: s.theme.resolved, includeNotes }
}

async function saveText(format: ExportFormat): Promise<void> {
  const r = await invoke('export.render', { format, view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  const saved = await invoke('export.save', { filename: r.value.filename, content: r.value.content })
  if (!saved.ok) return toast(saved.error.message, 'error')
  if (saved.value !== null) toast(`Saved ${saved.value}`)
}

async function copyText(format: ExportFormat): Promise<void> {
  const r = await invoke('export.render', { format, view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  await navigator.clipboard.writeText(r.value.content)
  toast('Copied to the clipboard.')
}

/** The current view as PNG (base64), rasterized here from the self-contained SVG. */
async function renderPng(): Promise<{ base64: string; filename: string }> {
  const r = await invoke('export.render', { format: 'svg', view: currentExportView() })
  if (!r.ok) throw new Error(r.error.message)
  const url = URL.createObjectURL(new Blob([r.value.content], { type: 'image/svg+xml' }))
  try {
    const img = new window.Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not render the picture.'))
      img.src = url
    })
    const scale = Math.min(2, 8000 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('No canvas.')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { base64: canvas.toDataURL('image/png').split(',')[1] ?? '', filename: r.value.filename.replace(/\.svg$/, '.png') }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Pages for Notion's Markdown import: overview with the diagram, architecture, roadmap, decisions, the bundle. */
async function saveNotion(): Promise<void> {
  const png = await renderPng().catch(() => null)
  const r = await invoke('export.notion', { view: currentExportView(), png: png?.base64 ?? null })
  if (!r.ok) return toast(r.error.message, 'error')
  if (r.value !== null) toast(`Saved ${r.value}. In Notion: Settings → Import → Text & Markdown, then pick the zip.`)
}

/** SVG → PNG at 2× in the renderer (the SVG is self-contained), then saved by main. */
async function savePng(): Promise<void> {
  const r = await invoke('export.render', { format: 'svg', view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  const url = URL.createObjectURL(new Blob([r.value.content], { type: 'image/svg+xml' }))
  try {
    const img = new window.Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not render the picture.'))
      img.src = url
    })
    const scale = Math.min(2, 8000 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('No canvas.')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? ''
    const saved = await invoke('export.save', { filename: r.value.filename.replace(/\.svg$/, '.png'), base64 })
    if (!saved.ok) return toast(saved.error.message, 'error')
    if (saved.value !== null) toast(`Saved ${saved.value}`)
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function saveBundle(): Promise<void> {
  const r = await invoke('export.bundle', { view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  if (r.value !== null) toast(`Saved the share bundle: ${r.value}`)
}

async function saveViewer(): Promise<void> {
  const r = await invoke('export.viewer', { view: currentExportView() })
  if (!r.ok) return toast(r.error.message, 'error')
  if (r.value !== null) toast(`Saved the viewer: ${r.value}. Anyone can open it in a browser.`)
}

export function ExportMenu(): React.JSX.Element {
  const [notes, setNotes] = useState(includeNotes)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="outline" icon={<Share2 />} aria-label="Share" title="Share and export">
          <span className="hidden xl:inline">Share</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-64 rounded-lg border bg-popover p-1 text-sm shadow-lg">
          <Label>Share</Label>
          <DropdownMenu.CheckboxItem
            checked={notes}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => {
              includeNotes = v
              setNotes(v)
            }}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-highlighted:bg-accent"
          >
            <span className="flex size-4 items-center justify-center rounded border">{notes && <Check className="size-3" />}</span>
            Include working notes in exports
          </DropdownMenu.CheckboxItem>
          <MenuItem icon={<Package />} onSelect={() => void saveBundle()}>
            Share bundle (.zip)…
          </MenuItem>
          <p className="px-8 pb-1 text-[10.5px] text-muted-foreground">Viewer, docs, pictures, diagram code and the project, in one file.</p>
          <MenuItem icon={<Globe />} onSelect={() => void saveViewer()}>
            Interactive HTML viewer…
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Label>Notion</Label>
          <MenuItem icon={<BookOpen />} onSelect={() => void saveNotion()}>
            Notion import (.zip)…
          </MenuItem>
          <MenuItem icon={<Send />} onSelect={() => void publishWithAi()}>
            Publish to Notion with AI
          </MenuItem>
          <MenuItem icon={<Settings2 />} onSelect={() => openSettings('notion')}>
            Notion settings…
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Label>Pictures (current view)</Label>
          <MenuItem icon={<Image />} onSelect={() => void savePng()}>
            PNG image…
          </MenuItem>
          <MenuItem icon={<FileImage />} onSelect={() => void saveText('svg')}>
            SVG vector…
          </MenuItem>
          <MenuItem icon={<Workflow />} onSelect={() => void saveText('drawio')}>
            draw.io diagram…
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Label>Docs & diagram code</Label>
          <MenuItem icon={<FileText />} onSelect={() => void saveText('markdown')}>
            ARCHITECTURE.md…
          </MenuItem>
          <MenuItem icon={<Code2 />} onSelect={() => void copyText('mermaid')}>
            Copy Mermaid flowchart
          </MenuItem>
          <MenuItem icon={<Code2 />} onSelect={() => void copyText('mermaid-sequence')}>
            Copy Mermaid sequence diagrams (flows)
          </MenuItem>
          <MenuItem icon={<FileCode2 />} onSelect={() => void saveText('plantuml')}>
            PlantUML C4…
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <Label>Data</Label>
          <MenuItem icon={<Braces />} onSelect={() => void saveText('harpoon-json')}>
            Single-file design (.harpoon.json)…
          </MenuItem>
          <MenuItem icon={<Braces />} onSelect={() => void saveText('interchange-json')}>
            Interchange JSON (for LLMs and tools)…
          </MenuItem>
          <MenuItem icon={<Braces />} onSelect={() => void saveText('json-schema')}>
            JSON Schema…
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <DropdownMenu.Label className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</DropdownMenu.Label>
}
