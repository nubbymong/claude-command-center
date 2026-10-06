// [host] WP2 PR 4, P4.4 (row 55): the existing memory channels with each
// provider account's own memories wired in (registerMemoryHandlers'
// accountFolders). ipcMain is mocked, Claude's scanner is mocked (nothing
// reads ~/.claude), os.homedir points at a folder that does not exist, and an
// account's memories live in the in-memory file system of
// tests/helpers/fake-account-fs.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import { createFakeAccountFs } from '../../helpers/fake-account-fs'
import type { FakeAccountFs } from '../../helpers/fake-account-fs'
import { PB6_MEMORIES, PB6_LISTED_MD } from '../../fixtures/codex/memories-pb6'

const FAKE_HOME = path.resolve('/nonexistent-ccc-p44-home')
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, homedir: () => FAKE_HOME }
})
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => { handlers.set(ch, fn) }) },
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: vi.fn(() => null) }))
const claude = vi.hoisted(() => ({
  scan: vi.fn(async () => ({ projects: [], memories: [], warnings: [], totalSize: 0, scannedAt: 1 })),
  read: vi.fn(async (_p: string) => 'claude content'),
  del: vi.fn(async (_p: string) => {}),
  fm: vi.fn(async (_p: string, _f: unknown) => {}),
}))
vi.mock('../../../src/main/memory-scanner', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/memory-scanner')>()
  return { ...real, scanLocalMemory: claude.scan, readMemoryContent: claude.read, deleteMemoryFile: claude.del, writeMemoryFrontmatter: claude.fm }
})

const { registerMemoryHandlers } = await import('../../../src/main/ipc/memory-handlers')
const { ACCOUNT_MEMORY_DELETE_SHOWN, MEMORY_PATH_MAX } = await import('../../../src/shared/account-memories')

const HOME = 'C:\\Users\\me\\res\\codex-realms\\r1'
const MEM = `${HOME}\\memories`
const SET = { providerId: 'codex' as const, accountId: 'acct-1', external: false, logDir: `${HOME}\\log`, memoriesDir: MEM, configFile: `${HOME}\\config.toml` }

const frame = { id: 'main' }
const win = { isDestroyed: () => false, webContents: { mainFrame: frame } }
const fromApp = { sender: win.webContents, senderFrame: frame }
const fromElsewhere = { sender: {}, senderFrame: frame }

let fake: FakeAccountFs
let source: ReturnType<typeof vi.fn>
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(fromApp, ...args)

function register(opts: { sets?: unknown; withWindow?: boolean; withAccounts?: boolean } = {}) {
  handlers.clear()
  source = vi.fn(async () => (opts.sets === undefined ? [SET] : opts.sets))
  registerMemoryHandlers({
    ...(opts.withWindow === false ? {} : { getWindow: () => win as never }),
    ...(opts.withAccounts === false ? {} : { accountFolders: source as never }),
    accountFs: fake as never,
    platform: 'win32',
  })
}

beforeEach(() => {
  for (const f of Object.values(claude)) f.mockClear()
  fake = createFakeAccountFs('win32')
  fake.mkdir(MEM)
  for (const e of PB6_MEMORIES) {
    const at = `${MEM}\\${e.rel.split('/').join('\\')}`
    if (e.kind === 'dir') fake.mkdir(at)
    else fake.writeFile(at, e.content ?? '')
  }
})

describe('memory:scan', () => {
  it("adds each account's memories beside Claude's store", async () => {
    register()
    const r = await call('memory:scan') as { accountMemories: Array<{ accountId: string; state: string; files: Array<{ relPath: string }> }> }
    expect(claude.scan).toHaveBeenCalledOnce()
    expect(r.accountMemories).toHaveLength(1)
    expect(r.accountMemories[0]).toMatchObject({ accountId: 'acct-1', state: 'present' })
    expect(r.accountMemories[0].files.map((f) => f.relPath)).toEqual([...PB6_LISTED_MD])
  })

  it('without the accounts wired, the answer is exactly Claude\'s (no accountMemories)', async () => {
    register({ withAccounts: false })
    const r = await call('memory:scan')
    expect(r).toEqual({ projects: [], memories: [], warnings: [], totalSize: 0, scannedAt: 1 })
  })

  it('accounts that cannot be read yet list none, and a throwing source never fails the scan', async () => {
    register({ sets: null })
    expect(await call('memory:scan')).toMatchObject({ accountMemories: [] })
    register()
    source.mockRejectedValueOnce(new Error('boom'))
    expect(await call('memory:scan')).toMatchObject({ accountMemories: [] })
  })

  it('#628 review: every listed file fits the memory channels\' path bound; a longer one is left out and the account reads as listed in part', async () => {
    // Four nested folders, then one file whose full path is exactly the bound and one a character longer.
    const dir = `${MEM}\\${['a', 'b', 'c', 'd'].map((c) => c.repeat(200)).join('\\')}`
    const atBound = `${dir}\\${'x'.repeat(MEMORY_PATH_MAX - dir.length - 1 - 3)}.md`
    const overBound = `${dir}\\${'y'.repeat(MEMORY_PATH_MAX - dir.length - 3)}.md`
    expect([atBound.length, overBound.length]).toEqual([MEMORY_PATH_MAX, MEMORY_PATH_MAX + 1])
    fake.writeFile(atBound, '# At the bound')
    fake.writeFile(overBound, '# One past it')
    register()
    const r = await call('memory:scan') as { accountMemories: Array<{ truncated: boolean; files: Array<{ path: string; relPath: string }> }> }
    const listed = r.accountMemories[0].files.map((f) => f.path)
    expect(listed).toContain(atBound)
    expect(listed).not.toContain(overBound)
    expect(listed.every((p) => p.length <= MEMORY_PATH_MAX)).toBe(true)
    expect(r.accountMemories[0].truncated).toBe(true)
    // ...the PB6 files are still all there.
    expect(r.accountMemories[0].files.map((f) => f.relPath).filter((p) => !p.startsWith('a'))).toEqual([...PB6_LISTED_MD].filter((p) => !p.startsWith('a')))
    // The listed one opens through memory:read; the channel refuses the longer path itself.
    expect(await call('memory:read', atBound)).toContain('# At the bound')
    await expect(call('memory:read', overBound)).rejects.toThrow(/Invalid parameters/)
  })
})

