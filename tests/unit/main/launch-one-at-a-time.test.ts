/**
 * P3.13 (row 72; round 1): main's one-at-a-time rule
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
  claimConfigLaunch, settleConfigLaunch, seedRestoredSessions, HELD_MAX, RESTORED_MAX,
  _claimedSessionCountForTest, _resetConfigLaunchClaimsForTest,
} = await import('../../../src/main/launch-one-at-a-time')

const live = new Set<string>()
let configs: unknown
const reads = vi.fn()
const deps = { savedConfigs: () => { reads(); return configs }, isLive: (id: string) => live.has(id) }
const ask = (id: string, req: Record<string, unknown> = { configId: 'c1' }) => claimConfigLaunch(id, req, deps)
/** A spawn main accepts: it passes the gate, pty-manager takes it (live), and pty:spawn settles it. */
const start = (id: string, req?: Record<string, unknown>) => {
  const r = ask(id, req)
  if (r === null) { live.add(id); settleConfigLaunch(id) }
  return r
}
/** The renderer's partner shell of a session: shell-only, <session>-partner, the config's id. */
const partnerReq = (over: Record<string, unknown> = {}) => ({ configId: 'c1', shellOnly: true, ...over })
const askPartner = (base: string, over: Record<string, unknown> = {}) => ask(`${base}-partner`, partnerReq(over))
const startPartner = (base: string, over: Record<string, unknown> = {}) => start(`${base}-partner`, partnerReq(over))

beforeEach(() => {
  live.clear(); reads.mockClear(); logWarn.mockClear()
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
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }]
    for (const id of ['s1', 's2', 's3']) expect(start(id)).toBeNull()
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }] // the user unticks it; the three keep running
    expect(ask('s4')).toMatchObject({ code: 'already-running' })
    // ...until they have ended.
    for (const id of ['s1', 's2', 's3']) live.delete(id)
    expect(ask('s4')).toBeNull()
  })
})

describe('who keeps the right to run', () => {
  it('a session accepted in this run restarts beside another copy, before or after its process ended', () => {
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }]
    start('s1'); start('s2')
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }]
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

  it('the rights are bounded: past HELD_MAX the oldest go, and what is not accepted is dropped once it is not live', () => {
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }]
    for (let i = 0; i < HELD_MAX + 300; i++) { start(`s${i}`); live.delete(`s${i}`) }
    for (let i = 0; i < 300; i++) ask(`never${i}`) // passed, never live
    ask('last')
    expect(_claimedSessionCountForTest()).toBeLessThanOrEqual(HELD_MAX + 1)
  })

  it('the oldest session lost its right past the bound; the newest keep theirs', () => {
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }]
    for (let i = 0; i < HELD_MAX + 5; i++) start(`s${i}`)
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }]
    expect(ask(`s${HELD_MAX + 4}`)).toBeNull()
    expect(ask('s0')).not.toBeNull()
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

describe('the partner terminal', () => {
  it('in the renderer\'s exact shape, for a session main holds, is not a copy and is never recorded', () => {
    start('s1')
    expect(startPartner('s1')).toBeNull()
    live.delete('s1')
    expect(ask('s2')).toBeNull() // only the shell is left: the config is not running
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

  it('is exempt only for a session main holds, and for the same config', () => {
    start('s1')
    expect(askPartner('zz')?.code).toBe('already-running') // main never accepted zz
    configs = [{ id: 'c1', label: 'App Dev' }, { id: 'c2', label: 'Other' }]
    start('s2', { configId: 'c2' })
    expect(askPartner('s2')?.code).toBe('already-running') // names c1, but s2 runs c2
  })

  it('opens for a session whose process ended (accepted in this run) or that was restored', () => {
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: true }]
    start('s1'); start('s2')
    configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }]
    live.delete('s1')
    expect(askPartner('s1')).toBeNull()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    expect(askPartner('r1')).toBeNull()
  })
})

describe('restored sessions', () => {
  const declined = () => { configs = [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }] }

  it('every restored copy of a config that is not Multi Spawn starts; a new one does not', () => {
    declined()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }, { id: 'r3', configId: 'c1' }] })
    for (const id of ['r1', 'r2', 'r3']) expect(start(id), id).toBeNull()
    expect(ask('n1')).toMatchObject({ code: 'already-running' })
  })

  it('the right is until the first accepted spawn, then the session\'s own (it restarts again)', () => {
    declined()
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }] })
    start('r1'); start('r2')
    expect(ask('r1')).toBeNull()
    live.delete('r1')
    expect(ask('r1')).toBeNull()
  })

  it('a restored copy that came back Not started keeps its right while it has not started', () => {
    declined()
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
    declined()
    seedRestoredSessions({ sessions: [], detachedRemotes: [{ sessionId: 'd1', configId: 'c1' }, { sessionId: 'd2' }] })
    start('s1')
    expect(ask('d1')).toBeNull()
    expect(ask('d2')?.code).toBe('already-running')
  })

  it('only the first state of a run seeds, and an empty read does not use it up', () => {
    declined()
    seedRestoredSessions(null)
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }] })
    seedRestoredSessions({ sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }] })
    start('s1')
    expect(ask('r1')).toBeNull()
    expect(ask('r2')).not.toBeNull()
  })

  it('an Ask session, an entry with no config, a bad id and a bad shape are no rights', () => {
    declined()
    seedRestoredSessions({
      sessions: [{ id: 'a', configId: 'c1', kind: 'ask' }, { id: 'b' }, { id: 'bad id', configId: 'c1' }, { id: 5, configId: 'c1' }, null, 'x', { id: 'e', configId: '' }, { id: 'f', configId: 'x'.repeat(201) }],
      detachedRemotes: [null, 3, { sessionId: 'g' }],
    })
    start('s1')
    for (const id of ['a', 'b', 'bad id', 'e', 'f', 'g']) expect(ask(id)?.code, id).toBe('already-running')
  })

  it('what is seeded is bounded', () => {
    declined()
    const sessions = Array.from({ length: RESTORED_MAX + 50 }, (_, i) => ({ id: `r${i}`, configId: 'c1' }))
    seedRestoredSessions({ sessions, detachedRemotes: [{ sessionId: 'extra', configId: 'c1' }] })
    start('s1')
    expect(ask(`r${RESTORED_MAX - 1}`)).toBeNull()
    expect(ask(`r${RESTORED_MAX + 1}`)?.code).toBe('already-running')
    expect(ask('extra')?.code).toBe('already-running') // the sessions and the remotes share the one bound
  })

  it('is not a reconnect flag: a new id that says it reattaches is a new copy', () => {
    declined()
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
