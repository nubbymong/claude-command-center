// [host] WP2 PR 4, P4.4 (row 56): each provider account's own log folders,
// opened from Settings through two channels keyed by account id and folder
// kind (debug:accountLogFolders, debug:openAccountLogFolder). Electron's
// ipcMain and shell are mocked and the file system is the in-memory one of
// tests/helpers/fake-account-fs.ts: no real folder, no shell, no process.
//
// The plan's cases (P4.4 Tests): an unknown id; a log_dir naming a file; a
// relative log_dir; a UNC path; a device path -- each refused, and for the UNC
// and device forms neither the file system (on that path) nor the shell is
// called. Beside them: a link or junction refused (the fake's link; the real
// junction cases are account-folders-links-real.test.ts's, CI and VM only), a
// link on the way refused,
// a missing folder, a folder not set, the sender check, the request shape,
// and config.toml's log_dir read as TOML reads it. The account's own log
// folder is opened; a log_dir (a folder its settings name) is only revealed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeAccountFs } from '../../helpers/fake-account-fs'
import type { FakeAccountFs } from '../../helpers/fake-account-fs'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>()
const openPath = vi.fn(async (_p: string) => '')
const reveal = vi.fn((_p: string) => {})
const shellReveal = vi.fn((_p: string) => {})
const shellOpen = vi.fn(async (_p: string) => '')
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => { handlers.set(ch, fn) }) },
  shell: { openPath: (p: string) => shellOpen(p), showItemInFolder: (p: string) => shellReveal(p) },
}))
vi.mock('../../../src/main/debug-capture', () => ({
  enableDebugMode: vi.fn(), disableDebugMode: vi.fn(), isDebugModeEnabled: vi.fn(() => false), getDebugDir: vi.fn(() => ''),
}))

const { registerAccountLogFolderHandlers } = await import('../../../src/main/ipc/debug-handlers')
const { parseLogDirSetting, listAccountLogFolders, openAccountLogFolder, hasShellObjectName } = await import('../../../src/main/account-folders')
type Set = import('../../../src/main/account-folders').AccountFolderSet

const frame = { id: 'main-frame' }
const win = { isDestroyed: () => false, webContents: { mainFrame: frame } }
const fromApp = { sender: win.webContents, senderFrame: frame }
const fromElsewhere = { sender: { other: true }, senderFrame: frame }

const W = 'C:\\Users\\me\\res\\codex-realms\\r1'
const winSet = (over: Partial<Set> = {}): Set => ({
  providerId: 'codex', accountId: 'acct-1', external: false,
  logDir: `${W}\\log`, memoriesDir: `${W}\\memories`, configFile: `${W}\\config.toml`, ...over,
})

let fake: FakeAccountFs
let source: ReturnType<typeof vi.fn>

function register(sets: Set[] | null, platform: 'win32' | 'linux' = 'win32') {
  handlers.clear()
  source = vi.fn(async () => sets)
  registerAccountLogFolderHandlers(() => win as never, source as never, { fs: fake as never, openPath, showItemInFolder: reveal, platform, log: () => {} })
}
const open = (input: unknown, e: unknown = fromApp) => handlers.get('debug:openAccountLogFolder')!(e, input)
const list = (e: unknown = fromApp) => handlers.get('debug:accountLogFolders')!(e)
/** Neither opened nor revealed. */
const expectShellUntouched = () => { expect(openPath).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled() }
/** File calls that named `p` (any of them). */
const callsOn = (p: string): number => Object.values(fake.calls).flat().filter((x) => x.toLowerCase() === p.toLowerCase()).length

beforeEach(() => {
  openPath.mockReset()
  openPath.mockImplementation(async () => '')
  reveal.mockReset()
  shellReveal.mockReset()
  shellOpen.mockReset()
  shellOpen.mockImplementation(async () => '')
  fake = createFakeAccountFs('win32')
  fake.mkdir(W)
  fake.mkdir(`${W}\\log`)
})

