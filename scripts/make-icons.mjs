// App icons from the logo (build/logo.svg, the source of truth): rendered in an Electron window (through Playwright,
// as the end-to-end tests drive the app), then written as
//   build/icon.png               1024×1024, electron-builder's source for macOS (.icns) and Linux
//   build/icon.ico               16–256 px, the Windows installer and executable
//   src/renderer/public/icon.png 256×256, the window and taskbar icon (main loads it from out/renderer)
//   src/renderer/public/favicon.svg  the app's and the HTML viewer's favicon
// Run `node scripts/make-icons.mjs` after changing the logo.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'logo.svg'), 'utf8')

const browser = await electron.launch({ args: [join(root, 'scripts', 'icon-window.cjs')] })
const page = await browser.firstWindow()

/** The logo as a PNG of `size`×`size`, transparent around the hexagon. */
async function render(size) {
  await page.setViewportSize({ width: size, height: size })
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

/** An .ico holding PNG images (Windows Vista and later read PNG entries). */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((x) => x.png)])
}

try {
  const pub = join(root, 'src', 'renderer', 'public')
  mkdirSync(pub, { recursive: true })
  writeFileSync(join(root, 'build', 'icon.png'), await render(1024))
  writeFileSync(join(pub, 'icon.png'), await render(256))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = []
  for (const size of sizes) images.push({ size, png: await render(size) })
  writeFileSync(join(root, 'build', 'icon.ico'), ico(images))
  copyFileSync(join(root, 'build', 'logo.svg'), join(pub, 'favicon.svg'))
  console.log('wrote build/icon.png, build/icon.ico, src/renderer/public/icon.png, src/renderer/public/favicon.svg')
} finally {
  await browser.close()
}
