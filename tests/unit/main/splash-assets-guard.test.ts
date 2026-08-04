import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Tripwires for the animated boot splash (resources/splash/).
 *
 * The splash fails OPEN by design: if createSplashWindow can't find the page
 * it logs and skips, so a pruned `files` glob or a moved/renamed asset would
 * ship installers with no splash and green CI. These guards make that a red
 * test instead. They also pin the two load-bearing guarantees the adversarial
 * review confirmed by hand (#210): every asset is local (offline at boot) and
 * the page carries its own CSP (the app's onHeadersReceived CSP never reaches
 * a file:// document).
 */
const repoRoot = join(__dirname, '../../..')
const splashDir = join(repoRoot, 'resources', 'splash')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))

describe('splash assets guard', () => {
  it('all four splash assets are present', () => {
    for (const f of ['index.html', 'splash.js', 'three.module.min.js', 'montserrat-italic-600-latin.woff2']) {
      expect(existsSync(join(splashDir, f)), `resources/splash/${f} missing`).toBe(true)
    }
  })

  it('the build packages resources/** so the splash rides into the asar', () => {
    expect(pkg.build.files).toContain('resources/**/*')
  })

  it('electron-builder can derive icons from build/icon.png', () => {
    expect(pkg.build.directories.buildResources).toBe('build')
    expect(existsSync(join(repoRoot, 'build', 'icon.png'))).toBe(true)
  })

  it('splash html + js reference no remote origin (offline at boot)', () => {
    for (const f of ['index.html', 'splash.js']) {
      const text = readFileSync(join(splashDir, f), 'utf-8')
      for (const line of text.split('\n')) {
        // xmlns namespace tokens and the CSP/comment prose legitimately
        // contain the substring "http"; a real remote reference is a
        // scheme immediately followed by //host — assert none of those.
        const remote = line.match(/https?:\/\/[^\s"')]+/g) ?? []
        const offending = remote.filter((u) => !u.startsWith('http://www.w3.org/'))
        expect(offending, `${f}: remote reference(s) ${offending.join(', ')}`).toEqual([])
      }
    }
  })

  it('the splash page carries its own strict CSP meta', () => {
    const html = readFileSync(join(splashDir, 'index.html'), 'utf-8')
    expect(html).toMatch(/http-equiv="Content-Security-Policy"/)
    expect(html).toMatch(/default-src 'none'/)
    expect(html).toMatch(/connect-src 'none'/)
    // No inline/eval script escape hatch.
    expect(html).not.toMatch(/script-src[^;"]*'unsafe-inline'/)
    expect(html).not.toMatch(/script-src[^;"]*'unsafe-eval'/)
  })
})
