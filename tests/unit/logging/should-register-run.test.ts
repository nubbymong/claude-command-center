import { describe, it, expect } from 'vitest'
import { shouldRegisterRun } from '../../../src/main/logging/should-register-run'

// ---------------------------------------------------------------------------
// shouldRegisterRun — the single pure predicate that decides whether a spawn
// produces a logged RUN (supervisor runStart + transcript-binder registerRun,
// and the matching runEnd/endRun on exit).
//
// Register a run iff ALL hold:
//   - provider === 'claude'              (local Claude only; NOT codex / other)
//   - NOT shellOnly                      (plain shells + add-account /login)
//   - NOT the SSH spawn path             (no local transcript to tail)
//   - per-config loggingEnabled !== false  (DEFAULT-TRUE)
//   - global  loggingEnabled !== false     (DEFAULT-TRUE)
// ---------------------------------------------------------------------------

describe('shouldRegisterRun', () => {
  it('registers a normal local Claude session on defaults (both flags undefined)', () => {
    expect(shouldRegisterRun({ provider: 'claude' }, {})).toBe(true)
  })

  it('registers when both per-config and global logging are explicitly enabled', () => {
    expect(
      shouldRegisterRun({ provider: 'claude', loggingEnabled: true }, { loggingEnabled: true }),
    ).toBe(true)
  })

  it('does NOT register shell-only sessions', () => {
    expect(shouldRegisterRun({ provider: 'claude', shellOnly: true }, {})).toBe(false)
  })

  it('does NOT register the SSH spawn path', () => {
    expect(
      shouldRegisterRun(
        { provider: 'claude', ssh: { host: 'h', port: 22, username: 'u', remotePath: '/' } },
        {},
      ),
    ).toBe(false)
  })

  it('does NOT register the codex provider', () => {
    expect(shouldRegisterRun({ provider: 'codex' }, {})).toBe(false)
  })

  it('does NOT register a non-claude / unknown provider', () => {
    // @ts-expect-error — deliberately exercising an out-of-contract provider value
    expect(shouldRegisterRun({ provider: 'other' }, {})).toBe(false)
  })

  it('treats a missing provider as non-claude (does NOT register)', () => {
    expect(shouldRegisterRun({}, {})).toBe(false)
  })

  it('does NOT register when per-config loggingEnabled is explicitly false', () => {
    expect(shouldRegisterRun({ provider: 'claude', loggingEnabled: false }, {})).toBe(false)
  })

  it('does NOT register when global settings.loggingEnabled is explicitly false', () => {
    expect(shouldRegisterRun({ provider: 'claude' }, { loggingEnabled: false })).toBe(false)
  })

  it('registers when per-config loggingEnabled is undefined but global is enabled (default-true)', () => {
    expect(shouldRegisterRun({ provider: 'claude' }, { loggingEnabled: true })).toBe(true)
  })

  it('does NOT register an SSH codex shell-only mix (any single exclusion is enough)', () => {
    expect(
      shouldRegisterRun(
        { provider: 'codex', shellOnly: true, ssh: { host: 'h', port: 22, username: 'u', remotePath: '/' } },
        {},
      ),
    ).toBe(false)
  })
})
