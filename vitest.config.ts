import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

const alias = {
  '@shared': r('./src/shared'),
  '@core': r('./src/core'),
  '@renderer': r('./src/renderer/src'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          pool: 'forks',
          testTimeout: 60_000,
        },
      },
    ],
  },
})
