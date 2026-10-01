/**
 * P3.13 (row 72; rounds 1, 2 and 3): main's one-at-a-time rule
 * (src/main/launch-one-at-a-time.ts), on its own: pure over an injected
 * saved-config reader and liveness question, nothing mocked but the logger.
 * The same rule through the real pty:spawn handler is
 * pty-spawn-one-at-a-time.test.ts (the rule) and
 * pty-spawn-one-at-a-time-rights.test.ts (who keeps the right to run).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logWarn = vi.hoisted(() => vi.fn())
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn, logError: vi.fn() }))

const {
  claimConfigLaunch, settleConfigLaunch, discardConfigLaunch, seedRestoredSessions, HELD_MAX, RESTORED_MAX,
  _claimedSessionCountForTest, _heldSessionIdsForTest, _resetConfigLaunchClaimsForTest,
} = await import('../../../src/main/launch-one-at-a-time')
type Ticket = Parameters<typeof settleConfigLaunch>[0]

const live = new Set<string>()
let configs: unknown
const reads = vi.fn()
const deps = { savedConfigs: () => { reads(); return configs }, isLive: (id: string) => live.has(id) }
/** The ticket each id was last handed (a spawn that passed the gate). */
const last = new Map<string, Ticket>()
/** The gate's answer as a refusal, or null when the spawn may go ahead (its ticket is kept in `last`). */
const ask = (id: string, req: Record<string, unknown> = { configId: 'c1' }) => {
  const c = claimConfigLaunch(id, req, deps)
  if ('refused' in c) return c.refused
  last.set(id, c.ticket)
  return null
}
/** A spawn main accepts: it passes the gate, pty-manager takes it (live), and pty:spawn settles its ticket. */
const start = (id: string, req?: Record<string, unknown>) => {
  const r = ask(id, req)
  if (r === null) { live.add(id); settleConfigLaunch(last.get(id)!) }
  return r
}
/** The renderer's partner shell of a session: shell-only, <session>-partner, the config's id. */
const partnerReq = (over: Record<string, unknown> = {}) => ({ configId: 'c1', shellOnly: true, ...over })
const askPartner = (base: string, over: Record<string, unknown> = {}) => ask(`${base}-partner`, partnerReq(over))
const startPartner = (base: string, over: Record<string, unknown> = {}) => start(`${base}-partner`, partnerReq(over))
const off = () => { configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }] }
const multi = () => { configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }] }

beforeEach(() => {
  live.clear(); last.clear(); reads.mockClear(); logWarn.mockClear()
  _resetConfigLaunchClaimsForTest()
  configs = [{ id: 'c1', label: 'App Dev' }, { id: 'c2', label: 'Other', allowMultiSpawn: true }]
})

