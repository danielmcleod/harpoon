// electron-vite build: main (ESM, hosts the core), the sandboxed preload (CJS, emitted as .cjs because package.json
// is "type":"module") and the React renderer. `dependencies` is empty, so every import is bundled; nothing is
// externalized but Electron and Node built-ins.
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { RENDERER_CSP } from './src/main/csp.ts'

const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src'),
}

/**
 * The renderer's Content-Security-Policy as a <meta> in the built index.html: the policy is src/main/csp.ts, which
 * main also sends as a header with every built file. Production only: the dev server injects inline scripts.
 */
const rendererCsp = (): Plugin => ({
  name: 'harpoon-renderer-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
      injectTo: 'head-prepend',
    },
  ],
})

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), tailwindcss(), rendererCsp()],
    worker: { format: 'es' },
    build: {
      outDir: 'out/renderer',
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
