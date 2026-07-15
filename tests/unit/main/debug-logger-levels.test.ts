import { describe, it, expect, beforeEach, vi } from 'vitest'
// The global setup mocks debug-logger; this suite tests the REAL gating logic.
vi.unmock('../../../src/main/debug-logger')
import {
  setVerboseBaseline,
  setVerboseMode,
  isVerboseMode,
  setTraceMode,
  isTraceMode,
} from '../../../src/main/debug-logger'

describe('debug-logger levels (beta verbose + perf-neutral trace)', () => {
  beforeEach(() => {
    // Reset module-global state: clear baseline, then force verbose/trace off.
    setVerboseBaseline(false)
    setVerboseMode(false)
    setTraceMode(false)
  })

  it('beta baseline enables verbose', () => {
    setVerboseBaseline(true)
    expect(isVerboseMode()).toBe(true)
  })

  it('baseline is sticky: turning debug mode off does NOT silence beta verbose', () => {
    setVerboseBaseline(true)
    setVerboseMode(false) // e.g. user toggles debugMode off
    expect(isVerboseMode()).toBe(true)
  })

  it('without baseline, verbose follows the debug toggle', () => {
    setVerboseMode(true)
    expect(isVerboseMode()).toBe(true)
    setVerboseMode(false)
    expect(isVerboseMode()).toBe(false)
  })

  it('verbose / beta baseline never enable trace (keeps hot paths perf-neutral)', () => {
    setVerboseBaseline(true)
    setVerboseMode(true)
    expect(isTraceMode()).toBe(false)
  })

  it('trace is independently opt-in and does not imply verbose', () => {
    setTraceMode(true)
    expect(isTraceMode()).toBe(true)
    expect(isVerboseMode()).toBe(false)
  })
})
