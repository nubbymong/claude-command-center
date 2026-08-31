// The /status ingest and the OSC sentinel both land in
// dispatchSSHStatuslineUpdate -> sanitiseSentinelPayload before anything is
// fanned out to the renderer, telemetry or the transcript binder. The payload is
// REMOTE-CONTROLLED: the host you connected to decides its contents.
//
// ADR-009 adversarial review found the sanitiser bounded exactly one field
// (sessionId) and copied the rest verbatim. Two consequences, both fixed here:
//
//  - `accountEmail` had NO validator on this path, while the setup-sentinel path
//    (parseSetupAccountSentinel, pty-manager.ts) has had a strict email +
//    length gate since item 10. Every render site reads
//    `accountEmail || sshRemoteAccount`, so where both existed the UNVALIDATED
//    one won: a hostile remote's arbitrary string beat the validated snapshot.
//  - Every other string was unbounded, on a payload that arrives once or twice
//    a second for the life of the session.
//
// These tests drive the REAL sanitiser through the exported dispatcher and
// assert on what reaches the window, so they cannot pass by mocking it away.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '/res',
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../src/main/providers/claude/telemetry', () => ({ notifyClaudeTelemetry: () => {} }))
vi.mock('../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../src/main/background-context', () => ({ isBackgroundContext: () => false }))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: () => {}, logInfo: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../src/main/providers/claude/statusline', () => ({
  deployClaudeStatuslineScript: () => {},
  healGlobalStatusline: () => {},
}))

const {
  dispatchSSHStatuslineUpdate,
  startStatuslineWatcher,
  sanitiseRemoteAccountEmail,
  REMOTE_ACCOUNT_MAX,
} = await import('../../src/main/statusline-watcher')

const sent: Array<Record<string, unknown>> = []
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (_ch: string, data: Record<string, unknown>) => { sent.push(data) } },
} as never

// Registers the window getter dispatchSSHStatuslineUpdate needs. The file watch
// it also starts is harmless here (a temp resources dir, no writers).
const stop = startStatuslineWatcher(() => fakeWin)

/** Push one payload through the real sanitiser; returns what reached the window. */
function dispatch(payload: unknown): Record<string, unknown> | undefined {
  sent.length = 0
  dispatchSSHStatuslineUpdate(JSON.stringify(payload))
  return sent[0]
}

beforeEach(() => { sent.length = 0 })

describe('sanitiseRemoteAccountEmail — the ONE validator both delivery paths use', () => {
  it('accepts a plain email and nothing else', () => {
    expect(sanitiseRemoteAccountEmail('dev@example.com')).toBe('dev@example.com')
    expect(sanitiseRemoteAccountEmail('a.b+c%d_e-f@sub.example.co.uk')).toBe('a.b+c%d_e-f@sub.example.co.uk')
  })

  it('drops non-strings, empties, over-long values and anything not email-shaped', () => {
    expect(sanitiseRemoteAccountEmail(undefined)).toBeUndefined()
    expect(sanitiseRemoteAccountEmail(42)).toBeUndefined()
    expect(sanitiseRemoteAccountEmail({ toString: () => 'a@b.co' })).toBeUndefined()
    expect(sanitiseRemoteAccountEmail('')).toBeUndefined()
    expect(sanitiseRemoteAccountEmail('not-an-email')).toBeUndefined()
    expect(sanitiseRemoteAccountEmail('<img src=x onerror=alert(1)>@evil.com')).toBeUndefined()
    expect(sanitiseRemoteAccountEmail('a@b.co[2J')).toBeUndefined()
    expect(sanitiseRemoteAccountEmail('a@b.co\nSecond line')).toBeUndefined()
    expect(sanitiseRemoteAccountEmail(`${'a'.repeat(REMOTE_ACCOUNT_MAX)}@b.co`)).toBeUndefined()
  })
})

describe('sanitiseSentinelPayload — /status ingest bounds (ADR-009)', () => {
  it('keeps a valid accountEmail', () => {
    const out = dispatch({ sessionId: 's1', accountEmail: 'dev@example.com' })
    expect(out!.accountEmail).toBe('dev@example.com')
  })

  // Mutation to prove this can fail: copy `accountEmail` through the generic
  // string branch again.
  it('DROPS an accountEmail that fails the display gate, so the validated snapshot still wins', () => {
    for (const bad of [
      'not-an-email',
      '<script>alert(1)</script>',
      'a@b.co]0;pwned',
      `${'x'.repeat(400)}@b.co`,
      { nested: true },
      12345,
    ]) {
      const out = dispatch({ sessionId: 's1', accountEmail: bad })
      expect(out).toBeDefined()
      expect('accountEmail' in out!).toBe(false)
    }
  })

  it('bounds every other free string, dropping the over-long ones', () => {
    const out = dispatch({ sessionId: 's1', model: 'Fable', modelId: 'x'.repeat(257), rateLimitCurrentResets: 'y'.repeat(256) })
    expect(out!.model).toBe('Fable')
    expect('modelId' in out!).toBe(false)          // 257 > cap
    expect(out!.rateLimitCurrentResets).toHaveLength(256) // exactly at the cap
  })

  it('caps usageBuckets and the strings inside them', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, label: 'L', group: 'weekly', percent: i }))
    const out = dispatch({ sessionId: 's1', usageBuckets: many })
    expect((out!.usageBuckets as unknown[]).length).toBe(32)

    const huge = dispatch({ sessionId: 's1', usageBuckets: [{ key: 'k', label: 'z'.repeat(5000), percent: 1 }] })
    const bucket = (huge!.usageBuckets as Array<Record<string, unknown>>)[0]
    expect('label' in bucket).toBe(false)
    expect(bucket.key).toBe('k')
    expect(bucket.percent).toBe(1)

    // A non-array usageBuckets is omitted entirely rather than passed through.
    const bad = dispatch({ sessionId: 's1', usageBuckets: { not: 'an array' } })
    expect('usageBuckets' in bad!).toBe(false)
    // Non-object entries inside the array are dropped.
    const mixed = dispatch({ sessionId: 's1', usageBuckets: ['a', 3, null, { key: 'ok' }] })
    expect(mixed!.usageBuckets).toEqual([{ key: 'ok' }])
  })

  it('still rejects a payload with no usable sessionId, and an over-long one', () => {
    expect(dispatch({ model: 'Fable' })).toBeUndefined()
    expect(dispatch({ sessionId: '', model: 'Fable' })).toBeUndefined()
    expect(dispatch({ sessionId: 'x'.repeat(257) })).toBeUndefined()
    expect(dispatch(['not', 'an', 'object'])).toBeUndefined()
  })

  it('leaves normal numeric/boolean fields untouched (no reliability regression)', () => {
    const out = dispatch({
      sessionId: 's1', contextUsedPercent: 42, costUsd: 1.25, fastMode: true,
      rateLimitExtra: { enabled: true, utilization: 5 }, contextWindowSize: 200000,
    })
    expect(out).toMatchObject({
      sessionId: 's1', contextUsedPercent: 42, costUsd: 1.25, fastMode: true, contextWindowSize: 200000,
    })
    expect(out!.rateLimitExtra).toEqual({ enabled: true, utilization: 5 })
  })
})

// Keep vitest from holding the watcher's timers open.
stop()