describe('debug:openAccountLogFolder -- the plan cases', () => {
  it('an unknown account id is refused as unknown, and nothing is opened', async () => {
    register([winSet()])
    expect(await open({ accountId: 'acct-nope', folder: 'log' })).toEqual({ ok: false, code: 'unknown-account' })
    expectShellUntouched()
    expect(fake.fileCalls()).toBe(0)
  })

  it('a log_dir naming a file is refused, and the shell never sees it', async () => {
    fake.writeFile('C:\\tools\\evil.exe', 'MZ')
    fake.writeFile(`${W}\\config.toml`, 'log_dir = "C:\\\\tools\\\\evil.exe"\n')
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    expectShellUntouched()
  })

  it('a relative log_dir is refused by its form, before any call on it', async () => {
    for (const rel of ['logs', '.\\logs', '..\\x', '~\\logs', 'C:logs', '\\logs']) {
      fake.writeFile(`${W}\\config.toml`, `log_dir = '${rel}'\n`)
      register([winSet()])
      const before = fake.fileCalls()
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), rel).toEqual({ ok: false, code: 'refused' })
      // Only the settings file was read (lstat + open), nothing on the folder.
      expect(fake.calls.lstat.slice(-1)[0]?.toLowerCase(), rel).toBe(`${W}\\config.toml`.toLowerCase())
      expect(fake.fileCalls() - before, rel).toBe(2)
    }
    expectShellUntouched()
  })

  it('a UNC path is refused by its form: neither the file system nor the shell is called on it', async () => {
    for (const unc of ['\\\\host\\share\\logs', '//host/share/logs', '\\\\host\\share']) {
      // From the settings file...
      fake.writeFile(`${W}\\config.toml`, `log_dir = '${unc}'\n`)
      register([winSet()])
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), unc).toEqual({ ok: false, code: 'refused' })
      expect(callsOn(unc), unc).toBe(0)
      // ...and as the account's own log folder: not one file call at all.
      register([winSet({ logDir: unc })])
      const before = fake.fileCalls()
      expect(await open({ accountId: 'acct-1', folder: 'log' }), unc).toEqual({ ok: false, code: 'refused' })
      expect(fake.fileCalls() - before, unc).toBe(0)
      // ...and as the account's settings file: never read, and no log-dir.
      register([winSet({ configFile: `${unc}\\config.toml` })])
      expect(await list(), unc).toEqual([{ accountId: 'acct-1', folders: ['log'] }])
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), unc).toEqual({ ok: false, code: 'refused' })
      expect(callsOn(`${unc}\\config.toml`), unc).toBe(0)
    }
    expectShellUntouched()
  })

  it('a device or verbatim path is refused by its form: neither the file system nor the shell is called on it', async () => {
    for (const dev of ['\\\\?\\C:\\logs', '\\\\.\\C:\\logs', '//?/C:/logs', '//./C:/logs', '\\??\\C:\\logs', '\\\\?\\UNC\\host\\share']) {
      fake.writeFile(`${W}\\config.toml`, `log_dir = '${dev}'\n`)
      register([winSet()])
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), dev).toEqual({ ok: false, code: 'refused' })
      expect(callsOn(dev), dev).toBe(0)
      register([winSet({ logDir: dev })])
      const before = fake.fileCalls()
      expect(await open({ accountId: 'acct-1', folder: 'log' }), dev).toEqual({ ok: false, code: 'refused' })
      expect(fake.fileCalls() - before, dev).toBe(0)
    }
    expectShellUntouched()
  })
})

