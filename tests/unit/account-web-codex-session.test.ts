// [host] WP2 PR 4, P4.6 first half (row 58): a Codex account's own web
// session, at the partition and the profile-keyed channels. The second half
// (the sign-in window, the pane's chatgpt.com surface and their own codexWeb
// channels) is pinned in codex-web-sign-in, codex-web-pane and
// codex-web-handlers.test.ts.
//
// What this pins, every case a refusal or an isolation property (ADR-009):
//  - the partition builder for the `account` id class: keyed by the registry
//    account id, its own prefix, the registry id pattern enforced, a Claude
//    profile id refused; Claude's builder refuses an account id; the two
//    classes' partitions can never name each other;
//  - the orphan-partition warning at a dev start covers the new prefix, lists
//    only names with one of the two prefixes, never lists the live location
//    and never removes anything;
//  - every profile-keyed accountWeb:* channel still refuses an account id,
//    before any sign-in, cookie read, window or settings write: nothing of
//    Claude's claude.ai flow (the system browser's cookie copy included) can
//    run for a Codex account.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- fs: every call recorded, every mutating one a spy that must stay unused
const listing: { dirs: Record<string, string[]>; unreadable: Set<string> } = { dirs: {}, unreadable: new Set() }
const fsMutations = {
  rmSync: vi.fn(), rmdirSync: vi.fn(), unlinkSync: vi.fn(), renameSync: vi.fn(),
  writeFileSync: vi.fn(), mkdirSync: vi.fn(), cpSync: vi.fn(), copyFileSync: vi.fn(),
}
const norm = (p: string) => p.replace(/\\/g, '/')
vi.mock('fs', () => ({
  existsSync: (p: string) => norm(p) in listing.dirs,
  readdirSync: (p: string) => {
    if (listing.unreadable.has(norm(p))) throw new Error(`EACCES: ${p}`)
    const d = listing.dirs[norm(p)]
    if (!d) throw new Error(`ENOENT: ${p}`)
    return [...d]
  },
  ...fsMutations,
  promises: { rm: vi.fn(), rmdir: vi.fn(), unlink: vi.fn(), rename: vi.fn() },
}))

const logs: string[] = []
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
}))

// ---- the accountWeb:* handlers, with everything they could act on mocked
const handlers: Record<string, (e: unknown, ...args: unknown[]) => unknown> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers[ch] = fn } },
  BrowserWindow: { fromWebContents: () => ({}) },
}))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:/fake/data' }))
const acted = {
  runSignIn: vi.fn(), cancelSignIn: vi.fn(), clearWebSession: vi.fn(), getSignInState: vi.fn(),
  openArtifacts: vi.fn(() => ({ ok: true })), closeArtifacts: vi.fn(),
  readClaudeCliAuth: vi.fn(async () => ({ authenticated: false })),
  viewFor: vi.fn(), saveWebSession: vi.fn(() => true), removeWebSession: vi.fn(),
  setAuthMethod: vi.fn(), setAuthBrowser: vi.fn(), setWebSignInMode: vi.fn(),
  getAuthMethod: vi.fn(() => 'claudeai'), getAuthBrowser: vi.fn(() => 'edge'), getWebSignInMode: vi.fn(() => 'auto'),
  openAccountPane: vi.fn(() => ({ ok: true })), closeAccountPanesForProfile: vi.fn(), closeWebview: vi.fn(),
  listProfiles: vi.fn(() => [{ id: 'profile-known1' }]),
}
vi.mock('../../src/main/account-web/sign-in', () => ({
  runSignIn: acted.runSignIn, cancelSignIn: acted.cancelSignIn, clearWebSession: acted.clearWebSession,
  getSignInState: acted.getSignInState, detectAuthBrowsers: () => [], discardSignInRun: vi.fn(),
}))
vi.mock('../../src/main/account-web/artifacts', () => ({ openArtifacts: acted.openArtifacts, closeArtifacts: acted.closeArtifacts }))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({ readClaudeCliAuth: acted.readClaudeCliAuth, claudeAuthCommand: () => 'claude auth login' }))
vi.mock('../../src/main/account-web/session-store', () => ({
  viewFor: acted.viewFor, saveWebSession: acted.saveWebSession, removeWebSession: acted.removeWebSession,
  setAuthMethod: acted.setAuthMethod, setAuthBrowser: acted.setAuthBrowser, setWebSignInMode: acted.setWebSignInMode,
  getAuthMethod: acted.getAuthMethod, getAuthBrowser: acted.getAuthBrowser, getWebSignInMode: acted.getWebSignInMode,
  claudeWebStoreIsNewer: () => false, NEWER_WEB_STORE_REASON: 'written by a newer version of the app',
}))
vi.mock('../../src/main/account-web/account-pane', () => ({
  openAccountPane: acted.openAccountPane, closeAccountPanesForProfile: acted.closeAccountPanesForProfile,
  closeAccountPane: vi.fn(), getAccountPaneState: vi.fn(), reloadAccountPane: vi.fn(),
  setAccountPaneBounds: vi.fn(), setAccountPaneVisible: vi.fn(),
}))
vi.mock('../../src/main/account-profiles', () => ({ listProfiles: acted.listProfiles }))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: acted.closeWebview }))

