import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * Excalidraw fetches ~15 font families from esm.sh (a third-party CDN) on every
 * canvas open unless window.EXCALIDRAW_ASSET_PATH points at a local bundle. The
 * renderer CSP (font-src 'self') blocks that CDN fetch, so the local bundle is
 * what keeps Excalidraw's fonts working AND keeps the app offline. Guard both
 * halves: the asset-path wiring and the vendored Latin families. The ~13MB CJK
 * Xiaolai family is intentionally excluded (CJK falls back), so also assert it
 * stays out — re-adding it would balloon the installer.
 */
const repoRoot = join(__dirname, '../../..')
const fontsDir = join(repoRoot, 'src/renderer/public/excalidraw-assets/fonts')
const LATIN = ['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil']

describe('Excalidraw local font bundle', () => {
  it('main.tsx sets EXCALIDRAW_ASSET_PATH before rendering', () => {
    const main = readFileSync(join(repoRoot, 'src/renderer/main.tsx'), 'utf-8')
    expect(main).toMatch(/EXCALIDRAW_ASSET_PATH\s*=/)
    expect(main).toMatch(/excalidraw-assets/)
  })

  it('bundles every Latin family, each with at least one woff2', () => {
    for (const fam of LATIN) {
      const dir = join(fontsDir, fam)
      expect(existsSync(dir), `missing family ${fam}`).toBe(true)
      const woff2 = readdirSync(dir).filter((f) => f.endsWith('.woff2'))
      expect(woff2.length, `${fam} has no woff2`).toBeGreaterThan(0)
    }
  })

  it('does NOT bundle the ~13MB CJK Xiaolai family (installer size)', () => {
    expect(existsSync(join(fontsDir, 'Xiaolai'))).toBe(false)
  })
})
