/**
 * P3.13 (row 72): main's one-at-a-time rule (src/main/launch-one-at-a-time.ts),
 * on its own: pure over an injected saved-config reader and liveness
 * question, nothing mocked. The same rule through the real pty:spawn handler is
 * pty-spawn-one-at-a-time.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logWarn = vi.hoisted(() => vi.fn())
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn, logError: vi.fn() }))

const { claimConfigLaunch, _claimedSessionCountForTest, _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')

const live = new Set<string>()
let configs: unknown
const reads = vi.fn()
const deps = { savedConfigs: () => { reads(); return configs }, isLive: (id: string) => live.has(id) }
const ask = (id: string, req: Record<string, unknown> = { configId: 'c1' }) => claimConfigLaunch(id, req, deps)
/** A session that was accepted and is now held by main. */
const start = (id: string, req?: Record<string, unknown>) => { const r = ask(id, req); if (r === null) live.add(id); return r }

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

  it('does not read the saved configs for a spawn that names none, an Ask, or a partner shell', () => {
    expect(ask('s1', {})).toBeNull()
    expect(ask('s1', { configId: '' })).toBeNull()
    expect(ask('s1', { configId: 'c1', isAsk: true })).toBeNull()
    expect(ask('s1-partner', { configId: 'c1', shellOnly: true })).toBeNull()
    expect(reads).not.toHaveBeenCalled()
  })

  it('a partner terminal needs both its suffix and to be a shell', () => {
    start('s1')
    expect(ask('s2-partner', { configId: 'c1', shellOnly: true })).toBeNull()
    expect(ask('s2-partner', { configId: 'c1' })).not.toBeNull()
    expect(ask('s2-partner', { configId: 'c1', shellOnly: false })).not.toBeNull()
    expect(ask('s2', { configId: 'c1', shellOnly: true })).not.toBeNull()
  })

  it('a partner shell is never recorded: with the session gone the config is free', () => {
    start('s1')
    expect(start('s1-partner', { configId: 'c1', shellOnly: true })).toBeNull()
    live.delete('s1')
    expect(ask('s2')).toBeNull()
  })

  it('the same session id again is a Restart, not a second copy', () => {
    start('s1')
    expect(ask('s1')).toBeNull()
    expect(ask('s1', { configId: 'c1', provider: 'codex' })).toBeNull()
  })

  it('an SSH reattach is never refused and counts from then on', () => {
    start('s1')
    expect(start('s2', { configId: 'c1', ssh: { reconnect: true } })).toBeNull()
    expect(ask('s3')).not.toBeNull()
    // ...and only a real `true` is a reattach.
    expect(ask('s3', { configId: 'c1', ssh: { reconnect: false } })).not.toBeNull()
    expect(ask('s3', { configId: 'c1', ssh: {} })).not.toBeNull()
  })

  it('a refused spawn records nothing', () => {
    start('s1')
    expect(ask('s2')).not.toBeNull()
    expect(_claimedSessionCountForTest()).toBe(1)
    live.delete('s1')
    expect(ask('s2')).toBeNull()
  })

  it('another config\'s copies do not count', () => {
    start('s1', { configId: 'c2' })
    expect(start('s2')).toBeNull()
  })

  it('no rule for a config main cannot find', () => {
    for (const on of [null, undefined, {}, 'junk', 7, [], [{ id: 'other' }], [null, 3, 'x']]) {
      live.clear(); _resetConfigLaunchClaimsForTest(); configs = on
      expect(start('s1'), JSON.stringify(on)).toBeNull()
      expect(start('s2'), JSON.stringify(on)).toBeNull()
      expect(_claimedSessionCountForTest(), JSON.stringify(on)).toBe(0)
    }
  })

  it('the FIRST saved config with the id decides, as every other reader of the file does', () => {
    configs = [{ id: 'c1', label: 'First', allowMultiSpawn: true }, { id: 'c1', label: 'Second' }]
    for (const id of ['a', 'b', 'c']) expect(start(id)).toBeNull()
  })

  it('what the request says about itself is not read: only the saved flag counts', () => {
    start('s1')
    expect(ask('s2', { configId: 'c1', allowMultiSpawn: true })).not.toBeNull()
  })

  it('the claims it keeps stay bounded by the sessions held: ended sessions are dropped at the next look', () => {
    for (let i = 0; i < 500; i++) {
      const id = `s${i}`
      expect(start(id, { configId: 'c2' })).toBeNull()
      live.delete(id) // it ended
    }
    ask('last', { configId: 'c2' })
    expect(_claimedSessionCountForTest()).toBeLessThanOrEqual(2)
  })

  it('a session that was accepted but never became live (its account was refused, its spawn threw) holds nothing', () => {
    expect(ask('s1')).toBeNull() // claimed, then never live
    expect(ask('s2')).toBeNull()
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
