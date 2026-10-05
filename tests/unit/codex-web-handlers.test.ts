// [host] WP2 PR 4, P4.6 second half (row 58): the codexWeb:* IPC channels.
//
// Every channel answers the app's own window only (the trusted-sender helper),
// takes only a registry account id (the `account` class, nothing else), and
// acts only for an account the registry knows, of the Codex provider, not
// archived and not being archived. A Codex partition (sign-in window or pane)
// is made only after that check; a refusal acts on nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (e: unknown, ...args: unknown[]) => unknown> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers[ch] = fn } },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

type Acc = { id: string; providerId: string; lifecycle: string }
const registry = { accounts: [] as Acc[], missing: false }
/** Which app sessions hold a lease on which account (the default binding). */
const holding: Record<string, string[]> = {}
vi.mock('../../src/main/provider-account-registry', () => ({
  getAccountRegistry: () => (registry.missing ? null : { current: () => ({ accounts: registry.accounts }) }),
  getConsumerLeases: () => ({ sessionsHolding: (id: string) => holding[id] ?? [] }),
}))

const acted = {
  runCodexWebSignIn: vi.fn(async (o: { accountId: string }) => ({ phase: 'done', accountId: o.accountId, session: { accountId: o.accountId, accountEmail: 'me@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' } })),
  cancelCodexWebSignIn: vi.fn(),
  clearCodexWebSession: vi.fn(async () => {}),
  getCodexWebSignInState: vi.fn(() => ({ phase: 'idle', accountId: null })),
  codexWebViewFor: vi.fn((id: string) => ({ accountId: id, status: 'none' })),
  saveCodexWebSession: vi.fn((): boolean => true),
  removeCodexWebSession: vi.fn((): boolean => true),
  discardCodexWebRun: vi.fn(),
  openCodexAccountPane: vi.fn(() => ({ ok: true })),
  closeCodexAccountPanes: vi.fn(),
  closeWebview: vi.fn(),
}
const archiving = new Set<string>()
const clearing = new Set<string>()
vi.mock('../../src/main/account-web/codex-web-session', () => ({
  runCodexWebSignIn: acted.runCodexWebSignIn,
  cancelCodexWebSignIn: acted.cancelCodexWebSignIn,
  clearCodexWebSession: acted.clearCodexWebSession,
  getCodexWebSignInState: acted.getCodexWebSignInState,
  discardCodexWebRun: acted.discardCodexWebRun,
  isCodexWebArchiving: (id: string) => archiving.has(id),
  isCodexWebClearing: (id: string) => clearing.has(id),
}))
vi.mock('../../src/main/account-web/codex-web-store', () => ({
  codexWebViewFor: acted.codexWebViewFor, saveCodexWebSession: acted.saveCodexWebSession, removeCodexWebSession: acted.removeCodexWebSession,
}))
vi.mock('../../src/main/account-web/account-pane', () => ({
  openCodexAccountPane: acted.openCodexAccountPane, closeCodexAccountPanes: acted.closeCodexAccountPanes,
}))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: acted.closeWebview }))

const { registerCodexWebHandlers, codexWebAccountRefusal } = await import('../../src/main/ipc/codex-web-handlers')
const { IPC } = await import('../../src/shared/ipc-channels')

const ACCT = 'acct-0123456789abcdef'
const CLAUDE_ACCT = 'acct-1111111111111111'
const ARCHIVED = 'acct-2222222222222222'
const BEING_ARCHIVED = 'acct-3333333333333333'
const UNKNOWN = 'acct-4444444444444444'
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }

const MAIN_FRAME = { name: 'main' }
const mainWin = { isDestroyed: () => false, webContents: { mainFrame: MAIN_FRAME } }
const TRUSTED = { sender: mainWin.webContents, senderFrame: MAIN_FRAME }

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const f of Object.values(acted)) f.mockClear()
  registry.missing = false
  registry.accounts = [
    { id: ACCT, providerId: 'codex', lifecycle: 'inactive' },
    { id: CLAUDE_ACCT, providerId: 'claude', lifecycle: 'active' },
    { id: ARCHIVED, providerId: 'codex', lifecycle: 'archived' },
    { id: BEING_ARCHIVED, providerId: 'codex', lifecycle: 'inactive' },
  ]
  archiving.clear()
  archiving.add(BEING_ARCHIVED)
  clearing.clear()
  for (const k of Object.keys(holding)) delete holding[k]
  holding[ACCT] = ['s1']
  registerCodexWebHandlers(() => mainWin as never)
})

const CHANNELS: Array<[string, (id: unknown) => unknown]> = [
  [IPC.CODEX_WEB_STATUS, (id) => id],
  [IPC.CODEX_WEB_SIGN_IN, (id) => id],
  [IPC.CODEX_WEB_CANCEL, (id) => id],
  [IPC.CODEX_WEB_SIGN_OUT, (id) => id],
  [IPC.CODEX_WEB_PANE_OPEN, (id) => ({ sessionId: 's1', accountId: id, bounds: BOUNDS })],
]
const call = (ch: string, e: unknown, arg?: unknown) => handlers[ch](e, arg) as Promise<{ ok: boolean; error?: string; [k: string]: unknown }>
const nothingActed = (label: string) => {
  for (const [name, f] of Object.entries(acted)) expect(f, `${label} reached ${name}`).not.toHaveBeenCalled()
}

describe('[host] the channels exist, separate from Claude\'s', () => {
  it('registers every codexWeb channel and none of the accountWeb ones', () => {
    for (const ch of [IPC.CODEX_WEB_STATUS, IPC.CODEX_WEB_SIGN_IN, IPC.CODEX_WEB_SIGN_IN_STATE, IPC.CODEX_WEB_CANCEL, IPC.CODEX_WEB_SIGN_OUT, IPC.CODEX_WEB_PANE_OPEN]) {
      expect(typeof handlers[ch], ch).toBe('function')
      expect(ch.startsWith('codexWeb:')).toBe(true)
    }
    expect(Object.keys(handlers).some((k) => k.startsWith('accountWeb:'))).toBe(false)
  })
})

describe('[host] a foreign sender is refused on every channel', () => {
  const foreign = [
    { sender: { mainFrame: MAIN_FRAME }, senderFrame: MAIN_FRAME },
    { sender: mainWin.webContents, senderFrame: { name: 'sub' } },
    { sender: mainWin.webContents },
    {},
  ]
  it.each([...CHANNELS, [IPC.CODEX_WEB_SIGN_IN_STATE, () => undefined] as [string, (id: unknown) => unknown]])('%s', async (ch, arg) => {
    for (const e of foreign) {
      const r = await call(ch, e, arg(ACCT))
      expect(r.ok).toBe(false)
    }
    nothingActed(ch)
    expect(acted.getCodexWebSignInState).not.toHaveBeenCalled()
  })

  it('no window at all refuses too', async () => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerCodexWebHandlers(() => null)
    expect((await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)).ok).toBe(false)
    nothingActed('no window')
  })
})

describe('[host] only a registry account id is accepted', () => {
  it.each(CHANNELS)('%s refuses every other shape before acting', async (ch, arg) => {
    for (const bad of ['profile-known1', 'acct-0123', 'ACCT-0123456789ABCDEF', `${ACCT}\n`, `../${ACCT}`, 'realm-0123456789abcdef', '', 7, null, undefined, { id: ACCT }]) {
      const r = await call(ch, TRUSTED, arg(bad))
      expect(r.ok, `${ch} ${JSON.stringify(bad)}`).toBe(false)
    }
    nothingActed(ch)
  })
})