describe('claimConfigLaunch', () => {
  it('goes ahead for the first copy and refuses the second, naming the config', () => {
    expect(start('s1')).toBeNull()
    expect(ask('s2')).toEqual({
      code: 'already-running',
      providerId: 'claude',
      message: "App Dev is already running. It isn't a Multi Spawn config, so it runs one at a time. Close the other copy, or turn on Allow Multi Spawn for it.",
    })
  })

  it('names the provider the session would have run', () => {
    start('s1')
    expect(ask('s2', { configId: 'c1', provider: 'codex' })?.providerId).toBe('codex')
    expect(ask('s2', { configId: 'c1', provider: 'claude' })?.providerId).toBe('claude')
  })

  it('a Multi Spawn config has no limit', () => {
    for (const id of ['a', 'b', 'c', 'd']) expect(start(id, { configId: 'c2' })).toBeNull()
  })

  it('only an explicit true is Multi Spawn: false, a string and a number are one at a time', () => {
    for (const v of [false, 'true', 1, null]) {
      live.clear(); _resetConfigLaunchClaimsForTest()
      configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: v }]
      start('s1')
      expect(ask('s2'), String(v)).not.toBeNull()
    }
  })

  it('does not read the saved configs for a spawn that names none, or for the renderer\'s partner shell', () => {
    expect(ask('s1', {})).toBeNull()
    expect(ask('s1', { configId: '' })).toBeNull()
    start('s2')
    reads.mockClear()
    expect(askPartner('s2')).toBeNull()
    expect(reads).not.toHaveBeenCalled()
  })

  it('an Ask flag is not read: a spawn that names a config is a copy of it whatever else it says', () => {
    start('s1')
    expect(ask('s2', { configId: 'c1', isAsk: true })?.code).toBe('already-running')
  })

  it('another config\'s copies do not count', () => {
    start('s1', { configId: 'c2' })
    expect(start('s2')).toBeNull()
  })

  it('what the request says about itself is not read: only the saved flag counts', () => {
    start('s1')
    expect(ask('s2', { configId: 'c1', allowMultiSpawn: true })).not.toBeNull()
  })

  it('no rule for a config main cannot find', () => {
    for (const on of [null, undefined, {}, 'junk', 7, [], [{ id: 'other' }], [null, 3, 'x']]) {
      live.clear(); _resetConfigLaunchClaimsForTest(); configs = on
      expect(start('s1'), JSON.stringify(on)).toBeNull()
      expect(start('s2'), JSON.stringify(on)).toBeNull()
    }
  })

  it('the FIRST saved config with the id decides, as every other reader of the file does', () => {
    configs = [{ id: 'c1', label: 'First', allowMultiSpawn: true }, { id: 'c1', label: 'Second' }]
    for (const id of ['a', 'b', 'c']) expect(start(id)).toBeNull()
  })

  it('a refusal is logged with ids only, never the config\'s name', () => {
    configs = [{ id: 'c1', label: 'My Secret Project' }]
    start('s1')
    ask('s2')
    expect(logWarn).toHaveBeenCalledTimes(1)
    const said = String(logWarn.mock.calls[0][0])
    expect(said).toContain('s2')
    expect(said).toContain('c1')
    expect(said).not.toContain('My Secret Project')
  })

  it('the config id in the log is made safe: no escapes, bidi controls or line breaks, and cut', () => {
    const id = 'cfg' + String.fromCharCode(27) + '[2J' + String.fromCharCode(0x202e) + String.fromCharCode(0x2028) + '[ERROR] forged' + 'z'.repeat(5000)
    configs = [{ id, label: 'x' }]
    start('s1', { configId: id })
    ask('s2', { configId: id })
    const said = String(logWarn.mock.calls[0][0])
    expect(said).not.toMatch(new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) + ']'))
    expect(said.length).toBeLessThan(300)
  })
})

describe('copies started under Multi Spawn still count once it is turned off', () => {
  it('a further copy is refused while the copies started under Multi Spawn are live', () => {
    multi()
    for (const id of ['s1', 's2', 's3']) expect(start(id)).toBeNull()
    off() // the user unticks it; the three keep running
    expect(ask('s4')).toMatchObject({ code: 'already-running' })
    // ...until they have ended.
    for (const id of ['s1', 's2', 's3']) live.delete(id)
    expect(ask('s4')).toBeNull()
  })
})

