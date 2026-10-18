// Smoke: the built app starts, opens a project from the recent list, and a node added from the palette is saved.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('opens a project and adds a node', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hp-e2e-home-'))
  const root = await mkdtemp(join(tmpdir(), 'hp-e2e-proj-'))
  await writeFile(
    join(home, 'state.json'),
    JSON.stringify({ schemaVersion: 1, theme: 'dark', nodeStyle: 'flat', recentProjects: [{ path: root, name: 'Smoke', openedAt: Date.now() }] }),
  )
  const app = await electron.launch({ args: ['.'], env: { ...process.env, HARPOON_HOME: home } })
  try {
    const win = await app.firstWindow()
    // The recent entry has no project yet: opening it creates one.
    await win.getByRole('button', { name: /^Smoke/ }).click()
    await expect(win.getByText('Architecture', { exact: true })).toBeVisible()
    await win.getByRole('button', { name: /^Service/ }).first().click()
    await expect(win.locator('.react-flow__node')).toHaveCount(1)
    await win.keyboard.press('Control+s')
    await expect
      .poll(async () => (JSON.parse(await readFile(join(root, '.harpoon', 'project.json'), 'utf8')) as { nodes: unknown[] }).nodes.length, { timeout: 5000 })
      .toBe(1)
  } finally {
    await app.close()
  }
})
