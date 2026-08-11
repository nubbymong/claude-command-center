import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// per-session-settings and session-hooks-writer both write a TOKEN-BEARING file
// under ~/.claude: settings-<sid>.json carries the per-session X-CCC-Hook-Token,
// and the MCP config carries the Conductor `?token=` secret. GHSA-pwfw-2ggq-569x
// / GHSA-58r3-f5hg-vxcq hardened these writers to stage-and-rename owner-only
// (wx, 0600) and REMOVED the plain writeFileSync fallback, because that fallback
// wrote the real target directly: it followed a symlink planted at the path and,
// carrying no mode, landed 0644 — the exact world-readable-token regression the
// advisories closed.
//
// #233 consolidates every writer onto one atomic helper, and that helper already
// retries the Windows scanner-race rename (EPERM/EACCES/EBUSY) the old fallback
// existed for. So the fallback is not only unsafe here, it is unnecessary: these
// two writers stay FAIL-CLOSED. Whichever stage fails — the staging write
// (ENOSPC/EDQUOT/EIO) or a persistent rename — the writer leaves the previous
// file byte-for-byte intact, NEVER writes the target directly, and does not throw
// (the spawn path must not be blocked). These tests pin that contract so a future
// change cannot quietly reintroduce the insecure direct write.

const h = vi.hoisted(() => ({
  home: '',
  /** errno the shared helper's staging write should throw, or null. */
  stageFail: null as string | null,
  /** errno the shared helper's rename should throw, or null. */
  renameFail: null as string | null,
  /** Direct (non-staging) writes to a real target — i.e. the banned fallback. */
  siteWrites: [] as string[]
}))

function errnoOf(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  e.code = code
  return e
}

// 'fs' and 'node:fs' resolve to the SAME module here, so the helper and the call
// sites cannot be separated by specifier. Distinguish by path instead: the helper
// only ever writes a `.tmp` staging file, and a direct target write is the one
// thing the (now removed) fallback did. Any non-`.tmp` write recorded here is a
// fail-closed violation.
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
  tmp = mkdtempSync(join(tmpdir(), 'fail-closed-'))
  h.home = tmp
  h.stageFail = null
  h.renameFail = null
  h.siteWrites = []
})
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('credential-bearing writers fail closed on either stage — never a direct target write', () => {
  it('per-session settings: a staging-write failure leaves the previous file intact and never touches the target', () => {
    const target = getLocalSessionSettingsPath('sid1')
    writeLocalSessionSettings('sid1')            // seed a real file first
    const before = readFileSync(target, 'utf-8')
    expect(before.length).toBeGreaterThan(0)
    h.siteWrites = []

    h.stageFail = 'ENOSPC'
    // Fail closed: the writer catches, logs, and does not rethrow.
    expect(() => writeLocalSessionSettings('sid1')).not.toThrow()

    // The old bytes survive — not a zero-length or attacker-writable file.
    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(target)
  })

  it('per-session settings: a rename failure also fails closed — no plain-write fallback to the token file', () => {
    const target = getLocalSessionSettingsPath('sid2')
    writeLocalSessionSettings('sid2')            // seed a real file first
    const before = readFileSync(target, 'utf-8')
    h.siteWrites = []

    // EPERM is the Windows scanner race the removed fallback existed for; the
    // helper retries it and, when it stays, the writer leaves the old file.
    h.renameFail = 'EPERM'
    expect(() => writeLocalSessionSettings('sid2')).not.toThrow()

    expect(readFileSync(target, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(target)
  })

  it('session hooks writer: a staging-write failure never truncates the settings file', () => {
    const settingsPath = join(tmp, 'settings-sid3.json')
    writeFileSync(settingsPath, JSON.stringify({ keep: true }, null, 2))
    const before = readFileSync(settingsPath, 'utf-8')
    h.siteWrites = []

    h.stageFail = 'ENOSPC'
    expect(() => injectHooks({ sessionId: 'sid3', settingsPath, port: 1, secret: 's', cwd: tmp, homeDir: tmp }))
      .not.toThrow()

    // A zero-byte settings file is what pty-manager would otherwise hand to
    // `claude --settings`; fail-closed keeps the prior bytes instead.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(settingsPath)
  })

  it('session hooks writer: a rename failure also fails closed — leaves the file rather than overwriting it insecurely', () => {
    const settingsPath = join(tmp, 'settings-sid4.json')
    writeFileSync(settingsPath, JSON.stringify({ keep: true }, null, 2))
    const before = readFileSync(settingsPath, 'utf-8')
    h.siteWrites = []                            // drop the seed write from the tally

    h.renameFail = 'EPERM'
    expect(() => injectHooks({ sessionId: 'sid4', settingsPath, port: 1, secret: 's', cwd: tmp, homeDir: tmp }))
      .not.toThrow()

    expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
    expect(h.siteWrites).not.toContain(settingsPath)
  })
})