describe('[host] the id schema holds even against the registry', () => {
  it.each(CHANNELS)('%s refuses an id off the account pattern even when the registry lists it as Codex', async (ch, arg) => {
    for (const odd of ['profile-known1', 'ACCT-0123456789ABCDEF', 'acct-0123', `${ACCT}/..`]) {
      registry.accounts = [...registry.accounts, { id: odd, providerId: 'codex', lifecycle: 'active' }]
      const r = await call(ch, TRUSTED, arg(odd))
      expect(r.ok, `${ch} ${odd}`).toBe(false)
    }
    nothingActed(ch)
  })
})

describe('[host] only a known Codex account, not archived, not being archived', () => {
  it.each(CHANNELS)('%s refuses unknown, Claude, archived and archiving accounts before acting', async (ch, arg) => {
    for (const id of [UNKNOWN, CLAUDE_ACCT, ARCHIVED, BEING_ARCHIVED]) {
      const r = await call(ch, TRUSTED, arg(id))
      expect(r.ok, `${ch} ${id}`).toBe(false)
    }
    nothingActed(ch)
  })

  it('no registry refuses everything', async () => {
    registry.missing = true
    expect(codexWebAccountRefusal(ACCT)).not.toBeNull()
    expect((await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)).ok).toBe(false)
    nothingActed('no registry')
  })

  it('the refusal names the reason', () => {
    expect(codexWebAccountRefusal(ACCT)).toBeNull()
    expect(codexWebAccountRefusal(UNKNOWN)).toMatch(/unknown/)
    expect(codexWebAccountRefusal(CLAUDE_ACCT)).toMatch(/Codex/)
    expect(codexWebAccountRefusal(ARCHIVED)).toMatch(/archived/)
    expect(codexWebAccountRefusal(BEING_ARCHIVED)).toMatch(/archived/)
  })
})

describe('[host] what each channel does for an eligible account', () => {
  it('status reads the metadata record', async () => {
    const r = await call(IPC.CODEX_WEB_STATUS, TRUSTED, ACCT)
    expect(r).toEqual({ ok: true, web: { accountId: ACCT, status: 'none' } })
  })

  it('sign-in runs for that account and saves the record on done', async () => {
    const r = await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)
    expect(r.ok).toBe(true)
    expect(acted.runCodexWebSignIn).toHaveBeenCalledWith({ accountId: ACCT })
    expect(acted.saveCodexWebSession).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCT, accountEmail: 'me@example.com' }))
  })

  it('a sign-in whose account was archived meanwhile saves nothing and clears what it made', async () => {
    acted.runCodexWebSignIn.mockImplementationOnce(async (o: { accountId: string }) => {
      registry.accounts = registry.accounts.map((a) => (a.id === o.accountId ? { ...a, lifecycle: 'archived' } : a))
      return { phase: 'done', accountId: o.accountId, session: { accountId: o.accountId, accountEmail: 'me@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' } }
    })
    const r = await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)
    expect(acted.saveCodexWebSession).not.toHaveBeenCalled()
    expect(acted.clearCodexWebSession).toHaveBeenCalledWith(ACCT)
    expect((r as any).state.phase).toBe('failed')
  })

  it('sign-in state answers the app window', async () => {
    const r = await call(IPC.CODEX_WEB_SIGN_IN_STATE, TRUSTED)
    expect(r).toEqual({ ok: true, state: { phase: 'idle', accountId: null } })
  })

  it('cancel is scoped to the account', async () => {
    expect((await call(IPC.CODEX_WEB_CANCEL, TRUSTED, ACCT)).ok).toBe(true)
    expect(acted.cancelCodexWebSignIn).toHaveBeenCalledWith(ACCT)
  })

  it('sign-out closes the panes, clears the session, then forgets the record', async () => {
    const order: string[] = []
    acted.closeCodexAccountPanes.mockImplementationOnce(() => { order.push('panes') })
    acted.clearCodexWebSession.mockImplementationOnce(async () => { order.push('clear') })
    acted.removeCodexWebSession.mockImplementationOnce(() => { order.push('record') })
    expect((await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)).ok).toBe(true)
    expect(order).toEqual(['panes', 'clear', 'record'])
  })

  it('a sign-out whose clear fails reports it and keeps the record', async () => {
    acted.clearCodexWebSession.mockImplementationOnce(async () => { throw new Error('wipe failed') })
    const r = await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/wipe failed/)
    expect(acted.removeCodexWebSession).not.toHaveBeenCalled()
  })

  it('pane open closes the ordinary view first, then opens the account view on the app window', async () => {
    const order: string[] = []
    acted.closeWebview.mockImplementationOnce(() => { order.push('ordinary') })
    acted.openCodexAccountPane.mockImplementationOnce(() => { order.push('account'); return { ok: true } })
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(true)
    expect(order).toEqual(['ordinary', 'account'])
    expect(acted.openCodexAccountPane).toHaveBeenCalledWith(mainWin, 's1', ACCT, BOUNDS)
  })

  it('pane open refuses a bad session id or bounds before acting', async () => {
    for (const bad of [
      { sessionId: 'a/../b', accountId: ACCT, bounds: BOUNDS },
      { sessionId: 's1', accountId: ACCT, bounds: { ...BOUNDS, width: 0 } },
      { sessionId: 's1', accountId: ACCT },
      { sessionId: 's1', accountId: ACCT, bounds: BOUNDS, url: 'https://evil.example/' },
    ]) {
      expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, bad)).ok, JSON.stringify(bad)).toBe(false)
    }
    nothingActed('pane open')
  })
})

