/**
 * WP2: nothing starts the Claude CLI while Claude Code is switched off --
 * the probes and helpers that would, besides the launches, each answer "off"
 * in their existing result shape instead, so the surface asking shows Claude
 * Code is off rather than an error:
 *
 *  - `accountWeb:status` (the account panel, the sidebar menu): its
 *    `claude auth status` half, which can rotate the account's refresh token,
 *    is not run; `cli.notChecked` carries the reason;
 *  - `cli:version` (onboarding's "Find Claude"): `claude --version` is not
 *    run; the answer is the refusal;
 *  - `legacyVersion:install`: a pinned Claude Code CLI is not installed; the
 *    answer is `{ ok: false, error }` with the reason.
 *
 * The REAL handlers and the REAL launch gate; the accounts service's answer
 * is scripted (its rule is proven against real settings in
 * provider-launch-gate.test.ts), and what would run a process is faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (e: unknown, ...args: unknown[]) => unknown> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers[channel] = fn }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getVersion: () => '0.0.0' },
}))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:/fake/data' }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ cancelSignIn: vi.fn(), clearWebSession: vi.fn(), getSignInState: vi.fn(), runSignIn: vi.fn(), detectAuthBrowsers: vi.fn(() => []) }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn(), openArtifacts: vi.fn() }))
const readClaudeCliAuth = vi.fn(async () => ({ authenticated: true, email: 'someone@example.com' }))
vi.mock('../../../src/main/account-web/claude-cli-auth', () => ({
  readClaudeCliAuth: (...a: unknown[]) => readClaudeCliAuth(...(a as [])),
  claudeAuthCommand: vi.fn(() => 'claude auth login'),
}))
vi.mock('../../../src/main/account-web/session-store', () => ({
  getAuthBrowser: vi.fn(() => 'chrome'), getAuthMethod: vi.fn(() => 'claudeai'), getWebSignInMode: vi.fn(() => 'auto'),
  removeWebSession: vi.fn(), saveWebSession: vi.fn(), setAuthBrowser: vi.fn(), setAuthMethod: vi.fn(), setWebSignInMode: vi.fn(),
  viewFor: vi.fn((profileId: string) => ({ profileId, status: 'active' })),
}))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }) }))
const spawnClaudeHeadless = vi.fn(async () => ({ code: 0, stdout: '2.1.281 (Claude Code)', stderr: '' }))
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: (...a: unknown[]) => spawnClaudeHeadless(...(a as [])) }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn() }))
const installVersion = vi.fn(async () => ({ ok: true }))
vi.mock('../../../src/main/legacy-version-manager', () => ({
  initLegacyVersionManager: vi.fn(), fetchAvailableVersions: vi.fn(), isVersionInstalled: vi.fn(() => false),
  installVersion: (...a: unknown[]) => installVersion(...(a as [])), removeVersion: vi.fn(), listInstalledVersions: vi.fn(),
}))
const acct = vi.hoisted(() => ({ claude: 'on' as 'on' | 'off' | 'unreadable' }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => id !== 'claude' || acct.claude === 'on' ? null
      : acct.claude === 'off' ? { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
      : { code: 'provider-state-unknown', providerId: 'claude', message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.' },
  }),
}))

const { registerAccountWebHandlers } = await import('../../../src/main/ipc/account-web-handlers')
const { registerCliHandlers } = await import('../../../src/main/ipc/cli-handlers')
const { registerLegacyVersionHandlers } = await import('../../../src/main/ipc/legacy-version-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
registerAccountWebHandlers()
registerCliHandlers()
registerLegacyVersionHandlers(() => null)

const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'
const PROFILE = 'profile-test-a1'

beforeEach(() => {
  acct.claude = 'on'
  readClaudeCliAuth.mockClear()
  spawnClaudeHeadless.mockClear()
  installVersion.mockClear()
})

describe('accountWeb:status while Claude Code is off', () => {
  it('runs no `claude auth status`; the CLI half says why, and the web half still answers', async () => {
    acct.claude = 'off'
    const r = await handlers[IPC.ACCOUNT_WEB_STATUS]({}, PROFILE) as { ok: boolean; cli: Record<string, unknown>; web: Record<string, unknown> }
    expect(readClaudeCliAuth).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    expect(r.cli).toEqual({ authenticated: false, notChecked: OFF })
    expect(r.web).toMatchObject({ status: 'active' })
  })

  it('a setting that cannot be read runs nothing either, and says so', async () => {
    acct.claude = 'unreadable'
    const r = await handlers[IPC.ACCOUNT_WEB_STATUS]({}, PROFILE) as { cli: Record<string, unknown> }
    expect(readClaudeCliAuth).not.toHaveBeenCalled()
    expect(r.cli.notChecked).toBe('This app could not read whether Claude Code is on. Check Settings, Accounts.')
  })

  it('with Claude Code on, the CLI is asked as before (the control)', async () => {
    const r = await handlers[IPC.ACCOUNT_WEB_STATUS]({}, PROFILE) as { cli: Record<string, unknown> }
    expect(readClaudeCliAuth).toHaveBeenCalledTimes(1)
    expect(r.cli).toMatchObject({ authenticated: true, email: 'someone@example.com' })
  })
})

describe('cli:version while Claude Code is off', () => {
  it('runs no `claude --version`; the answer is the refusal', async () => {
    acct.claude = 'off'
    await expect(handlers[IPC.CLI_VERSION]({})).resolves.toEqual({ refused: { code: 'provider-off', providerId: 'claude', message: OFF } })
    expect(spawnClaudeHeadless).not.toHaveBeenCalled()
  })

  it('with Claude Code on, it reads the version as before (the control)', async () => {
    await expect(handlers[IPC.CLI_VERSION]({})).resolves.toBe('2.1.281')
  })
})

describe('legacyVersion:install while Claude Code is off', () => {
  it('installs nothing; the answer says why, in its own shape', async () => {
    acct.claude = 'off'
    await expect(handlers[IPC.LEGACY_INSTALL]({}, '2.0.1')).resolves.toEqual({ ok: false, error: OFF })
    expect(installVersion).not.toHaveBeenCalled()
  })

  it('with Claude Code on, it installs as before (the control)', async () => {
    await expect(handlers[IPC.LEGACY_INSTALL]({}, '2.0.1')).resolves.toEqual({ ok: true })
    expect(installVersion).toHaveBeenCalledTimes(1)
  })
})