describe('who keeps the right to run', () => {
  it('a session accepted in this run restarts beside another copy, before or after its process ended', () => {
    multi()
    start('s1'); start('s2')
    off()
    expect(ask('s1')).toBeNull() // Restart / Switch / Recover: its own process is replaced
    live.delete('s1') // killed first, as a Restart does
    expect(ask('s1')).toBeNull()
    expect(ask('s3')).not.toBeNull() // a new copy is not
  })

  it('a right is for one config: the same id naming another config is a new copy of it', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }, { id: 'c3', label: 'C' }]
    start('s1', { configId: 'c1' })
    start('s2', { configId: 'c3' })
    expect(ask('s1', { configId: 'c3' })?.code).toBe('already-running') // c3 already runs in s2
  })

  it('a spawn that was only passed, never accepted, earns no right once it is not live', () => {
    expect(ask('s1')).toBeNull() // passed the gate; its account was refused, so it never ran
    expect(start('s2')).toBeNull()
    expect(ask('s1')).toMatchObject({ code: 'already-running' }) // s1 has no right: s2 runs
  })

  it('a spawn that is passed and still starting counts as a copy while it is held by pty-manager', () => {
    expect(ask('s1')).toBeNull()
    live.add('s1') // preparing: pty-manager holds it, pty:spawn has not settled it yet
    expect(ask('s2')).toMatchObject({ code: 'already-running' })
    live.delete('s1') // its preparation was cancelled
    expect(ask('s2')).toBeNull()
  })

  it('a refused spawn records nothing and earns no right', () => {
    start('s1')
    expect(ask('s2')).not.toBeNull()
    expect(_claimedSessionCountForTest()).toBe(1)
    live.delete('s1')
    start('s3')
    expect(ask('s2')).not.toBeNull()
  })

  it('a session that is later accepted as a non-copy stops counting as a copy of its config', () => {
    start('s1')
    expect(ask('s2')).not.toBeNull()
    expect(start('s1', {})).toBeNull() // s1 is replaced by a session that names no config
    expect(ask('s2')).toBeNull()
  })

  it('a live session\'s record is never re-pointed by a spawn that is refused or does not start', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    start('s1', { configId: 'c1' })
    start('s9', { configId: 'c2' })
    expect(ask('s1', { configId: 'c2' })?.code).toBe('already-running') // refused: s9 runs c2
    ask('s1', { configId: 'c3' }) // an unknown config passes the gate, then the spawn throws: never settled
    expect(ask('s5', { configId: 'c1' })?.code).toBe('already-running') // s1 is still c1's copy
    expect(ask('s6', { configId: 'c2' })?.code).toBe('already-running')
  })

  it('a spawn that starts re-points the session to the config it now runs', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    start('s1', { configId: 'c1' })
    expect(start('s1', { configId: 'c2' })).toBeNull()
    expect(ask('s5', { configId: 'c1' })).toBeNull()
    expect(ask('s6', { configId: 'c2' })?.code).toBe('already-running')
  })
})

