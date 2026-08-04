import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Guards for the Microsoft Store (MSIX) package.
 *
 * The load-bearing one is the first: `.github/workflows/release.yml` runs
 * `electron-builder --win`, which builds EVERY target listed in build.win.target.
 * If `appx` were added there, a Store-packaging problem — a wrong identity
 * string, missing tooling — would fail the whole Windows job and ship NO
 * installer at all. The Store package is therefore built only on demand, via
 * `npm run package:store`.
 *
 * The identity values are copied verbatim from Partner Center (Product identity).
 * The Store rejects an upload whose identity does not match the reservation
 * exactly, so they are pinned here rather than left to be retyped.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'))

describe('Store package guard', () => {
  it('the release build never builds the Store package', () => {
    const winTargets = pkg.build.win.target.map((t: { target: string }) => t.target)
    expect(winTargets).toEqual(['nsis'])
    expect(winTargets).not.toContain('appx')
  })

  it('the Store package is buildable on demand', () => {
    expect(pkg.scripts['package:store']).toMatch(/electron-builder --win appx/)
  })

  it('identity matches the Partner Center reservation exactly', () => {
    expect(pkg.build.appx.identityName).toBe('nicholas-moger.AICodeConductor')
    expect(pkg.build.appx.publisher).toBe('CN=219653A3-6C91-474A-9D0D-CC64FC96BD70')
    expect(pkg.build.appx.publisherDisplayName).toBe('nicholas-moger')
  })

  it('the Store artifact cannot be confused with the direct-download installer', () => {
    // The updater matches release assets by prefix and extension. A Store package
    // must never be mistaken for something it could hand to a self-updating
    // client, so it carries its own suffix and a different extension (.appx).
    expect(pkg.build.appx.artifactName).toMatch(/-store\./)
    expect(pkg.build.appx.artifactName).not.toMatch(/ClaudeCommandCenter-/)
  })
})
