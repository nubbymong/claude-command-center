/**
 * The web-session question must not wait on the Claude Code CLI probe.
 *
 * `accountWeb:status` resolves the claude.ai web session AND `claude auth
 * status` together, and the CLI half shells out to a subprocess that can take
 * seconds. The sidebar's session context menu computed "Open artifacts" from
 * that combined result, so on an account whose status was not already cached the
 * item rendered DISABLED and a click did nothing at all — no window, no error,
 * and no log line, because the handler was never reached. On an account that
 * happened to be warm it worked instantly, which made it look account-specific
 * rather than timing-specific.
 *
 * `accountWeb:webStatus` answers the cheap half on its own. These tests pin that
 * it genuinely does NOT touch the CLI probe: the fake below never settles, so if
 * the handler ever awaits it again these tests hang instead of quietly passing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (e: unknown, ...args: unknown[]) => unknown> = {}

/** Resolves only if something explicitly releases it — never on its own. */
let releaseCliProbe: (() => void) | null = null
let cliProbeCalls = 0

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers[channel] = fn },
  },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:/fake/data' }))
vi.mock('../../src/main/account-web/sign-in', () => ({
  cancelSignIn: vi.fn(), clearWebSession: vi.fn(), getSignInState: vi.fn(), runSignIn: vi.fn(),
}))
vi.mock('../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn(), openArtifacts: vi.fn() }))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({
  // The subprocess, standing in for `claude auth status`. It HANGS.
  readClaudeCliAuth: vi.fn(async () => {
    cliProbeCalls++
    await new Promise<void>((resolve) => { releaseCliProbe = resolve })
    return { authenticated: true, email: 'someone@example.com' }
  }),
  claudeAuthCommand: vi.fn(() => 'claude auth login'),
}))
vi.mock('../../src/main/account-web/session-store', () => ({
  getAuthBrowser: vi.fn(() => 'chrome'),
  getAuthMethod: vi.fn(() => 'claudeai'),
  removeWebSession: vi.fn(),
  saveWebSession: vi.fn(),
  setAuthBrowser: vi.fn(),
  setAuthMethod: vi.fn(),
  viewFor: vi.fn((profileId: string) => ({ profileId, status: 'active', expiresAt: 4102444800000 })),
}))

const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')
const { IPC } = await import('../../src/shared/ipc-channels')

beforeEach(() => {
  cliProbeCalls = 0
  releaseCliProbe = null
  for (const k of Object.keys(handlers)) delete handlers[k]
  registerAccountWebHandlers()
})

const PROFILE = 'profile-msf97sgf-eb8d26'

describe('accountWeb:webStatus', () => {
  it('answers while the CLI probe is still hanging', async () => {
    const res = (await handlers[IPC.ACCOUNT_WEB_WEB_STATUS]({}, PROFILE)) as {
      ok: boolean
      web?: { status: string }
    }
    expect(res.ok).toBe(true)
    expect(res.web?.status).toBe('active')
  })

  it('never invokes the CLI probe at all', async () => {
    await handlers[IPC.ACCOUNT_WEB_WEB_STATUS]({}, PROFILE)
    // Not merely "fast" — it must not start the subprocess, or every context
    // menu would still pay for one even once the answer was already back.
    expect(cliProbeCalls).toBe(0)
  })

  it('still validates the profile id at the boundary', async () => {
    const res = (await handlers[IPC.ACCOUNT_WEB_WEB_STATUS]({}, '../escape')) as { ok: boolean }
    expect(res.ok).toBe(false)
    expect(cliProbeCalls).toBe(0)
  })

  it('is the CHEAP half of a handler whose full form does block', async () => {
    // The contrast that makes the split worth having. The combined handler is
    // still awaiting the hung probe here, so it must not have settled — this is
    // what the context menu used to be waiting on.
    let settled = false
    void (handlers[IPC.ACCOUNT_WEB_STATUS]({}, PROFILE) as Promise<unknown>).then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(cliProbeCalls).toBe(1)
    expect(settled).toBe(false)

    // And it completes normally once the subprocess does, so the split has not
    // broken the full path.
    releaseCliProbe?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(true)
  })
})