describe('memory:read and memory:delete on an account memory path', () => {
  it('reads a listed file through the account guard', async () => {
    register()
    expect(await call('memory:read', `${MEM}\\MEMORY.md`)).toContain('# Memory')
    expect(await call('memory:read', `${MEM}\\extensions\\ad_hoc\\instructions.md`)).toContain('# Ad-hoc notes')
    expect(claude.read).not.toHaveBeenCalled()
  })

  it('never reads or deletes inside .git', async () => {
    register()
    await expect(call('memory:read', `${MEM}\\.git\\config`)).rejects.toThrow(/Refused/)
    await expect(call('memory:read', `${MEM}\\.git\\info\\notes.md`)).rejects.toThrow(/Refused/)
    await expect(call('memory:delete', `${MEM}\\.git\\HEAD`)).rejects.toThrow(/Refused/)
    expect(fake.calls.open.filter((p) => /\\\.git\\/i.test(p))).toEqual([])
    expect(fake.calls.unlink).toEqual([])
    expect(fake.exists(`${MEM}\\.git\\HEAD`)).toBe(true)
  })

  it('B-2: main refuses the delete too while it is not offered (ACCOUNT_MEMORY_DELETE_SHOWN): nothing is looked at or unlinked', async () => {
    // The built delete itself is account-memory-guard.test.ts's (deleteAccountMemory).
    expect(ACCOUNT_MEMORY_DELETE_SHOWN).toBe(false)
    register()
    const target = `${MEM}\\phase2_workspace_diff.md`
    await expect(call('memory:delete', target)).rejects.toThrow(/not offered/)
    expect(fake.exists(target)).toBe(true)
    expect(fake.calls.unlink).toEqual([])
    expect(fake.calls.lstat.filter((p) => p.toLowerCase() === target.toLowerCase())).toEqual([])
    expect(claude.del).not.toHaveBeenCalled()
  })

  it('a path beside the memories folder (the account folder itself) is not an account memory: the Claude rule refuses it', async () => {
    register()
    fake.writeFile(`${HOME}\\auth.json`, '{}')
    await expect(call('memory:read', `${HOME}\\auth.json`)).rejects.toThrow(/traversal/i)
    await expect(call('memory:delete', `${HOME}\\config.toml`)).rejects.toThrow(/traversal/i)
    expect(fake.calls.open).toEqual([])
    expect(claude.read).not.toHaveBeenCalled()
  })

  it('once the account is gone, its path is no longer an account memory', async () => {
    register({ sets: [] })
    await expect(call('memory:read', `${MEM}\\MEMORY.md`)).rejects.toThrow(/traversal/i)
    expect(fake.calls.open).toEqual([])
  })

  it('memory:writeFrontmatter stays Claude\'s: an account memory path is refused', async () => {
    register()
    await expect(call('memory:writeFrontmatter', `${MEM}\\MEMORY.md`, { name: 'x' })).rejects.toThrow(/traversal/i)
    expect(claude.fm).not.toHaveBeenCalled()
  })

  it("a Claude memory path never asks the accounts and goes to Claude's reader", async () => {
    register()
    const p = path.join(FAKE_HOME, '.claude', 'projects', 'F--X', 'memory', 'a.md')
    expect(await call('memory:read', p)).toBe('claude content')
    expect(claude.read).toHaveBeenCalledWith(p)
    expect(source).not.toHaveBeenCalled()
  })
})

describe('who may ask', () => {
  it('with the window wired, every memory channel answers only the app window main frame', async () => {
    register()
    for (const [ch, args] of [['memory:scan', []], ['memory:read', [`${MEM}\\MEMORY.md`]], ['memory:delete', [`${MEM}\\MEMORY.md`]],
      ['memory:writeFrontmatter', ['x', {}]], ['memory:recentSessions', ['F--X']]] as const) {
      await expect(handlers.get(ch)!(fromElsewhere, ...args), ch).rejects.toThrow(/not accepted/)
    }
    expect(source).not.toHaveBeenCalled()
    expect(fake.fileCalls()).toBe(0)
    expect(claude.scan).not.toHaveBeenCalled()
  })

  it('registered the old way (no window), the channels answer as before', async () => {
    register({ withWindow: false })
    expect(await handlers.get('memory:scan')!({}, )).toMatchObject({ accountMemories: expect.any(Array) })
  })

  // [host] PR 4 ADR-009 round 1 (L4-6): the window is optional here (the
  // channels' old callers), so only the app's own registration decides
  // whether the sender check exists. index.ts cannot be imported in a unit
  // test (it boots the app); this pins its source, comments removed.
  it("the app registers the memory channels once, with its window (the sender check) and the accounts' folders", () => {
    const src = readFileSync(path.resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    expect(src.split('registerMemoryHandlers(').length - 1).toBe(1)
    const calls = src.match(/registerMemoryHandlers\(\{[^}]*\}/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/[{,]\s*getWindow\s*[,}]/)
    expect(calls[0]).toMatch(/[{,]\s*accountFolders\s*:/)
    expect(src).toMatch(/import \{[^}]*\bregisterMemoryHandlers\b[^}]*\} from '\.\/ipc\/memory-handlers'/)
  })
})
