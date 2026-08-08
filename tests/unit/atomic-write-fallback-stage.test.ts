import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// per-session-settings and session-hooks-writer keep a deliberately NON-atomic
// fallback: if the rename cannot land, write straight over the target so a
// session launch is not blocked. That fallback opens the target with O_TRUNC.
//
// So WHICH stage failed decides whether taking it is safe. On a rename failure
// the target is intact and rewriting it is a wash. On a STAGING-WRITE failure
// (ENOSPC, EDQUOT, EIO) the fallback truncates the file to zero and then fails
// anyway — and pty-manager swallows that throw and hands the empty file to
// `claude --settings`. Before #233 the staging write sat outside the try, which
// is what kept that branch unreachable; these tests keep it unreachable.

const h = vi.hoisted(() => ({
  home: '',
  /** errno the SHARED HELPER's staging write should throw, or null. */
  stageFail: null as string | null,
  /** errno the SHARED HELPER's rename should throw, or null. */
  renameFail: null as string | null,
  /** Writes made through node:fs by the call sites themselves — the fallback. */
  siteWrites: [] as string[]
}))

function errnoOf(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  e.code = code
  return e
}

// 'fs' and 'node:fs' resolve to the SAME module here, so the helper and the call
// sites cannot be separated by specifier. Distinguish by path instead: the helper
// only ever writes a `.tmp` staging file, and the fallback is the one thing that
// writes the target directly. That is a sturdier discriminator anyway — it is the
// actual property under test rather than an import-graph accident.
function patchFs(real: any) {
  return {
    ...real,
    writeFileSync: (p: any, d: any, o: any) => {
      const path = String(p)
      const isStaging = path.endsWith('.tmp')
      if (isStaging && h.stageFail) throw errnoOf(h.stageFail)
      if (!isStaging) h.siteWrites.push(path)
      return real.writeFileSync(p, d, o)
    },
    renameSync: (f: any, t: any) => {
      if (h.renameFail) throw errnoOf(h.renameFail)
      return real.renameSync(f, t)
    }
  }
}
vi.mock('fs', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const patched = patchFs(mod.default ?? mod)
  return { ...patched, default: patched }
})
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const patched = patchFs(mod.default ?? mod)
  return { ...patched, default: patched }
})

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const real = mod.default ?? mod
  const patched = { ...real, homedir: () => h.home }
  return { ...patched, default: patched }
})

vi.mock('../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  getConductorMcpSecret: () => 'secret'
}))
vi.mock('../../src/main/providers/claude/statusline-command', () => ({
  buildStatuslineSetting: () => ({ type: 'command', command: 'x' })
}))

import { writeLocalSessionSettings, getLocalSessionSettingsPath } from '../../src/main/hooks/per-session-settings'
import { injectHooks } from '../../src/main/hooks/session-hooks-writer'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fallback-stage-'))
  h.home = tmp
  h.stageFail = null
  h.renameFail = null
  h.siteWrites = []
})
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the non-atomic fallback is reachable ONLY from a rename failure', () => {
  it('per-session settings: a staging-write failure throws and never touches the target', () => {
    const target = getLocalSessionSettingsPath('sid1')
    writeLocalSessionSettings('sid1')            // seed a real file first
    const before = readFileSync(target, 'utf-8')
    expect(before.length).toBeGreaterThan(0)
    h.siteWrites = []

    h.stageFail = 'ENOSPC'
    expect(() => writeLocalSessionSettings('sid1')).toThrow(/ENOSPC/)

    // The whole point: the target still holds its old bytes, not zero.
    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(target)
  })

  it('per-session settings: a rename failure DOES fall back, so a launch is not blocked', () => {
    const target = getLocalSessionSettingsPath('sid2')

    h.renameFail = 'EPERM'
    expect(() => writeLocalSessionSettings('sid2')).not.toThrow()

    expect(h.siteWrites).toContain(target)
    expect(existsSync(target)).toBe(true)
  })

  it('session hooks writer: a staging-write failure throws and never truncates the settings file', () => {
    const settingsPath = join(tmp, 'settings-sid3.json')
    writeFileSync(settingsPath, JSON.stringify({ keep: true }, null, 2))
    const before = readFileSync(settingsPath, 'utf-8')
    h.siteWrites = []

    h.stageFail = 'ENOSPC'
    expect(() => injectHooks({ sessionId: 'sid3', settingsPath, port: 1, secret: 's', cwd: tmp, homeDir: tmp }))
      .toThrow(/ENOSPC/)

    // A zero-byte settings file here is what pty-manager would pass to
    // `claude --settings`, because it swallows this throw and carries on.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(settingsPath)
  })

  it('session hooks writer: a rename failure DOES fall back', () => {
    const settingsPath = join(tmp, 'settings-sid4.json')
    writeFileSync(settingsPath, JSON.stringify({ keep: true }, null, 2))

    h.renameFail = 'EPERM'
    expect(() => injectHooks({ sessionId: 'sid4', settingsPath, port: 1, secret: 's', cwd: tmp, homeDir: tmp }))
      .not.toThrow()

    expect(h.siteWrites).toContain(settingsPath)
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks).toBeTruthy()
  })
})
