import { describe, it, expect } from 'vitest'
import { shouldCapture } from '../../../src/main/logging/should-capture'

// ---------------------------------------------------------------------------
// shouldCapture — pure settings gate for the SQLite logging capture path.
//
// Truth table: capture iff loggingEnabled !== false (DEFAULT-TRUE) AND the
// session is not shell-only (plain shells / the add-account /login flow never
// produce a Claude transcript worth logging).
// ---------------------------------------------------------------------------

describe('shouldCapture', () => {
  it('captures a normal session when logging is explicitly enabled', () => {
    expect(shouldCapture({ shellOnly: false }, { loggingEnabled: true })).toBe(true)
  })

  it('does NOT capture when logging is explicitly disabled', () => {
    expect(shouldCapture({ shellOnly: false }, { loggingEnabled: false })).toBe(false)
  })

  it('defaults to capturing when loggingEnabled is unset (default-true)', () => {
    expect(shouldCapture({ shellOnly: false }, {})).toBe(true)
  })

  it('never captures shell-only sessions even when logging is enabled', () => {
    expect(shouldCapture({ shellOnly: true }, { loggingEnabled: true })).toBe(false)
  })

  it('never captures shell-only sessions on default settings', () => {
    expect(shouldCapture({ shellOnly: true }, {})).toBe(false)
  })

  it('treats a missing shellOnly flag as a capturable (non-shell) session', () => {
    expect(shouldCapture({}, {})).toBe(true)
  })
})
