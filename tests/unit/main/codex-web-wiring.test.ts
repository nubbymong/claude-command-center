/// <reference types="vite/client" />
// [host] WP2 PR 4, P4.6 second half (row 58): main's start-up wires a Codex
// account's chatgpt.com web session exactly as its guarantees need. The wiring
// lives in two small functions (account-web/codex-web-wiring.ts) that this
// test CALLS, with the modules they wire faked, so what they register is
// asserted by behaviour, not by text:
//  - the archive hook clears the web session before an archive;
//  - the account's panes close before its partition is wiped, and its record
//    is forgotten after;
//  - the codexWeb channels answer the app window, and a pane opens only for a
//    Codex session whose CURRENT launch lease is on that account (not a
//    review lease, not the lease of a launch it has switched away from);
//  - a pane closes when its session's launch lease is released or replaced.
// main/index.ts runs only in the booted app, so that it calls the two
// functions (the archive hook before the accounts service exists) is pinned
// by its text, with comments stripped first so a commented-out call fails.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

const W = vi.hoisted(() => ({
  hooks: [] as unknown[],
  closing: [] as unknown[],
  cleared: [] as unknown[],
  registered: [] as Array<{ getWindow: unknown; opts: { sessionRunsUnder: (s: string, a: string) => boolean } }>,
  closedWhere: [] as Array<(sessionId: string, accountId: string) => boolean>,
}))
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<object>()),
  onBeforeAccountArchive: (fn: unknown) => { W.hooks.push(fn) },
}))
vi.mock('../../../src/main/account-web/codex-web-session', () => ({
  prepareCodexWebArchive: function prepareCodexWebArchive() {},
  onCodexWebSessionClosing: (fn: unknown) => { W.closing.push(fn) },
  onCodexWebSessionCleared: (fn: unknown) => { W.cleared.push(fn) },
}))
vi.mock('../../../src/main/account-web/account-pane', () => ({
  closeCodexAccountPanes: function closeCodexAccountPanes() {},
  closeCodexAccountPanesWhere: (shouldClose: (s: string, a: string) => boolean) => { W.closedWhere.push(shouldClose) },
}))
vi.mock('../../../src/main/account-web/codex-web-store', () => ({
  removeCodexWebSession: function removeCodexWebSession() {},
}))
vi.mock('../../../src/main/ipc/codex-web-handlers', () => ({
  registerCodexWebHandlers: (getWindow: unknown, opts: never) => { W.registered.push({ getWindow, opts }) },
}))

const { wireCodexWebArchive, wireCodexWebSession } = await import('../../../src/main/account-web/codex-web-wiring')
const SESSION = await import('../../../src/main/account-web/codex-web-session')
const PANE = await import('../../../src/main/account-web/account-pane')
const STORE = await import('../../../src/main/account-web/codex-web-store')
const { ConsumerLeaseRegistry } = await import('../../../src/main/providers/core/consumer-leases')

const A = 'acct-0123456789abcdef'
const B = 'acct-fedcba9876543210'

beforeEach(() => {
  W.hooks.length = 0; W.closing.length = 0; W.cleared.length = 0; W.registered.length = 0; W.closedWhere.length = 0
})

function wired() {
  const leases = new ConsumerLeaseRegistry()
  const codexPty = new Set<string>()
  const getWindow = () => null
  wireCodexWebSession({ getWindow, isCodexPtySession: (sid) => codexPty.has(sid), leases: () => leases })
  expect(W.registered).toHaveLength(1)
  const runsUnder = W.registered[0].opts.sessionRunsUnder
  const launch = (sid: string, acct: string, kind: 'session' | 'review' = 'session', seq = 1) => {
    codexPty.add(sid)
    const r = leases.add(acct, 'codex', { kind, ownerId: kind === 'session' ? `${sid}:${seq}` : `review:${sid}:${seq}`, sessionId: sid })
    if (!r.ok) throw new Error(r.code)
    return r.lease
  }
  return { leases, codexPty, getWindow, runsUnder, launch }
}

describe('[host] the archive hook', () => {
  it('registers the Codex web clear as the archive hook', () => {
    wireCodexWebArchive()
    expect(W.hooks).toEqual([SESSION.prepareCodexWebArchive])
  })
})

describe('[host] the session wiring', () => {
  it('closes the panes before a wipe and forgets the record after it, and registers the channels on the app window', () => {
    const w = wired()
    expect(W.closing).toEqual([PANE.closeCodexAccountPanes])
    expect(W.cleared).toEqual([STORE.removeCodexWebSession])
    expect(W.registered[0].getWindow).toBe(w.getWindow)
  })

  it('a pane opens only for a Codex session whose current launch lease is on the account', () => {
    const w = wired()
    expect(w.runsUnder('s1', A)).toBe(false) // no lease at all
    w.launch('s1', A)
    expect(w.runsUnder('s1', A)).toBe(true)
    expect(w.runsUnder('s1', B)).toBe(false)
    // A review the session runs on another account is not "running under" it.
    w.launch('s1', B, 'review')
    expect(w.runsUnder('s1', B)).toBe(false)
    // Switch account: the new launch is the current one at once, the old
    // lease (still winding down) no longer counts.
    w.launch('s1', B, 'session', 2)
    expect(w.runsUnder('s1', A)).toBe(false)
    expect(w.runsUnder('s1', B)).toBe(true)
    // A session that is not a Codex PTY session never counts.
    w.leases.add(A, 'codex', { kind: 'session', ownerId: 'claude-1:1', sessionId: 'claude-1' })
    expect(w.runsUnder('claude-1', A)).toBe(false)
  })

  it('a lease change closes every pane whose session no longer runs under its account, and only those', () => {
    const w = wired()
    const lease = w.launch('s1', A)
    w.launch('s2', A)
    W.closedWhere.length = 0
    lease.release()
    expect(W.closedWhere.length).toBeGreaterThan(0)
    const shouldClose = W.closedWhere[W.closedWhere.length - 1]
    expect(shouldClose('s1', A)).toBe(true)
    expect(shouldClose('s2', A)).toBe(false)
    W.closedWhere.length = 0
    w.launch('s2', B, 'session', 2)
    const after = W.closedWhere[W.closedWhere.length - 1]
    expect(after('s2', A)).toBe(true)
    expect(after('s2', B)).toBe(false)
  })
})

/** The source with comments removed: a commented-out call is no call. */
function code(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('[host] main\'s start-up calls the wiring', () => {
  const SRC = code(indexSource)

  it('the archive hook before the accounts service is made', () => {
    const hook = SRC.search(/^\s*wireCodexWebArchive\(\)\s*$/m)
    const service = SRC.indexOf('initProviderAccounts({')
    expect(hook).toBeGreaterThan(0)
    expect(service).toBeGreaterThan(hook)
    expect(SRC).toMatch(/import \{[^}]*\bwireCodexWebArchive\b[^}]*\bwireCodexWebSession\b[^}]*\} from '\.\/account-web\/codex-web-wiring'/)
  })

  it('the session wiring with the app window, the PTY check and the one lease registry', () => {
    expect(SRC).toMatch(/^\s*wireCodexWebSession\(\{ getWindow, isCodexPtySession, leases: getConsumerLeases \}\)\s*$/m)
    // Nothing else registers the channels or the wipe subscribers.
    for (const direct of ['registerCodexWebHandlers(', 'onCodexWebSessionClosing(', 'onCodexWebSessionCleared(', 'onBeforeAccountArchive(']) {
      expect(SRC, direct).not.toContain(direct)
    }
  })
})
