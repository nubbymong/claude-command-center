// [host] WP2 PR 4, P4.4 (row 55): the existing memory channels with each
// provider account's own memories wired in (registerMemoryHandlers'
// accountFolders). ipcMain is mocked, Claude's scanner is mocked (nothing
// reads ~/.claude), os.homedir points at a folder that does not exist, and an
// account's memories live in the in-memory file system of
// tests/helpers/fake-account-fs.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
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
const { ACCOUNT_MEMORY_DELETE_SHOWN } = await import('../../../src/shared/account-memories')

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
})
