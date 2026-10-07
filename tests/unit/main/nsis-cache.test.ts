// [host] The NSIS compiler locator of installer-nsis-behaviour.test.ts, on fake cache
// trees in the temp folder. Nothing is run: the "compilers" are empty files.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makensisIn, nsisCacheFolders, nsisCachePresent } from '../../helpers/nsis-cache'

const root = mkdtempSync(join(tmpdir(), 'ccc-nsis-cache-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A fake electron-builder cache folder holding `files` (relative paths). */
function cache(name: string, files: string[]): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  return dir
}

describe('electron-builder NSIS cache locator', () => {
  it('finds makensis in the layout before electron-builder 26 (Cache\\nsis\\nsis-<v>\\)', () => {
    const c = cache('old', ['nsis/nsis-3.0.4.1/makensis.exe', 'nsis/nsis-3.0.4.0/makensis.exe', 'nsis/other/makensis.exe'])
    expect(nsisCacheFolders(c)).toEqual([join(c, 'nsis', 'nsis-3.0.4.1'), join(c, 'nsis', 'nsis-3.0.4.0')])
    expect(makensisIn(nsisCacheFolders(c))).toBe(join(c, 'nsis', 'nsis-3.0.4.1', 'makensis.exe'))
  })

  it("finds makensis in electron-builder 26's layout (Cache\\nsis-<v>\\nsis-<v>-<random>\\), or in its Bin folder", () => {
    const c = cache('eb26', ['nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe', 'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe', 'nsis-resources-3.4.1/nsis-resources-3.4.1-q1w2e/x.txt'])
    // Not electron-builder's nsis-resources-<v> folder.
    expect(nsisCacheFolders(c)).toEqual([join(c, 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n')])
    expect(makensisIn(nsisCacheFolders(c))).toBe(join(c, 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'makensis.exe'))
    const binOnly = cache('eb26-bin', ['nsis-3.0.4.1/nsis-3.0.4.1-abcde/Bin/makensis.exe'])
    expect(makensisIn(nsisCacheFolders(binOnly))).toBe(join(binOnly, 'nsis-3.0.4.1', 'nsis-3.0.4.1-abcde', 'Bin', 'makensis.exe'))
  })

  it('reports cache folders that hold no makensis, so the availability check can fail on them', () => {
    const c = cache('empty', ['nsis-3.0.4.1/nsis-3.0.4.1-zzzzz/readme.txt'])
    expect(nsisCacheFolders(c)).toEqual([join(c, 'nsis-3.0.4.1', 'nsis-3.0.4.1-zzzzz')])
    expect(makensisIn(nsisCacheFolders(c))).toBeNull()
  })

  it('a missing cache folder is no folder and no makensis', () => {
    expect(nsisCacheFolders(join(root, 'missing'))).toEqual([])
    expect(makensisIn([])).toBeNull()
    expect(nsisCachePresent(join(root, 'missing'))).toBe(false)
  })

  it('knows NSIS is cached in either layout, and in one the locator does not read', () => {
    expect(nsisCachePresent(cache('present-old', ['nsis/nsis-3.0.4.1/x.txt']))).toBe(true)
    expect(nsisCachePresent(cache('present-eb26', ['nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/x.txt']))).toBe(true)
    // An unknown layout (the compiler straight in nsis-<v>): present, though no folder is found.
    const unknown = cache('present-unknown', ['nsis-4.0/makensis.exe'])
    expect(nsisCachePresent(unknown)).toBe(true)
    expect(makensisIn(nsisCacheFolders(unknown))).toBeNull()
    expect(nsisCachePresent(cache('other-caches', ['electron/x.zip', 'nsis-resources-3.4.1/y.txt']))).toBe(false)
  })
})
