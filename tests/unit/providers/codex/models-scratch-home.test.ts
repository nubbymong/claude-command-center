// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
// P3.9 round 1: the Codex model list read runs in a fresh empty home, made
// under the temp folder and removed after. A home an earlier read left
// behind (a crash or a quit mid-read) is swept by the next read: own prefix,
// real folders only, past an hour. Runs against this suite's own folder
// (never the shared temp folder); no process is started.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { codexModelsScratchHome, codexModelsScratchParent, CODEX_MODELS_HOME_PREFIX, STALE_RUN_FOLDER_MS } from '../../../../src/main/providers/codex'

const PREFIX = 'ccc-models-home-test-'
let parent = ''
beforeEach(() => { parent = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)) })
afterEach(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (path.basename(parent).startsWith(PREFIX) && path.dirname(parent) === os.tmpdir()) fs.rmSync(parent, { recursive: true, force: true })
})

describe('codexModelsScratchHome', () => {
  it('makes a fresh empty home under the parent, removed by its dispose', () => {
    const h = codexModelsScratchHome(parent)
    expect(path.dirname(h.home)).toBe(parent)
    expect(path.basename(h.home).startsWith(CODEX_MODELS_HOME_PREFIX)).toBe(true)
    expect(fs.readdirSync(h.home)).toEqual([])
    h.dispose()
    expect(fs.existsSync(h.home)).toBe(false)
  })

  it('sweeps an old home an earlier read left, and leaves a young one, other names and a link', () => {
    const old = path.join(parent, CODEX_MODELS_HOME_PREFIX + 'OLD111')
    const young = path.join(parent, CODEX_MODELS_HOME_PREFIX + 'YOUNG1')
    const other = path.join(parent, 'not-a-models-home')
    const target = path.join(parent, 'target')
    for (const d of [old, young, other, target]) fs.mkdirSync(d)
    fs.writeFileSync(path.join(old, 'config.toml'), 'x')
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x')
    const link = path.join(parent, CODEX_MODELS_HOME_PREFIX + 'LINK11')
    fs.symlinkSync(target, link, 'junction')
    const past = (Date.now() - STALE_RUN_FOLDER_MS - 60_000) / 1000
    for (const d of [old, other, target]) fs.utimesSync(d, past, past)
    try { fs.lutimesSync(link, past, past) } catch { /* not everywhere */ }
    const h = codexModelsScratchHome(parent)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(young)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    h.dispose()
  })
})

describe('codexModelsScratchParent', () => {
  it('is the temp folder by its real path, so the leftover sweep runs where the temp folder is named through a link', () => {
    expect(codexModelsScratchParent('/tmp', (p) => (p === '/tmp' ? '/private/tmp' : p))).toBe('/private/tmp')
  })

  it('is the temp folder as named when its real path cannot be read', () => {
    expect(codexModelsScratchParent('/gone', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })).toBe('/gone')
  })
})
