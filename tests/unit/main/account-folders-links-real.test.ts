// [CI, VM] WP2 PR 4, P4.4 (rows 55, 56): the account-folder checks on REAL
// links -- junctions on Windows, symbolic links elsewhere -- planted in a temp
// folder: the account memory guard and listing beside memory-path-symlink's
// cases for Claude's store (a `.git` path and a link out of `memories/`
// refused, a link back inside refused too, the memories folder itself a link),
// and a `log_dir` that is a link or junction refused before the shell (the
// shell is a mock here: nothing is opened).
//
// HOST QUARANTINE: this suite writes a temp directory and plants junctions or
// links in it. It runs in CI and on the VM, never on the owner's workstation.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateAccountMemoryPath, AccountPathRefused } from '../../../src/main/utils/path-validator'
import { scanAccountMemories, readAccountMemory, deleteAccountMemory } from '../../../src/main/account-memories'
import { openAccountLogFolder, realAccountFileFs } from '../../../src/main/account-folders'
import type { AccountFolderSet } from '../../../src/main/account-folders'
import { PB6_MEMORIES, PB6_LISTED_MD } from '../../fixtures/codex/memories-pb6'

const PREFIX = 'ccc-p44-links-'
const made: string[] = []
let tmp = ''
let home = ''
let mem = ''
let outside = ''
let set: AccountFolderSet
const link = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
const deps = () => ({ fs: realAccountFileFs, platform: process.platform })

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  made.push(tmp)
  home = path.join(tmp, 'home')
  mem = path.join(home, 'memories')
  outside = path.join(tmp, 'outside')
  fs.mkdirSync(mem, { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\n\nnot a memory\n')
  for (const e of PB6_MEMORIES) {
    const at = path.join(mem, ...e.rel.split('/'))
    if (e.kind === 'dir') fs.mkdirSync(at, { recursive: true })
    else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, e.content ?? '') }
  }
  link(outside, path.join(mem, 'out'))
  link(path.join(mem, 'extensions'), path.join(mem, 'inner'))
  set = { providerId: 'codex', accountId: 'acct-real', external: false, logDir: path.join(home, 'log'), memoriesDir: mem, configFile: path.join(home, 'config.toml') }
})

afterAll(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent;
  // links are removed first so nothing is followed out of it.
  const tmpReal = fs.realpathSync.native(os.tmpdir())
  for (const d of made.splice(0)) {
    if (!path.basename(d).startsWith(PREFIX) || path.dirname(d) !== tmpReal) continue
    for (const l of [path.join(mem, 'out'), path.join(mem, 'inner'), path.join(home, 'linked-logs'), path.join(tmp, 'mem-link')]) {
      try { if (fs.lstatSync(l).isSymbolicLink()) fs.rmdirSync(l) } catch { /* gone */ }
      try { if (fs.lstatSync(l).isSymbolicLink()) fs.unlinkSync(l) } catch { /* gone */ }
    }
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

const refused = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(AccountPathRefused)
}

describe('account memories on real links', () => {
  it('lets a plain file through and lists the layout without .git or anything through a link', async () => {
    await expect(validateAccountMemoryPath(path.join(mem, 'MEMORY.md'), [mem])).resolves.toMatchObject({ root: mem })
    const [acct] = await scanAccountMemories([set], deps())
    expect(acct.state).toBe('present')
    expect(acct.files.map((f) => f.relPath)).toEqual([...PB6_LISTED_MD])
  })

  it('refuses a .git path, a link out of memories, and a link back inside', async () => {
    await refused(validateAccountMemoryPath(path.join(mem, '.git', 'HEAD'), [mem]))
    await refused(validateAccountMemoryPath(path.join(mem, 'out', 'secret.md'), [mem]))
    await refused(validateAccountMemoryPath(path.join(mem, 'inner', 'ad_hoc', 'instructions.md'), [mem], { destructive: true }))
    await expect(readAccountMemory(path.join(mem, 'out', 'secret.md'), [set], deps())).rejects.toThrow(/Refused/)
    await expect(deleteAccountMemory(path.join(mem, '.git', 'HEAD'), [set], deps())).rejects.toThrow(/Refused/)
    expect(fs.existsSync(path.join(mem, '.git', 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(outside, 'secret.md'))).toBe(true)
  })

  it('a memories folder that is itself a link is unreadable, and nothing is read through it', async () => {
    const linked = path.join(tmp, 'mem-link')
    link(mem, linked)
    const [acct] = await scanAccountMemories([{ ...set, memoriesDir: linked }], deps())
    expect(acct).toMatchObject({ state: 'unreadable', files: [] })
    await refused(validateAccountMemoryPath(path.join(linked, 'MEMORY.md'), [linked]))
  })
})

describe('a log_dir on a real link', () => {
  it('opens a plain folder, refuses a link or junction, and the shell never sees the refused one', async () => {
    const openPath = vi.fn(async (_p: string) => '')
    const logs = path.join(tmp, 'tui-logs')
    fs.mkdirSync(logs)
    const toml = (p: string) => `log_dir = ${JSON.stringify(p)}\n`
    fs.writeFileSync(set.configFile, toml(logs))
    const d = { fs: realAccountFileFs, openPath, platform: process.platform }
    expect(await openAccountLogFolder({ accountId: 'acct-real', folder: 'log-dir' }, async () => [set], d)).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledTimes(1)
    const linked = path.join(home, 'linked-logs')
    link(logs, linked)
    fs.writeFileSync(set.configFile, toml(linked))
    expect(await openAccountLogFolder({ accountId: 'acct-real', folder: 'log-dir' }, async () => [set], d)).toEqual({ ok: false, code: 'refused' })
    // A folder below a link: its real path is not its own.
    fs.mkdirSync(path.join(logs, 'sub'))
    fs.writeFileSync(set.configFile, toml(path.join(linked, 'sub')))
    expect(await openAccountLogFolder({ accountId: 'acct-real', folder: 'log-dir' }, async () => [set], d)).toEqual({ ok: false, code: 'refused' })
    expect(openPath).toHaveBeenCalledTimes(1)
  })
})