describe('debug:openAccountLogFolder -- what a folder must be', () => {
  it('opens the account log folder at its real path', async () => {
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: true })
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath.mock.calls[0][0].toLowerCase()).toBe(`${W}\\log`.toLowerCase())
  })

  it('reveals a log_dir set in config.toml, in a basic or a literal string, at its real path', async () => {
    fake.mkdir('D:\\codex logs\\tui')
    for (const line of ['log_dir = "D:\\\\codex logs\\\\tui"', "log_dir = 'D:\\codex logs\\tui'", "log_dir = 'D:/codex logs/tui/'"]) {
      fake.writeFile(`${W}\\config.toml`, `model = "gpt-5.5"\n${line}\n\n[features]\nmemories = true\n`)
      register([winSet()])
      reveal.mockClear()
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), line).toEqual({ ok: true })
      expect(reveal.mock.calls, line).toEqual([['D:\\codex logs\\tui']])
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  // [host] PR 4 ADR-009 round 1 (L3-1, L3-2): a folder the account's settings
  // name is revealed on every OS, never opened: whatever it is named or
  // holds, the shell only shows it in the folder that holds it. The
  // account's own log folder (a path main names) is still opened.
  it('a log_dir is revealed, never opened, on every OS and whatever its name (on Windows, one not refused by name); the account\'s own log folder is opened', async () => {
    const cases: Array<{ platform: 'win32' | 'linux' | 'darwin'; home: string; sep: string; names: string[] }> = [
      { platform: 'darwin', home: '/Users/me/codex-home', sep: '/', names: ['/Users/me/work/Tool.app', '/Users/me/work/Flow.workflow', '/Users/me/work/Pane.prefPane', '/Users/me/work/logs', '/Users/me/work/x.{abc}/logs'] },
      { platform: 'win32', home: 'C:\\Users\\me\\codex-home', sep: '\\', names: ['C:\\Users\\me\\work\\logs', 'C:\\Users\\me\\work\\logs{1}', 'C:\\Users\\me\\work\\a.b\\{c}'] },
      { platform: 'linux', home: '/home/me/codex-home', sep: '/', names: ['/home/me/work/logs', '/home/me/work/logs.{00000000-0000-0000-0000-000000000000}'] },
    ]
    for (const c of cases) {
      for (const target of c.names) {
        fake = createFakeAccountFs(c.platform === 'win32' ? 'win32' : 'linux')
        const set = { providerId: 'codex' as const, accountId: 'acct-x', external: true, logDir: `${c.home}${c.sep}log`, memoriesDir: `${c.home}${c.sep}memories`, configFile: `${c.home}${c.sep}config.toml` }
        fake.mkdir(set.logDir)
        fake.mkdir(target)
        fake.writeFile(set.configFile, `log_dir = '${target}'\n`)
        openPath.mockClear()
        reveal.mockClear()
        const deps = { fs: fake as never, openPath, showItemInFolder: reveal, platform: c.platform }
        expect(await openAccountLogFolder({ accountId: 'acct-x', folder: 'log-dir' }, async () => [set], deps), target).toEqual({ ok: true })
        expect(reveal.mock.calls, target).toEqual([[target]])
        expect(openPath, target).not.toHaveBeenCalled()
        expect(await openAccountLogFolder({ accountId: 'acct-x', folder: 'log' }, async () => [set], deps), target).toEqual({ ok: true })
        expect(openPath.mock.calls, target).toEqual([[set.logDir]])
        expect(reveal, target).toHaveBeenCalledTimes(1)
      }
    }
  })

  // [host] PR 4 ADR-009 round 2 (L3 r2): on Windows a folder name ending in
  // `.{...}` may be taken for a shell object rather than a plain folder; a
  // log_dir with one anywhere on its path is refused by name, before any
  // file call on it, and neither shown nor opened.
  it('Windows: a log_dir with a folder name ending in .{...} anywhere on its path is refused, before any file call on it, and never shown', async () => {
    const guid = '{00000000-0000-0000-0000-000000000000}'
    for (const target of [`C:\\Users\\me\\work\\logs.${guid}`, `C:\\Users\\me\\work\\x.${guid}\\logs`, `C:\\Users\\me\\x.${guid}\\a\\b`, 'D:\\x.{anything}\\logs', 'D:/x.{y}/logs/']) {
      fake.mkdir(target)
      fake.writeFile(`${W}\\config.toml`, `log_dir = '${target}'\n`)
      register([winSet()])
      expect(await open({ accountId: 'acct-1', folder: 'log-dir' }), target).toEqual({ ok: false, code: 'refused' })
      expect(callsOn(target), target).toBe(0)
    }
    expectShellUntouched()
    // The account's own log folder (a path main names) is not held to it.
    fake.mkdir(`C:\\Users\\me\\x.${guid}\\log`)
    register([winSet({ logDir: `C:\\Users\\me\\x.${guid}\\log` })])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: true })
  })

  it('the name rule: any folder name ending in .{...}, trailing dots and spaces set aside; nothing else', () => {
    for (const p of ['C:\\a\\x.{g}', 'C:\\x.{g}\\a', 'C:\\a\\x.{g}.', 'C:\\a\\x.{g} . \\b', 'C:/a/x.{}/b', 'x.{g}']) expect(hasShellObjectName(p), p).toBe(true)
    for (const p of ['C:\\a\\x{g}', 'C:\\a\\{g}', 'C:\\a\\x.{g}y', 'C:\\a\\x.g}', 'C:\\a\\logs', 'C:\\a.{b\\c}']) expect(hasShellObjectName(p), p).toBe(false)
    // One pass: a long name is decided at once.
    const t0 = performance.now()
    expect(hasShellObjectName(`C:\\${'.{'.repeat(200_000)}x`)).toBe(false)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('a log_dir with no way to reveal it, or whose reveal throws, is refused and never opened', async () => {
    fake.mkdir('D:\\x')
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\x'\n")
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log-dir' }, async () => [winSet()], { fs: fake as never, openPath, platform: 'win32' } as never)).toEqual({ ok: false, code: 'refused' })
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log-dir' }, async () => [winSet()], { fs: fake as never, openPath, showItemInFolder: () => { throw new Error('no shell') }, platform: 'win32' })).toEqual({ ok: false, code: 'refused' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('the channel\'s own shell: the account log folder through shell.openPath, a log_dir through shell.showItemInFolder', async () => {
    fake.mkdir('D:\\x')
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\x'\n")
    handlers.clear()
    registerAccountLogFolderHandlers(() => win as never, (async () => [winSet()]) as never, { fs: fake as never, platform: 'win32', log: () => {} })
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: true })
    expect(shellReveal.mock.calls).toEqual([['D:\\x']])
    expect(shellOpen).not.toHaveBeenCalled()
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: true })
    expect(shellOpen.mock.calls.map((c) => c[0].toLowerCase())).toEqual([`${W}\\log`.toLowerCase()])
    expect(shellReveal).toHaveBeenCalledTimes(1)
  })

  it('a log_dir that is a link or junction is refused', async () => {
    fake.mkdir('D:\\elsewhere')
    fake.symlink('D:\\elsewhere', 'D:\\linked-logs')
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\linked-logs'\n")
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    expectShellUntouched()
  })

  it('a folder reached through a link on the way is refused (its real path is not its own)', async () => {
    fake.mkdir('D:\\real\\logs')
    fake.symlink('D:\\real', 'D:\\via')
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\via\\logs'\n")
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    // The account's own log folder made a link is refused too.
    fake.remove(`${W}\\log`)
    fake.symlink('D:\\real\\logs', `${W}\\log`)
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: false, code: 'refused' })
    expectShellUntouched()
  })

  it('a folder that is not there is not found; a log_dir not set is not set', async () => {
    fake.remove(`${W}\\log`)
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: false, code: 'not-found' })
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'not-set' })
    fake.writeFile(`${W}\\config.toml`, 'model = "x"\n[profiles.a]\nlog_dir = "D:\\\\x"\n')
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'not-set' })
    expectShellUntouched()
  })

  it('a settings file that is a link, or that TOML cannot read for certain, is refused', async () => {
    fake.writeFile('D:\\other.toml', "log_dir = 'D:\\x'\n")
    fake.symlink('D:\\other.toml', `${W}\\config.toml`)
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    fake.remove(`${W}\\config.toml`)
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\x'\nlog_dir = 'D:\\y'\n")
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    expectShellUntouched()
  })

  it('a settings file over 256 KiB is not read: refused, and listed without log-dir', async () => {
    fake.mkdir('D:\\x')
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\x'\n" + '#'.repeat(256 * 1024))
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log-dir' })).toEqual({ ok: false, code: 'refused' })
    expect(await list()).toEqual([{ accountId: 'acct-1', folders: ['log'] }])
    expectShellUntouched()
  })

  it('B-3: a log folder main names in another non-ASCII case than the disk opens, at its real path', async () => {
    fake.mkdir('C:\\Users\\\u00d6zil\\codex-home\\log')
    register([winSet({ logDir: 'c:\\users\\\u00f6zil\\codex-home\\log' })])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: true })
    expect(openPath.mock.calls[0][0]).toBe('C:\\Users\\\u00d6zil\\codex-home\\log')
  })

  it('a shell that cannot open the folder is reported, not thrown', async () => {
    openPath.mockImplementation(async () => 'Failed to open path')
    register([winSet()])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: false, code: 'refused' })
  })

  it('POSIX: a fully qualified folder opens (a log_dir: is revealed); a relative one and a // one are refused by form', async () => {
    fake = createFakeAccountFs('linux')
    fake.mkdir('/home/me/codex-home/log')
    fake.mkdir('/var/tmp/codex-logs')
    const set = { providerId: 'codex' as const, accountId: 'acct-x', external: true, logDir: '/home/me/codex-home/log', memoriesDir: '/home/me/codex-home/memories', configFile: '/home/me/codex-home/config.toml' }
    fake.writeFile(set.configFile, "log_dir = '/var/tmp/codex-logs'\n")
    register([set], 'linux')
    expect(await open({ accountId: 'acct-x', folder: 'log' })).toEqual({ ok: true })
    expect(await open({ accountId: 'acct-x', folder: 'log-dir' })).toEqual({ ok: true })
    for (const bad of ['codex-logs', '~/logs', '//host/share', '/var/../etc']) {
      fake.writeFile(set.configFile, `log_dir = '${bad}'\n`)
      expect(await open({ accountId: 'acct-x', folder: 'log-dir' }), bad).toEqual({ ok: false, code: 'refused' })
      expect(callsOn(bad), bad).toBe(0)
    }
    expect(openPath.mock.calls).toEqual([['/home/me/codex-home/log']])
    expect(reveal.mock.calls).toEqual([['/var/tmp/codex-logs']])
  })
})

