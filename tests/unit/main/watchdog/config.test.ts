import { describe, it, expect } from 'vitest'
import { resolveWatchdogConfig, DEFAULT_WATCHDOG_CONFIG, DEFAULT_OVERLOAD, DEFAULT_SAFEGUARD } from '../../../../src/main/watchdog/config'

describe('resolveWatchdogConfig', () => {
  it('returns exact defaults when called with nothing', () => {
    expect(resolveWatchdogConfig()).toEqual(DEFAULT_WATCHDOG_CONFIG)
    expect(resolveWatchdogConfig(undefined)).toEqual(DEFAULT_WATCHDOG_CONFIG)
  })

  it('never throws on garbage input', () => {
    expect(() => resolveWatchdogConfig(null)).not.toThrow()
    expect(() => resolveWatchdogConfig(42)).not.toThrow()
    expect(() => resolveWatchdogConfig('nope')).not.toThrow()
    expect(() => resolveWatchdogConfig([1, 2, 3])).not.toThrow()
    expect(resolveWatchdogConfig(null)).toEqual(DEFAULT_WATCHDOG_CONFIG)
    expect(resolveWatchdogConfig(42)).toEqual(DEFAULT_WATCHDOG_CONFIG)
  })

  it('merges a partial top-level block onto defaults', () => {
    const c = resolveWatchdogConfig({ maxRetries: 2 })
    expect(c.maxRetries).toBe(2)
    expect(c.marginSeconds).toBe(DEFAULT_WATCHDOG_CONFIG.marginSeconds)
    expect(c.overload).toEqual(DEFAULT_OVERLOAD)
    expect(c.safeguard).toEqual(DEFAULT_SAFEGUARD)
  })

  it('falls back per-field on bad top-level values, never poisoning the whole object', () => {
    const c = resolveWatchdogConfig({
      maxRetries: -3,
      marginSeconds: 'soon' as unknown as number,
      fallbackWaitHours: 0,
      retryMessage: '',
    })
    expect(c.maxRetries).toBe(DEFAULT_WATCHDOG_CONFIG.maxRetries)
    expect(c.marginSeconds).toBe(DEFAULT_WATCHDOG_CONFIG.marginSeconds)
    expect(c.fallbackWaitHours).toBe(DEFAULT_WATCHDOG_CONFIG.fallbackWaitHours)
    expect(c.retryMessage).toBe(DEFAULT_WATCHDOG_CONFIG.retryMessage)
  })

  it('accepts a valid marginSeconds of 0 (non-negative, not "positive")', () => {
    expect(resolveWatchdogConfig({ marginSeconds: 0 }).marginSeconds).toBe(0)
  })

  it('merges a partial overload block, falling back per-field on bad values', () => {
    const c = resolveWatchdogConfig({
      overload: {
        enabled: 'yes' as unknown as boolean,
        backoffSeconds: [1, -1, 'x'] as unknown as number[],
        steadyStateSeconds: 90,
        jitterPct: -5,
        maxTotalWaitMinutes: 0,
        retryMessage: 'go',
        patterns: [1, 2] as unknown as string[],
      },
    })
    expect(c.overload.enabled).toBe(DEFAULT_OVERLOAD.enabled)
    expect(c.overload.backoffSeconds).toEqual(DEFAULT_OVERLOAD.backoffSeconds)
    expect(c.overload.steadyStateSeconds).toBe(90)
    expect(c.overload.jitterPct).toBe(DEFAULT_OVERLOAD.jitterPct)
    expect(c.overload.maxTotalWaitMinutes).toBe(DEFAULT_OVERLOAD.maxTotalWaitMinutes)
    expect(c.overload.retryMessage).toBe('go')
    expect(c.overload.patterns).toEqual(DEFAULT_OVERLOAD.patterns)
  })

  it('accepts a fully valid overload backoffSeconds array', () => {
    const c = resolveWatchdogConfig({ overload: { backoffSeconds: [5, 10, 20] } })
    expect(c.overload.backoffSeconds).toEqual([5, 10, 20])
  })

  it('merges a partial safeguard block, falling back per-field on bad values', () => {
    const c = resolveWatchdogConfig({
      safeguard: { maxRetries: -1, retryDelaySeconds: 0, retryMessage: '', patterns: [] },
    })
    expect(c.safeguard.maxRetries).toBe(DEFAULT_SAFEGUARD.maxRetries)
    expect(c.safeguard.retryDelaySeconds).toBe(DEFAULT_SAFEGUARD.retryDelaySeconds)
    expect(c.safeguard.retryMessage).toBe(DEFAULT_SAFEGUARD.retryMessage)
    expect(c.safeguard.patterns).toEqual(DEFAULT_SAFEGUARD.patterns)
  })

  it('treats a non-object overload/safeguard block as empty (all defaults)', () => {
    const c = resolveWatchdogConfig({ overload: 'nope', safeguard: 5 } as unknown as Record<string, unknown>)
    expect(c.overload).toEqual(DEFAULT_OVERLOAD)
    expect(c.safeguard).toEqual(DEFAULT_SAFEGUARD)
  })

  // The Settings UI exposes ONE retry-message field, so the operator's message
  // must apply to every retry type — not only the rate-limit path.
  it('propagates the single top-level retryMessage to overload and safeguard', () => {
    const c = resolveWatchdogConfig({ retryMessage: 'please continue' })
    expect(c.retryMessage).toBe('please continue')
    expect(c.overload.retryMessage).toBe('please continue')
    expect(c.safeguard.retryMessage).toBe('please continue')
  })

  it('lets an explicit per-block retryMessage override the shared top-level one', () => {
    const c = resolveWatchdogConfig({
      retryMessage: 'please continue',
      overload: { retryMessage: 'retry now' },
    })
    expect(c.overload.retryMessage).toBe('retry now')
    expect(c.safeguard.retryMessage).toBe('please continue')
  })
})