const {
  webPartitionForProfile, webPartitionForCodexAccount, CODEX_WEB_PARTITION_PREFIX, CLAUDE_WEB_PARTITION_PREFIX,
  isWebSessionPartitionDir, webSessionIdClass,
} = await import('../../src/shared/account-web-session')
const { listOrphanedSharedWebPartitions, warnAboutOrphanedSharedPartitions } = await import('../../src/main/account-web/orphan-partitions')
const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')
/** The app window and its main frame: the only sender these handlers answer. */
const APP_FRAME = {}
const APP_WIN = { isDestroyed: () => false, webContents: { mainFrame: APP_FRAME, send: () => {} } }
const APP_EVENT = { sender: APP_WIN.webContents, senderFrame: APP_FRAME }
const { IPC } = await import('../../src/shared/ipc-channels')

const ACCT_A = 'acct-0123456789abcdef'
const ACCT_B = 'acct-fedcba9876543210'
const PROFILE = 'profile-mrdsqlsb-aefe03'

describe('webPartitionForCodexAccount: the account class has its own partition', () => {
  it('names a persistent partition with its own prefix, keyed by the registry account id', () => {
    expect(CODEX_WEB_PARTITION_PREFIX).toBe('persist:codex-web-')
    expect(webPartitionForCodexAccount(ACCT_A)).toBe(`persist:codex-web-${ACCT_A}`)
    expect(webPartitionForCodexAccount('acct-' + 'a'.repeat(64))).toBe('persist:codex-web-acct-' + 'a'.repeat(64))
  })

  it('gives each account its own partition', () => {
    expect(webPartitionForCodexAccount(ACCT_A)).not.toBe(webPartitionForCodexAccount(ACCT_B))
  })

  it('REFUSES a Claude profile id, and anything off the registry pattern, rather than sanitising it', () => {
    for (const bad of [
      PROFILE, 'profile-abc123',
      'acct-0123', 'acct-0123456789ABCDEF', 'acct-' + 'a'.repeat(65), 'acct-0123456789abcdeg',
      'realm-0123456789abcdef', 'idn-0123456789abcdef', 'grp-0123456789abcdef',
      ` ${ACCT_A}`, `${ACCT_A}\n`, `${ACCT_A}/..`, `../${ACCT_A}`, `${ACCT_A}/x`,
      `persist:codex-web-${ACCT_A}`, `persist:claude-web-${PROFILE}`, `codex-web-${ACCT_A}`,
      '', 'acct-', 'ACCT-0123456789abcdef',
    ]) {
      expect(() => webPartitionForCodexAccount(bad), JSON.stringify(bad)).toThrow(/unexpected account id/)
    }
    for (const bad of [undefined, null, 7, {}, [ACCT_A]]) {
      expect(() => webPartitionForCodexAccount(bad as never), JSON.stringify(bad)).toThrow(/unexpected account id/)
    }
  })

  it("Claude's builder refuses an account id: neither builder accepts the other class", () => {
    for (const id of [ACCT_A, ACCT_B, 'acct-' + 'f'.repeat(64)]) {
      expect(webSessionIdClass(id)).toBe('account')
      expect(() => webPartitionForProfile(id)).toThrow(/unexpected profile id/)
    }
    expect(webSessionIdClass(PROFILE)).toBe('profile')
    expect(() => webPartitionForCodexAccount(PROFILE)).toThrow(/unexpected account id/)
  })

  it('the two classes can never name the same partition', () => {
    const profiles = ['profile-a', PROFILE, 'profile-acct-0123456789abcdef', 'profile-codex-web-x', 'profile-' + 'z'.repeat(64)]
    const accounts = [ACCT_A, ACCT_B, 'acct-' + '0'.repeat(16), 'acct-' + 'e'.repeat(64)]
    const claudeParts = profiles.map((p) => webPartitionForProfile(p))
    const codexParts = accounts.map((a) => webPartitionForCodexAccount(a))
    for (const c of claudeParts) {
      expect(c.startsWith(CLAUDE_WEB_PARTITION_PREFIX)).toBe(true)
      expect(c.startsWith(CODEX_WEB_PARTITION_PREFIX)).toBe(false)
      expect(codexParts).not.toContain(c)
    }
    for (const c of codexParts) {
      expect(c.startsWith(CODEX_WEB_PARTITION_PREFIX)).toBe(true)
      expect(c.startsWith(CLAUDE_WEB_PARTITION_PREFIX)).toBe(false)
    }
    // Neither prefix is a prefix of the other, so no id can bridge them.
    expect(CLAUDE_WEB_PARTITION_PREFIX.startsWith(CODEX_WEB_PARTITION_PREFIX)).toBe(false)
    expect(CODEX_WEB_PARTITION_PREFIX.startsWith(CLAUDE_WEB_PARTITION_PREFIX)).toBe(false)
  })

  it('the builder is the same string Electron keeps on disk (lower case, nothing to escape)', () => {
    const name = webPartitionForCodexAccount(ACCT_A).slice('persist:'.length)
    expect(name).toBe(name.toLowerCase())
    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(isWebSessionPartitionDir(name)).toBe(true)
  })
})