describe('the two channels: who may ask, and what', () => {
  it('a request from anywhere but the app window main frame is refused before anything is read', async () => {
    register([winSet()])
    await expect(open({ accountId: 'acct-1', folder: 'log' }, fromElsewhere)).rejects.toThrow(/not accepted/)
    await expect(list(fromElsewhere)).rejects.toThrow(/not accepted/)
    const subframe = { sender: win.webContents, senderFrame: { id: 'child' } }
    await expect(open({ accountId: 'acct-1', folder: 'log' }, subframe)).rejects.toThrow(/not accepted/)
    expect(source).not.toHaveBeenCalled()
    expect(fake.fileCalls()).toBe(0)
    expectShellUntouched()
  })

  it('only { accountId, folder } with a known kind: a path, an extra key or an odd shape is refused before the accounts are asked', async () => {
    register([winSet()])
    // B-1: the strict schema. A request whose only fault is its account id
    // answers as an unknown account; any other fault is refused.
    const cases: Array<[unknown, 'refused' | 'unknown-account']> = [
      [null, 'refused'], [undefined, 'refused'], ['acct-1', 'refused'], [['acct-1', 'log'], 'refused'], [{}, 'refused'],
      [{ accountId: 'acct-1' }, 'refused'], [{ accountId: 'acct-1', folder: 'log', path: 'C:\\x' }, 'refused'],
      [{ accountId: 'acct-1', folder: 'C:\\Windows' }, 'refused'], [{ accountId: 'acct-1', folder: 'sessions' }, 'refused'],
      [{ accountId: 'acct-1', folder: ['log'] }, 'refused'], [{ accountId: 7, folder: 'sessions' }, 'refused'],
      [{ accountId: 7, folder: 'log' }, 'unknown-account'], [{ accountId: '', folder: 'log' }, 'unknown-account'],
      [{ accountId: 'a'.repeat(201), folder: 'log' }, 'unknown-account'], [{ folder: 'log' }, 'unknown-account'],
    ]
    for (const [bad, code] of cases) {
      expect(await open(bad), JSON.stringify(bad) ?? String(bad)).toEqual({ ok: false, code })
    }
    expect(source).not.toHaveBeenCalled()
    expectShellUntouched()
    // The longest id the schema takes reaches the accounts (and is not one).
    expect(await open({ accountId: 'a'.repeat(200), folder: 'log' })).toEqual({ ok: false, code: 'unknown-account' })
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('debug:accountLogFolders names kinds, never paths: log always, log-dir when set', async () => {
    const W2 = 'C:\\Users\\me\\res\\codex-realms\\r2'
    fake.writeFile(`${W}\\config.toml`, "log_dir = 'D:\\x'\n")
    fake.writeFile(`${W2}\\config.toml`, 'log_dir = [\n')
    register([winSet(), winSet({ accountId: 'acct-2', logDir: `${W2}\\log`, memoriesDir: `${W2}\\memories`, configFile: `${W2}\\config.toml` }), winSet({ accountId: 'acct-3', configFile: 'C:\\none\\config.toml' })])
    const r = await list()
    expect(r).toEqual([
      { accountId: 'acct-1', folders: ['log', 'log-dir'] },
      { accountId: 'acct-2', folders: ['log'] },
      { accountId: 'acct-3', folders: ['log'] },
    ])
    expect(JSON.stringify(r)).not.toMatch(/[\\/]/)
  })

  it('no accounts yet (the registry not read) lists none and opens none', async () => {
    register(null)
    expect(await list()).toEqual([])
    expect(await open({ accountId: 'acct-1', folder: 'log' })).toEqual({ ok: false, code: 'unknown-account' })
    source.mockRejectedValueOnce(new Error('boom'))
    expect(await listAccountLogFolders(source as never, { fs: fake as never, openPath, showItemInFolder: reveal, platform: 'win32' })).toEqual([])
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log' }, async () => { throw new Error('x') }, { fs: fake as never, openPath, showItemInFolder: reveal, platform: 'win32' })).toEqual({ ok: false, code: 'unknown-account' })
  })
})

describe("config.toml's log_dir, read as TOML reads it", () => {
  const set = (value: string) => ({ kind: 'set', value })
  it.each([
    ['log_dir = "C:\\\\logs"', set('C:\\logs')],
    ["log_dir = 'C:\\logs'", set('C:\\logs')],
    ['  log_dir   =   "/var/log/codex"   # a comment', set('/var/log/codex')],
    ['"log_dir" = "/a"', set('/a')],
    ["'log_dir' = '/a'", set('/a')],
    ['"log\\u005fdir" = "/a"', set('/a')],
    ['log_dir = "/caf\\u00e9"', set('/caf\u00e9')],
    ['\ufefflog_dir = "/bom"', set('/bom')],
    ['log_dir = "/a"\r\nmodel = "x"\r\n', set('/a')],
  ])('%s', (src, want) => {
    expect(parseLogDirSetting(src)).toEqual(want)
  })

  it('only the root table: a key under a table header is not the root one', () => {
    expect(parseLogDirSetting('[tui]\nlog_dir = "/a"\n')).toEqual({ kind: 'unset' })
    expect(parseLogDirSetting('model = "x"\n[[profiles]]\nlog_dir = "/a"\n')).toEqual({ kind: 'unset' })
    expect(parseLogDirSetting('a.log_dir = "/a"\n')).toEqual({ kind: 'unset' })
  })

  it('multi-line strings, arrays and inline tables are stepped over whole, whatever they hold', () => {
    const src = [
      'developer_instructions = """',
      'log_dir = "/not/this"',
      '[not-a-table]',
      '"""',
      "notes = '''",
      "log_dir = '/nor/this'",
      "'''",
      'list = [ "a", # a comment',
      '  "]", [ "log_dir = 1" ] ]',
      'tbl = { log_dir = "/x", y = "}" }',
      'when = 1979-05-27 07:32:00Z',
      'log_dir = "/the/one"',
      '[features]',
      'log_dir = "/later"',
    ].join('\n')
    expect(parseLogDirSetting(src)).toEqual(set('/the/one'))
    expect(parseLogDirSetting('a = """x""""\nlog_dir = "/q"\n')).toEqual(set('/q'))
  })

  it('anything it cannot read for certain is invalid, never a guess', () => {
    for (const bad of [
      'log_dir = "/a"\nlog_dir = "/b"\n', // a second one
      'log_dir = "/a"\n"log_dir" = "/b"\n', // the same key quoted
      'log_dir = 5\n', // not a string
      'log_dir = ["/a"]\n',
      'log_dir = """/a"""\n', // multi-line: not a path here
      'log_dir.x = "/a"\n', // a table
      'log_dir = "/a" junk\n',
      'log_dir = "/a\n',
      'log_dir = "\\q"\n', // an unknown escape
      'log_dir = "\\uD800"\n', // a lone surrogate
      'log_dir = \n',
      'log_dir "/a"\n',
      'x = [1, 2\nlog_dir = "/a"\n', // an array never closed
    ]) {
      expect(parseLogDirSetting(bad), JSON.stringify(bad)).toEqual({ kind: 'invalid' })
    }
  })

  it('none set is unset', () => {
    expect(parseLogDirSetting('')).toEqual({ kind: 'unset' })
    expect(parseLogDirSetting('# only a comment\n\nmodel = "gpt-5.5"\n')).toEqual({ kind: 'unset' })
  })
})
