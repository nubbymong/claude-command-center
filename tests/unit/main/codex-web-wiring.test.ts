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
  closedReason: [] as Array<string | undefined>,
  swept: [] as Array<{ ids: string[]; hasRecord: (id: string) => boolean }>,
  accounts: [] as Array<{ id: string; providerId: string }>,
  records: new Set<string>(),
}))
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<object>()),
  onBeforeAccountArchive: (fn: unknown) => { W.hooks.push(fn) },
}))
vi.mock('../../../src/main/account-web/codex-web-session', () => ({
  prepareCodexWebArchive: function prepareCodexWebArchive() {},
  onCodexWebSessionClosing: (fn: unknown) => { W.closing.push(fn) },
  onCodexWebSessionCleared: (fn: unknown) => { W.cleared.push(fn) },
  sweepUnrecordedCodexWebSessions: async (ids: string[], hasRecord: (id: string) => boolean) => { W.swept.push({ ids, hasRecord }); return [] },
}))
vi.mock('../../../src/main/provider-account-registry', () => ({
  getAccountRegistry: () => ({ current: () => ({ accounts: W.accounts }) }),
}))
vi.mock('../../../src/main/account-web/account-pane', () => ({
  closeCodexAccountPanes: function closeCodexAccountPanes() {},
  closeCodexAccountPanesWhere: (shouldClose: (s: string, a: string) => boolean, reason?: string) => { W.closedWhere.push(shouldClose); W.closedReason.push(reason) },
}))
vi.mock('../../../src/main/account-web/codex-web-store', () => ({
  removeCodexWebSession: function removeCodexWebSession() {},
  getCodexWebSession: (id: string) => (W.records.has(id) ? { accountId: id } : undefined),
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
  W.closedReason.length = 0; W.swept.length = 0; W.accounts = []; W.records.clear()
})

function wired(opts: { ptyThrows?: () => boolean } = {}) {
  const leases = new ConsumerLeaseRegistry()
  const codexPty = new Set<string>()
  const getWindow = () => null
  const isPty = (sid: string): boolean => {
    if (opts.ptyThrows?.()) throw new Error('simulated PTY lookup failure')
    return codexPty.has(sid)
  }
  wireCodexWebSession({ getWindow, isCodexPtySession: isPty, leases: () => leases })
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
    // The renderer is told why.
    expect(W.closedReason[W.closedReason.length - 1]).toMatch(/no longer runs under/)
  })

  it('a check that throws closes the pane (fail closed)', () => {
    let throws = false
    const w = wired({ ptyThrows: () => throws })
    w.launch('s1', A)
    W.closedWhere.length = 0
    throws = true
    w.launch('s2', A)
    const shouldClose = W.closedWhere[W.closedWhere.length - 1]
    expect(shouldClose('s1', A)).toBe(true)
  })

  it('at start, sweeps the Codex accounts in the registry, with the record store as the record check', () => {
    W.accounts = [{ id: A, providerId: 'codex' }, { id: B, providerId: 'codex' }, { id: 'profile-x', providerId: 'claude' }]
    W.records.add(B)
    wired()
    expect(W.swept).toHaveLength(1)
    expect(W.swept[0].ids).toEqual([A, B])
    expect(W.swept[0].hasRecord(A)).toBe(false)
    expect(W.swept[0].hasRecord(B)).toBe(true)
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

/** The brace depth at a position: a call wrapped in a block sits one deeper
 *  than a statement beside it. */
function depthAt(src: string, at: number): number {
  let d = 0
  for (let i = 0; i < at; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') d--
  }
  return d
}

describe('[host] main\'s start-up calls the wiring', () => {
  const SRC = code(indexSource)

  it('each call is a plain statement at the top level of its block, never under a condition', () => {
    const archive = SRC.search(/^\s*wireCodexWebArchive\(\)\s*$/m)
    const session = SRC.search(/^\s*wireCodexWebSession\(\{/m)
    // The same block as a known sibling statement: the try that makes the
    // accounts service, and the app-window getter the session wiring is handed.
    const tryAfter = SRC.indexOf('try {', archive)
    const getter = SRC.indexOf('const getWindow = () => mainWindow')
    expect(archive).toBeGreaterThan(0)
    expect(session).toBeGreaterThan(getter)
    expect(depthAt(SRC, archive)).toBe(depthAt(SRC, tryAfter))
    expect(depthAt(SRC, session)).toBe(depthAt(SRC, getter))
    // Not the body of a brace-less if, else, for or while either.
    for (const at of [archive, session]) {
      const before = SRC.slice(0, at).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
      expect(before, before).not.toMatch(/^(\}\s*)?(if|else|for|while)\b/)
    }
  })

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
