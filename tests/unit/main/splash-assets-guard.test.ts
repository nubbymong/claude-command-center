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
  it('all five splash assets are present', () => {
    // splash-info.js (#384) prints the build identity line; it is a separate
    // classic script so the line shows even when the three.js module fails.
    for (const f of ['index.html', 'splash.js', 'splash-info.js', 'three.module.min.js', 'montserrat-italic-600-latin.woff2']) {
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
    for (const f of ['index.html', 'splash.js', 'splash-info.js']) {
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

  it('the splash page carries no "not affiliated with Anthropic" line (#383)', () => {
    const html = readFileSync(join(splashDir, 'index.html'), 'utf-8')
    expect(html).not.toMatch(/affiliated|endorsed by/i)
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

  it('the splash BrowserWindow keeps its sandbox triple and loads only the bundled page', () => {
    // splash-window.ts cannot be imported here (it needs a live BrowserWindow),
    // so pin the shape: the isolation flags a mutation could flip with every
    // other test staying green (adversarial pass, 2.1.1).
    const src = readFileSync(join(repoRoot, 'src', 'main', 'splash-window.ts'), 'utf-8').replace(/\r\n/g, '\n')
    expect(src).toMatch(/webPreferences:\s*\{\s*contextIsolation:\s*true,\s*nodeIntegration:\s*false,\s*sandbox:\s*true,?\s*\}/)
    expect(src).toContain("join(__dirname, '..', '..', 'resources', 'splash', 'index.html')")
    expect(src).not.toMatch(/\.loadURL\(/)
    // ONE window in this module: the triple match above is first-match, so a
    // second BrowserWindow carrying weaker webPreferences would pass it
    // (re-attack, 2.1.1)...
    // (whole-line // comments are dropped first, so a comment LINE naming the
    // construct is not a red; a trailing or block comment still would be)
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    expect(code.match(/new BrowserWindow\(/g)).toHaveLength(1)
    expect(code.match(/webPreferences:/g)).toHaveLength(1)
    // ...and the bundled page must be what is LOADED, not merely mentioned:
    // the loadFile argument is `splashHtml`, `splashHtml` IS the bundled path
    // (not a same-named override of it), and it is loaded exactly once
    // (re-attack round 2, 2.1.1).
    expect(src).toMatch(/\.loadFile\(splashHtml, \{ query: splashBuildQuery\(/)
    expect(src).toMatch(/const splashHtml = join\(\s*__dirname,\s*'\.\.',\s*'\.\.',\s*'resources',\s*'splash',\s*'index\.html'\s*\)/)
    expect(code.match(/\.loadFile\(/g)).toHaveLength(1)
  })

  it('the splash module touches no process-wide state: no Chromium switch, no session, no permission handler', () => {
    // The sandbox triple above is per-window. A module that appends
    // `--no-sandbox` at import time, or installs a permissive handler on the
    // DEFAULT session (shared with the main window), leaves the triple intact
    // and every other test green (final adversarial pass, 2.1.1: mutants M3/M8).
    const src = readFileSync(join(repoRoot, 'src', 'main', 'splash-window.ts'), 'utf-8').replace(/\r\n/g, '\n')
    // Code only: block comments and whole-line // comments are dropped, so
    // prose naming a construct is not a red.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    expect(code).not.toMatch(/commandLine|appendSwitch|appendArgument/)
    expect(code).not.toMatch(/setPermission(Request|Check)Handler|defaultSession|fromPartition|\.session\b/)
    // `app` is used for read-only identity getters, never for anything that
    // reaches the process or another window.
    const READ_ONLY = new Set(['getVersion', 'getName', 'isPackaged', 'getAppPath', 'getPath'])
    const appUses = [...code.matchAll(/\bapp\.(\w+)/g)].map((m) => m[1])
    expect(appUses.length).toBeGreaterThan(0)
    expect(appUses.filter((u) => !READ_ONLY.has(u))).toEqual([])
  })
})
