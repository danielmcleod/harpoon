// Dev only: serve the renderer alone in a browser (no Electron), with the in-memory dev bridge (ipc/devBridge.ts).
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
})