describe('R2 (round 3): a session accepted in this run keeps its right for the run', () => {
  it('a session that ran comes back after its tab closed and another copy was accepted: a Resume, a Restart or a Switch starts', () => {
    start('a')
    live.delete('a') // the tab is closed (a remote left running, say)
    expect(start('b')).toBeNull() // a new copy: nothing else runs
    expect(ask('a')).toBeNull() // A's own right stays: its own session, not a new copy
    expect(ask('c')?.code).toBe('already-running') // a NEW id is still a new copy beside the live B
  })

  it('Multi Spawn on, A ends, B is launched, Multi Spawn off: a Restart of A starts', () => {
    multi()
    start('a'); live.delete('a')
    expect(start('b')).toBeNull()
    off()
    expect(ask('a')).toBeNull()
    expect(ask('c')?.code).toBe('already-running')
  })

  it('every ended session accepted in this run can come back; an id main never accepted is still a new copy', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5']
    for (const id of ids) { start(id); live.delete(id) }
    expect(_heldSessionIdsForTest()).toEqual(ids)
    for (const id of ids) expect(start(id), id).toBeNull()
    expect(ask('fresh')?.code).toBe('already-running')
  })

  it('a holder that is live keeps its right: copies accepted together restart beside each other after one ends', () => {
    multi()
    start('s1'); start('s2')
    off()
    live.delete('s1') // killed
    expect(ask('s1')).toBeNull()
  })

  it('a restored copy that is live (its spawn is under way) keeps its right when a new copy is accepted, even if that spawn then fails', () => {
    multi()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    expect(ask('r1')).toBeNull() // passed the gate and under way (preparing)
    live.add('r1')
    expect(start('n1')).toBeNull() // a new copy is accepted meanwhile
    live.delete('r1') // r1's spawn failed: never settled
    off()
    expect(ask('r1')).toBeNull() // its right was there when n1 was accepted, so it is still there
  })

  it('a copy that uses its own right takes no other\'s', () => {
    multi()
    start('s1'); start('s2'); start('s3')
    off()
    live.delete('s1'); live.delete('s2')
    expect(start('s1')).toBeNull() // uses its right
    expect(ask('s2')).toBeNull() // s2's is still there
  })

  it('a spawn that is not a copy changes no right', () => {
    multi()
    start('a'); live.delete('a')
    expect(start('shell', {})).toBeNull()
    expect(startPartner('shell')).toBeNull()
    expect(_heldSessionIdsForTest()).toEqual(['a'])
  })

  it('restored rights never lapse: a new copy accepted first does not take them, whatever the config says', () => {
    multi()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }, { id: 'r3', configId: 'c1' }], detachedRemotes: [{ sessionId: 'd1', configId: 'c1' }] })
    expect(start('n1')).toBeNull() // a new copy is accepted first
    expect(start('n2')).toBeNull()
    off()
    for (const id of ['r1', 'r2', 'r3', 'd1']) expect(start(id), id).toBeNull() // each restored id still starts, once
    expect(ask('n3')?.code).toBe('already-running')
  })

  it('a restored right is one-shot: its first accepted spawn consumes it, and what is left is a right of this run, which is kept for the run', () => {
    off()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    expect(start('r1')).toBeNull() // consumed
    live.delete('r1') // the tab is closed
    expect(start('n1')).toBeNull() // a new copy
    expect(ask('r1')).toBeNull() // r1's right of this run stays
  })

  it('a restored right is consumed by its first accepted spawn even when that spawn runs another config', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    expect(start('n1', { configId: 'c1' })).toBeNull() // a new copy of c1
    expect(start('r1', { configId: 'c2' })).toBeNull() // r1's first spawn runs c2: the saved right for c1 is spent
    expect(ask('r1', { configId: 'c1' })?.code).toBe('already-running') // c1 runs in n1, and r1 holds no right for it
  })

  it('a restored id keeps no right once used, so it cannot start a second copy of itself: only the ids saved at the last quit have one', () => {
    off()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    expect(start('r1')).toBeNull()
    expect(ask('r2')?.code).toBe('already-running') // not saved: a new copy beside r1
    seedRestoredSessions({ sessions: [{ id: 'r2', configId: 'c1' }] }) // a later state seeds nothing
    expect(ask('r2')?.code).toBe('already-running')
  })
})

