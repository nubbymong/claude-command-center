// #226: a worktree can look fully installed while Electron's own binary is
// absent -- node_modules/electron/ exists, package.json is satisfied, `npm ls`
// is clean, but path.txt and the binary it names are gone, because the repo's
// postinstall only rebuilds the two native addons. electron-vite then dies with
// an opaque "Error: Electron uninstall" in a launcher window that closes
// instantly. These pin the DETECTION half; the heal step shells out to
// Electron's own installer and is not exercised here.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { checkElectron } from '../../../scripts/preflight-electron.mjs'

const ROOT = 'F:/repo'
const PKG = path.join(ROOT, 'node_modules', 'electron')
const PATH_TXT = path.join(PKG, 'path.txt')
const BINARY = path.join(PKG, 'dist', 'electron.exe')

/** A fake fs holding exactly the paths listed, plus path.txt's contents. */
function fakeFs(present: string[], pathTxt = 'electron.exe') {
  const set = new Set(present.map((p) => path.normalize(p)))
  return {
    existsSync: (p: string) => set.has(path.normalize(p)),
    readFileSync: (p: string) => {
      if (path.normalize(p) === path.normalize(PATH_TXT)) return pathTxt
      throw new Error(`unexpected read: ${p}`)
    },
  }
}

describe('checkElectron', () => {
  it('passes on a healthy tree', () => {
    const r = checkElectron(ROOT, fakeFs([PKG, PATH_TXT, BINARY]))
    expect(r.ok).toBe(true)
    expect(path.normalize(r.binary)).toBe(path.normalize(BINARY))
  })

  it('THE BUG: path.txt present but the binary gone', () => {
    // The exact state observed twice, in two different worktrees, and the one a
    // presence check on node_modules/electron alone would call healthy.
    const r = checkElectron(ROOT, fakeFs([PKG, PATH_TXT]))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('missing-binary')
  })

  it('reports a missing path.txt distinctly from a missing binary', () => {
    // Different remedy: this one is what Electron's installer writes, so the
    // heal step can fix it; a missing PACKAGE cannot be healed that way.
    const r = checkElectron(ROOT, fakeFs([PKG]))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('missing-path-txt')
  })

  it('reports a missing package distinctly — that one needs npm ci, not a heal', () => {
    const r = checkElectron(ROOT, fakeFs([]))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('missing-package')
  })

  it('treats an empty path.txt as broken rather than resolving to the package dir', () => {
    // Without this, path.join(pkg, 'dist', '') is the dist DIRECTORY, which can
    // exist -- a half-written path.txt would read as healthy.
    const r = checkElectron(ROOT, fakeFs([PKG, PATH_TXT, BINARY], '   '))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('empty-path-txt')
  })

  it('trims path.txt, which Electron writes without a trailing newline guarantee', () => {
    const r = checkElectron(ROOT, fakeFs([PKG, PATH_TXT, BINARY], 'electron.exe\n'))
    expect(r.ok).toBe(true)
  })

  it('survives an unreadable path.txt instead of throwing into electron-vite', () => {
    const fs = {
      existsSync: (p: string) => [PKG, PATH_TXT].some((q) => path.normalize(q) === path.normalize(p)),
      readFileSync: () => { throw new Error('EACCES') },
    }
    const r = checkElectron(ROOT, fs)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unreadable-path-txt')
  })

  it('resolves the binary relative to the electron package, as electron-vite does', () => {
    // path.txt holds a path relative to node_modules/electron/dist.
    const linux = path.join(PKG, 'dist', 'electron')
    const r = checkElectron(ROOT, fakeFs([PKG, PATH_TXT, linux], 'electron'))
    expect(r.ok).toBe(true)
    expect(path.normalize(r.binary)).toBe(path.normalize(linux))
  })
})
