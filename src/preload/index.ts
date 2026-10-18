// Sandboxed preload, bundled to CJS: exposes window.harpoon
// (HarpoonApi) and nothing else. Uses only electron's contextBridge / ipcRenderer and process.platform / argv
// (the initial theme arrives as `--harpoon-theme=`).
import { contextBridge, ipcRenderer } from 'electron'
import { createHarpoonApi } from './bridge.ts'

contextBridge.exposeInMainWorld(
  'harpoon',
  createHarpoonApi(ipcRenderer, { platform: process.platform, argv: process.argv }),
)