describe('R3: tickets, one per spawn that passed the gate', () => {
  it('each pending spawn of a session keeps its own ticket: a forged spawn of the same id cannot overwrite it', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    const first = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1') // preparing
    const forged = claimConfigLaunch('s1', { configId: 'c2' }, deps) as { ticket: Ticket } // throws after the gate: never settled
    expect(forged.ticket).not.toBe(first.ticket)
    expect(ask('s2', { configId: 'c1' })?.code).toBe('already-running') // before it settles, the pending spawn still counts as c1's copy
    settleConfigLaunch(first.ticket)
    expect(ask('s2', { configId: 'c1' })?.code).toBe('already-running') // s1 is c1's copy
    expect(ask('s3', { configId: 'c2' })).toBeNull() // and not c2's
  })

  it('a forged same-id spawn naming no config does not turn the pending copy into a non-copy', () => {
    const first = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    claimConfigLaunch('s1', { configId: 'nope' }, deps) // passes (no such config), then throws
    settleConfigLaunch(first.ticket)
    expect(ask('s2')?.code).toBe('already-running')
  })

  it('a ticket settles once, and only a ticket the gate handed out settles at all', () => {
    const c = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    settleConfigLaunch({ sessionId: 's1' } as Ticket) // a look-alike
    settleConfigLaunch(Object.freeze({ sessionId: 's1' }) as Ticket)
    expect(_heldSessionIdsForTest()).toEqual([])
    settleConfigLaunch(c.ticket)
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
    live.delete('s1')
    start('s2') // a new copy
    settleConfigLaunch(c.ticket) // settled already: nothing changes
    expect(_heldSessionIdsForTest()).toEqual(['s1', 's2'])
  })

  it('the pending tickets of one session are bounded', () => {
    start('s1')
    for (let i = 0; i < 200; i++) claimConfigLaunch('s1', { configId: 'c1' }, deps)
    expect(_claimedSessionCountForTest()).toBeLessThanOrEqual(1 + 8)
  })

  it('round 3: a discarded ticket forgets that pending spawn only, once, and only a ticket the gate handed out discards', () => {
    const real = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    const forged = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    expect(_claimedSessionCountForTest()).toBe(2)
    discardConfigLaunch(forged.ticket)
    expect(_claimedSessionCountForTest()).toBe(1)
    discardConfigLaunch(forged.ticket) // twice: nothing
    discardConfigLaunch({ sessionId: 's1' } as Ticket) // a look-alike
    discardConfigLaunch(Object.freeze({ sessionId: 's1' }) as Ticket)
    expect(_claimedSessionCountForTest()).toBe(1)
    expect(ask('s2')?.code).toBe('already-running') // the real pending spawn still counts as a copy
    settleConfigLaunch(forged.ticket) // discarded: it records nothing
    expect(_heldSessionIdsForTest()).toEqual([])
    settleConfigLaunch(real.ticket)
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
  })

  it('round 3: a ticket that was settled is not undone by a discard', () => {
    const c = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    settleConfigLaunch(c.ticket)
    discardConfigLaunch(c.ticket)
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
    expect(ask('s2')?.code).toBe('already-running')
  })

  it('round 3: overflowing the pending tickets of a session refuses the NEW claim and never pushes the real one out', () => {
    const real = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    for (let i = 0; i < 7; i++) expect('ticket' in claimConfigLaunch('s1', { configId: 'c1' }, deps)).toBe(true) // 8 pending in all
    for (let i = 0; i < 20; i++) {
      const over = claimConfigLaunch('s1', { configId: 'c1' }, deps)
      expect('refused' in over, String(i)).toBe(true)
      if ('refused' in over) expect(over.refused.code).toBe('already-running')
    }
    expect(_claimedSessionCountForTest()).toBe(8)
    expect(ask('s2')?.code).toBe('already-running') // the pending spawns still count
    settleConfigLaunch(real.ticket) // the first, real one is still there to settle
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
  })

  it('round 3: a spawn that is not a copy keeps nothing pending, so forged ones cannot push out a real pending ticket', () => {
    const real = claimConfigLaunch('s1', { configId: 'c1' }, deps) as { ticket: Ticket }
    live.add('s1')
    for (let i = 0; i < 50; i++) claimConfigLaunch('s1', { configId: 'nope' }, deps) // names no saved config
    for (let i = 0; i < 50; i++) claimConfigLaunch('s1', {}, deps)
    expect(_claimedSessionCountForTest()).toBe(1)
    expect(ask('s2')?.code).toBe('already-running')
    settleConfigLaunch(real.ticket)
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
  })
})