describe('isWebSessionPartitionDir: the on-disk names of the two web-session partitions', () => {
  it('matches a partition directory of either class', () => {
    expect(isWebSessionPartitionDir(`claude-web-${PROFILE}`)).toBe(true)
    expect(isWebSessionPartitionDir(`codex-web-${ACCT_A}`)).toBe(true)
  })

  it('matches nothing else: the browser pane, other partitions, near-misses', () => {
    for (const other of [
      'webview-s1', 'webview-claude-web-x', 'webview-codex-web-x', 'claude-web', 'codex-web', 'claude-webx', 'codex-webview-1',
      'xclaude-web-profile-a', 'xcodex-web-acct-0123456789abcdef', 'persist:codex-web-acct-0123456789abcdef', '', '.', '..',
    ]) {
      expect(isWebSessionPartitionDir(other), other).toBe(false)
    }
  })
})

describe('the orphan-partition warning at a dev start (index.ts, #261) covers the new prefix', () => {
  const USER_DATA = 'C:/Users/u/AppData/Roaming/claude-conductor'
  const SHARED = `${USER_DATA}/Partitions`
  const DEV = 'C:/Users/u/AppData/Local/Claude Command Center/dev/session-data'

  beforeEach(() => {
    logs.length = 0
    listing.dirs = {}
    for (const f of Object.values(fsMutations)) f.mockClear()
  })

  const noMutation = () => {
    for (const [name, f] of Object.entries(fsMutations)) expect(f, name).not.toHaveBeenCalled()
  }

  it("lists a Codex account's partition beside Claude's, and only those", () => {
    listing.dirs[SHARED] = [`claude-web-${PROFILE}`, `codex-web-${ACCT_A}`, 'webview-s1', 'webview-codex-web-x', 'codex-webview-1', 'Cache']
    expect(listOrphanedSharedWebPartitions(USER_DATA, DEV).sort()).toEqual([`claude-web-${PROFILE}`, `codex-web-${ACCT_A}`].sort())
    noMutation()
  })

  it('warns, naming the shared location and the count, and removes nothing', () => {
    listing.dirs[SHARED] = [`codex-web-${ACCT_A}`, `codex-web-${ACCT_B}`, `claude-web-${PROFILE}`]
    warnAboutOrphanedSharedPartitions(() => USER_DATA, DEV)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('3 web session partition(s)')
    expect(norm(logs[0])).toContain(SHARED)
    expect(logs[0]).toMatch(/hold live session cookies/)
    expect(logs[0]).toMatch(/by hand ONLY/)
    noMutation()
  })

  it('a Codex partition alone is enough to warn', () => {
    listing.dirs[SHARED] = [`codex-web-${ACCT_A}`]
    warnAboutOrphanedSharedPartitions(() => USER_DATA, DEV)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('1 web session partition(s)')
    noMutation()
  })

  it('never lists the LIVE location: when the shared location is the one in use, nothing is an orphan', () => {
    listing.dirs[SHARED] = [`claude-web-${PROFILE}`, `codex-web-${ACCT_A}`]
    expect(listOrphanedSharedWebPartitions(USER_DATA, USER_DATA)).toEqual([])
    warnAboutOrphanedSharedPartitions(() => USER_DATA, USER_DATA)
    expect(logs).toEqual([])
    noMutation()
  })

  it('says nothing when only non-matching partitions are there, or there is no shared location', () => {
    listing.dirs[SHARED] = ['webview-s1', 'codex-webview-1', 'claude-webx']
    warnAboutOrphanedSharedPartitions(() => USER_DATA, DEV)
    delete listing.dirs[SHARED]
    warnAboutOrphanedSharedPartitions(() => USER_DATA, DEV)
    expect(logs).toEqual([])
    noMutation()
  })

  it('a user-data folder that cannot be read never throws out of the warning either', () => {
    expect(() => warnAboutOrphanedSharedPartitions(() => { throw new Error('no userData') }, DEV)).not.toThrow()
    expect(logs).toEqual([])
    noMutation()
  })

  it('an unreadable location never throws out of the warning (advisory only, boot goes on)', () => {
    listing.dirs[SHARED] = [`codex-web-${ACCT_A}`]
    listing.unreadable.add(SHARED)
    try {
      expect(() => warnAboutOrphanedSharedPartitions(() => USER_DATA, DEV)).not.toThrow()
    } finally {
      listing.unreadable.clear()
    }
    expect(logs).toEqual([])
    noMutation()
  })
})

