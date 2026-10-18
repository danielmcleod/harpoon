import { defineConfig } from '@playwright/test'

// One Electron smoke test (tests/e2e). Run `pnpm build` first (`pnpm e2e` does).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
})