describe('R4: the bound on the rights lets ended sessions go first', () => {
  it('past HELD_MAX the oldest go when every session is live', () => {
    multi()
    for (let i = 0; i < HELD_MAX + 5; i++) start(`s${i}`)
    expect(_heldSessionIdsForTest()).toHaveLength(HELD_MAX)
    expect(_heldSessionIdsForTest()).not.toContain('s0')
    expect(_heldSessionIdsForTest()).toContain(`s${HELD_MAX + 4}`)
  })

  it('an entry whose session has ended goes before an older one that is live, and a live one never while one has ended', () => {
    configs = [{ id: 'c1', label: 'A', allowMultiSpawn: true }, ...Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, label: 'E', allowMultiSpawn: true }))]
    for (let i = 0; i < 5; i++) start(`live${i}`, { configId: 'c1' }) // the oldest, and live
    for (let i = 0; i < 10; i++) { start(`ended${i}`, { configId: `e${i}` }); live.delete(`ended${i}`) } // each on a config of its own
    for (let i = 0; i < HELD_MAX - 15; i++) start(`more${i}`, { configId: 'c1' })
    expect(_heldSessionIdsForTest()).toHaveLength(HELD_MAX)
    for (let i = 0; i < 10; i++) {
      start(`new${i}`, { configId: 'c1' })
      expect(_heldSessionIdsForTest()).toHaveLength(HELD_MAX)
      expect(_heldSessionIdsForTest(), `ended${i}`).not.toContain(`ended${i}`) // the ended one went, oldest first
      expect(_heldSessionIdsForTest()).toContain('live0') // the oldest live one stayed
    }
    // Ten new copies took the ten ended entries; the next must take a live one.
    start('overflow', { configId: 'c1' })
    expect(_heldSessionIdsForTest()).not.toContain('live0')
  })

  it('the entry being settled is never the one that goes', () => {
    multi()
    for (let i = 0; i < HELD_MAX; i++) start(`s${i}`)
    start('newest')
    expect(_heldSessionIdsForTest()).toContain('newest')
  })

  it('what is not accepted is dropped once it is not live', () => {
    multi()
    for (let i = 0; i < 300; i++) ask(`never${i}`) // passed, never live
    ask('last')
    expect(_claimedSessionCountForTest()).toBeLessThanOrEqual(1)
  })
})

describe('the partner terminal', () => {
  it('in the renderer\'s exact shape is never a copy and never recorded, whether or not main holds its session', () => {
    start('s1')
    expect(startPartner('s1')).toBeNull()
    expect(startPartner('never-seen')).toBeNull()
    live.delete('s1')
    expect(ask('s2')).toBeNull() // only the shells are left: the config is not running
    expect(_heldSessionIdsForTest()).toEqual(['s1'])
  })

  it('is not exempt without its shape: no shell-only flag, another suffix, an ssh block, terminal options or elevation', () => {
    start('s1')
    expect(askPartner('s1', { shellOnly: false })?.code).toBe('already-running')
    expect(askPartner('s1', { shellOnly: undefined })?.code).toBe('already-running')
    expect(askPartner('s1', { ssh: { host: 'h' } })?.code).toBe('already-running')
    expect(askPartner('s1', { terminalOptions: { command: 'x', hasSecretArg: true } })?.code).toBe('already-running')
    expect(askPartner('s1', { elevated: true })?.code).toBe('already-running')
    expect(ask('s1-partnerx', { configId: 'c1', shellOnly: true })?.code).toBe('already-running')
    expect(ask('s2-PARTNER', { configId: 'c1', shellOnly: true })?.code).toBe('already-running')
  })

  it('never counts toward its config: it cannot block a copy, nor the tab it belongs to', () => {
    startPartner('s1')
    expect(start('s1')).toBeNull() // the tab the shell belongs to
    expect(ask('s2')?.code).toBe('already-running') // the tab runs; the shell alone never did
  })
})

