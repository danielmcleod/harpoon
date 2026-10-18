// The exported HTML viewer: the renderer built as ONE script and ONE stylesheet, which main inlines (with the project
// JSON) into a single self-contained .html file. Built after electron-vite (`pnpm build`).
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/viewer'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: resolve('src/renderer/viewer.html'), output: { inlineDynamicImports: true } },
  },
})