// The watchdog submits a retry as writePty(`${text}\r`) (main/index.ts) — the
// same command-submit path the app's command button uses. The lone appended
// '\r' must be the ONLY submit, so the retry text must be a single clean line:
// resolveWatchdogConfig strips all C0/C1/DEL control bytes (including ESC and
// CR/LF) from every retryMessage field and caps length. This also removes any
// embedded Enter that would submit early or a stray control byte reaching the PTY.
describe('resolveWatchdogConfig — retryMessage sanitization (single-submit / control-byte defense)', () => {
  it('strips ESC/paste-terminator and CR from a hostile top-level retryMessage', () => {
    const c = resolveWatchdogConfig({ retryMessage: 'continue\x1b[201~\r!rm -rf ~\r' })
    expect(c.retryMessage).not.toContain('\x1b')
    expect(c.retryMessage).not.toContain('\r')
    expect(c.retryMessage).not.toContain('\n')
    // ESC and CR (control bytes) are stripped; the surrounding printable text
    // (including the literal "[201~" left behind once ESC is gone) survives —
    // the point is the envelope-closing control byte itself is gone.
    expect(c.retryMessage).toBe('continue[201~!rm -rf ~')
  })

  it('strips control bytes from overload.retryMessage and safeguard.retryMessage too', () => {
    const c = resolveWatchdogConfig({
      overload: { retryMessage: 'go\x1b[201~\r evil' },
      safeguard: { retryMessage: 'ok\x07\x1b bell-and-esc' },
    })
    expect(c.overload.retryMessage).not.toMatch(/[\x00-\x1F\x7F]/)
    expect(c.safeguard.retryMessage).not.toMatch(/[\x00-\x1F\x7F]/)
    expect(c.overload.retryMessage).toBe('go[201~ evil')
    expect(c.safeguard.retryMessage).toBe('ok bell-and-esc')
  })

  it('strips C1 controls, DEL, and Unicode line/paragraph/next-line separators', () => {
    // Defense-in-depth beyond C0: DEL (0x7F), the C1 range (0x80-0x9F, incl.
    // 8-bit CSI 0x9B / OSC 0x9D), and U+2028/U+2029/U+0085 must all be removed
    // so no non-C0 control reaches the PTY on any byte path.
    const c = resolveWatchdogConfig({
      retryMessage: 'go\x7f\x9b\x9dhere\u2028\u2029\u0085now',
    })
    expect(c.retryMessage).toBe('goherenow')
    expect(c.retryMessage).not.toMatch(/[\u0080-\u009F\u007F\u2028\u2029\u0085]/)
  })

  it('caps an oversized retryMessage at 200 chars', () => {
    const huge = 'a'.repeat(50_000)
    const c = resolveWatchdogConfig({ retryMessage: huge })
    expect(c.retryMessage.length).toBe(200)
    expect(c.retryMessage).toBe('a'.repeat(200))
  })

  it('falls back to the default when the input is entirely control characters', () => {
    const allControl = '\x1b\x00\x01\x07\r\n'.repeat(5)
    const c = resolveWatchdogConfig({ retryMessage: allControl })
    expect(c.retryMessage).toBe('continue')
  })
})

// #419 review: the F13-reachable numeric knobs carry hard floors and ceilings.
// A degenerate value falls back to the default rather than clamping — a config
// that far off is a mistake, and the default is the honest resolution.
describe('bounded numeric knobs (#419)', () => {
  it('rejects sub-second and absurd values back to defaults', () => {
    const c = resolveWatchdogConfig({
      maxRetries: 1e9,
      marginSeconds: 1e9,
      fallbackWaitHours: 0.0001,
      overload: {
        backoffSeconds: [0.001, 20],
        steadyStateSeconds: 1e-9,
        jitterPct: 100000,
        maxTotalWaitMinutes: 1e9,
      },
      safeguard: { maxRetries: 1e9, retryDelaySeconds: 0.001 },
    })
    expect(c.maxRetries).toBe(DEFAULT_WATCHDOG_CONFIG.maxRetries)
    expect(c.marginSeconds).toBe(DEFAULT_WATCHDOG_CONFIG.marginSeconds)
    expect(c.fallbackWaitHours).toBe(DEFAULT_WATCHDOG_CONFIG.fallbackWaitHours)
    expect(c.overload.backoffSeconds).toEqual(DEFAULT_OVERLOAD.backoffSeconds)
    expect(c.overload.steadyStateSeconds).toBe(DEFAULT_OVERLOAD.steadyStateSeconds)
    expect(c.overload.jitterPct).toBe(DEFAULT_OVERLOAD.jitterPct)
    expect(c.overload.maxTotalWaitMinutes).toBe(DEFAULT_OVERLOAD.maxTotalWaitMinutes)
    expect(c.safeguard.maxRetries).toBe(DEFAULT_SAFEGUARD.maxRetries)
    expect(c.safeguard.retryDelaySeconds).toBe(DEFAULT_SAFEGUARD.retryDelaySeconds)
  })

  it('accepts sane in-range tuning', () => {
    const c = resolveWatchdogConfig({
      maxRetries: 10,
      overload: { backoffSeconds: [15, 45], maxTotalWaitMinutes: 240 },
      safeguard: { retryDelaySeconds: 30 },
    })
    expect(c.maxRetries).toBe(10)
    expect(c.overload.backoffSeconds).toEqual([15, 45])
    expect(c.overload.maxTotalWaitMinutes).toBe(240)
    expect(c.safeguard.retryDelaySeconds).toBe(30)
  })
})