describe('restored sessions', () => {
  it('every restored copy of a config that is not Multi Spawn starts; a new one does not', () => {
    off()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }, { id: 'r3', configId: 'c1' }] })
    for (const id of ['r1', 'r2', 'r3']) expect(start(id), id).toBeNull()
    expect(ask('n1')).toMatchObject({ code: 'already-running' })
  })

  it('the right is until the first accepted spawn, then the session\'s own (it restarts again)', () => {
    off()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }] })
    start('r1'); start('r2')
    expect(ask('r1')).toBeNull()
    live.delete('r1')
    expect(ask('r1')).toBeNull()
  })

  it('a restored copy that came back Not started keeps its right while it has not started', () => {
    off()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }] })
    start('r2')
    expect(ask('r1')).toBeNull() // r1's first start comes later, beside r2
  })

  it('the right is used up by the id\'s first accepted spawn: accepted for another config, it no longer carries the saved one', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    start('s1', { configId: 'c1' })
    expect(start('r1', { configId: 'c2' })).toBeNull() // accepted for c2: the restored c1 right is used up
    expect(ask('r1', { configId: 'c1' })?.code).toBe('already-running')
  })

  it('is each saved session\'s own, for the config it was saved with', () => {
    configs = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }]
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    start('s1', { configId: 'c2' })
    expect(ask('r1', { configId: 'c2' })?.code).toBe('already-running')
  })

  it('remotes left running are restored too, for their own config', () => {
    off()
    seedRestoredSessions({ sessions: [], detachedRemotes: [{ sessionId: 'd1', configId: 'c1' }, { sessionId: 'd2' }] })
    expect(start('d1')).toBeNull() // the reattach
    expect(ask('d2')?.code).toBe('already-running')
    expect(ask('d3')?.code).toBe('already-running')
  })

  it('only the first state of a run seeds, and an empty read does not use it up', () => {
    off()
    seedRestoredSessions(null)
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }] })
    expect(start('r1')).toBeNull() // the first load's right
    expect(ask('r2')).not.toBeNull() // the later load's is no right
  })

  it('an Ask session, an entry with no config, a bad id and a bad shape are no rights', () => {
    off()
    seedRestoredSessions({
      sessions: [{ id: 'a', configId: 'c1', kind: 'ask' }, { id: 'b' }, { id: 'bad id', configId: 'c1' }, { id: 5, configId: 'c1' }, null, 'x', { id: 'e', configId: '' }, { id: 'f', configId: 'x'.repeat(201) }],
      detachedRemotes: [null, 3, { sessionId: 'g' }],
    })
    start('s1')
    for (const id of ['a', 'b', 'bad id', 'e', 'f', 'g']) expect(ask(id)?.code, id).toBe('already-running')
  })

  it('what is seeded is bounded', () => {
    off()
    const sessions = Array.from({ length: RESTORED_MAX + 50 }, (_, i) => ({ id: `r${i}`, configId: 'c1' }))
    seedRestoredSessions({ sessions, detachedRemotes: [{ sessionId: 'extra', configId: 'c1' }] })
    start('r0') // a restored copy runs, using its own right
    expect(ask(`r${RESTORED_MAX - 1}`)).toBeNull()
    expect(ask(`r${RESTORED_MAX + 1}`)?.code).toBe('already-running')
    expect(ask('extra')?.code).toBe('already-running') // the sessions and the remotes share the one bound
  })

  it('is not a reconnect flag: a new id that says it reattaches is a new copy', () => {
    off()
    start('s1')
    expect(ask('x1', { configId: 'c1', ssh: { reconnect: true } })?.code).toBe('already-running')
  })
})

describe('the config\'s name in the refusal', () => {
  const said = (label: unknown) => {
    live.clear(); _resetConfigLaunchClaimsForTest()
    configs = [{ id: 'c1', label }]
    start('s1')
    return ask('s2')!.message
  }

  it('is the user\'s own text, trimmed', () => {
    expect(said('  App Dev  ')).toMatch(/^App Dev is already running\./)
  })

  it('is made safe to show in a terminal: controls, escape sequences and look-alike characters become spaces', () => {
    const message = said('Dev\x1b]0;pwned\x07 ' + String.fromCharCode(0x202e) + 'gnp.exe' + String.fromCharCode(0x9b) + '31m')
    expect(message).not.toMatch(new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) + ']'))
    expect(message).toContain('Dev')
  })

  it('is cut to 100 characters', () => {
    const message = said('x'.repeat(5000))
    expect(message.startsWith('x'.repeat(100) + ' is already running.')).toBe(true)
  })

  it('is "This config" when there is none', () => {
    for (const label of [undefined, '', '   ', 42, null, {}, '\x1b\x07']) expect(said(label), String(label)).toMatch(/^This config is already running\./)
  })
})