describe('[host] a clear in progress bars every channel for that account', () => {
  it.each(CHANNELS)('%s refuses an account whose chatgpt.com sign-in is being cleared', async (ch, arg) => {
    clearing.add(ACCT)
    const r = await call(ch, TRUSTED, arg(ACCT))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/being cleared/)
    nothingActed(ch)
  })
})

describe('[host] a pane opens only for a session that runs under the account', () => {
  it('a session holding no lease on the account gets no view of it', async () => {
    const r = await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 'claude-session-7', accountId: ACCT, bounds: BOUNDS })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/does not run under that account/) })
    nothingActed('pane open for another session')
  })

  it('the composition root can hand in a stricter binding; a binding that throws refuses', async () => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    const seen: Array<[string, string]> = []
    registerCodexWebHandlers(() => mainWin as never, { sessionRunsUnder: (sid, acct) => { seen.push([sid, acct]); return false } })
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
    expect(seen).toEqual([['s1', ACCT]])
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerCodexWebHandlers(() => mainWin as never, { sessionRunsUnder: () => { throw new Error('lookup failed') } })
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
    nothingActed('binding')
  })
})

describe('[host] a record that is not written never reads as done or signed out', () => {
  it('a sign-in whose record cannot be written is cleared and reads failed', async () => {
    acted.saveCodexWebSession.mockImplementationOnce(() => false)
    const r = await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)
    expect((r as any).state).toMatchObject({ phase: 'failed', error: expect.stringMatching(/could not be recorded/) })
    expect(acted.clearCodexWebSession).toHaveBeenCalledWith(ACCT)
    expect(acted.discardCodexWebRun).toHaveBeenCalledWith(ACCT, expect.any(String))
  })

  it('a sign-in discarded because the account changed meanwhile marks the run failed too', async () => {
    acted.runCodexWebSignIn.mockImplementationOnce(async (o: { accountId: string }) => {
      registry.accounts = registry.accounts.map((a) => (a.id === o.accountId ? { ...a, lifecycle: 'archived' } : a))
      return { phase: 'done', accountId: o.accountId, session: { accountId: o.accountId, accountEmail: 'me@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' } }
    })
    await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)
    expect(acted.discardCodexWebRun).toHaveBeenCalledWith(ACCT, expect.stringMatching(/discarded/))
  })

  it('a sign-out whose record cannot be removed reports it', async () => {
    acted.removeCodexWebSession.mockImplementationOnce(() => false)
    const r = await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/record could not be removed/) })
  })
})