describe('every profile-keyed accountWeb:* channel refuses an account id (nothing of the claude.ai flow runs for it)', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    for (const f of Object.values(acted)) f.mockClear()
    registerAccountWebHandlers(() => APP_WIN as never)
  })

  const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }
  const calls: Array<[string, unknown]> = [
    [IPC.ACCOUNT_WEB_WEB_STATUS, ACCT_A],
    [IPC.ACCOUNT_WEB_STATUS, ACCT_A],
    [IPC.ACCOUNT_WEB_SIGN_IN, ACCT_A],
    [IPC.ACCOUNT_WEB_CANCEL, ACCT_A],
    [IPC.ACCOUNT_WEB_SIGN_OUT, ACCT_A],
    [IPC.ACCOUNT_WEB_SET_AUTH_METHOD, { profileId: ACCT_A, method: 'sso' }],
    [IPC.ACCOUNT_WEB_SET_AUTH_BROWSER, { profileId: ACCT_A, browser: 'chrome' }],
    [IPC.ACCOUNT_WEB_OPEN_ARTIFACTS, ACCT_A],
    [IPC.ACCOUNT_WEB_SET_SIGN_IN_MODE, { profileId: ACCT_A, mode: 'internal-pane' }],
    [IPC.ACCOUNT_WEB_PANE_OPEN, { sessionId: 's1', profileId: ACCT_A, bounds: BOUNDS }],
  ]

  it.each(calls)('%s refuses it before acting', async (channel, arg) => {
    expect(typeof handlers[channel], channel).toBe('function')
    const res = (await handlers[channel](APP_EVENT, arg)) as { ok: boolean }
    expect(res.ok).toBe(false)
    // Refused at the boundary: not even a read of the account's settings or
    // the profile list happens for an id of the other class.
    for (const [name, f] of Object.entries(acted)) {
      expect(f, `${channel} reached ${name}`).not.toHaveBeenCalled()
    }
  })

  it("Claude's handler registration serves no codexWeb channel: a Codex account's surface has its own gated channels", () => {
    const registered = Object.keys(handlers)
    expect(registered.length).toBeGreaterThan(0)
    expect(registered.every((ch) => ch.startsWith('accountWeb:'))).toBe(true)
    for (const ch of [IPC.CODEX_WEB_STATUS, IPC.CODEX_WEB_SIGN_IN, IPC.CODEX_WEB_SIGN_IN_STATE, IPC.CODEX_WEB_CANCEL, IPC.CODEX_WEB_SIGN_OUT, IPC.CODEX_WEB_PANE_OPEN]) {
      expect(handlers[ch], ch).toBeUndefined()
    }
  })

  it('the same channels still serve a Claude profile id (the control: the refusal is about the class)', async () => {
    const res = (await handlers[IPC.ACCOUNT_WEB_OPEN_ARTIFACTS](APP_EVENT, 'profile-known1')) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(acted.openArtifacts).toHaveBeenCalledWith('profile-known1', expect.anything())
    const pane = (await handlers[IPC.ACCOUNT_WEB_PANE_OPEN](APP_EVENT, { sessionId: 's1', profileId: 'profile-known1', bounds: BOUNDS })) as { ok: boolean }
    expect(pane.ok).toBe(true)
    expect(acted.openAccountPane).toHaveBeenCalledTimes(1)
  })
})
