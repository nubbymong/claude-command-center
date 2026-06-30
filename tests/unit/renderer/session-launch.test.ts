// tests/unit/renderer/session-launch.test.ts
import { describe, it, expect } from 'vitest'
import { shouldGateAccountChoice, formatSpawnError } from '../../../src/renderer/utils/sessionLaunch'

describe('shouldGateAccountChoice', () => {
  it('gates a Claude session with >= 2 account profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2, provider: 'claude' })).toBe(true)
  })
  it('does NOT gate a Codex session even with >= 2 profiles (BUG-1: account isolation is Claude-only)', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 3, provider: 'codex' })).toBe(false)
  })
  it('treats an unspecified provider as Claude', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 2 })).toBe(true)
  })
  it('does not gate with fewer than 2 profiles', () => {
    expect(shouldGateAccountChoice({ hasSession: true, profileCount: 1, provider: 'claude' })).toBe(false)
  })
  it('does not gate shell-only panes', () => {
    expect(shouldGateAccountChoice({ shellOnly: true, hasSession: true, profileCount: 2, provider: 'claude' })).toBe(false)
  })
  it('does not gate when there is no session record', () => {
    expect(shouldGateAccountChoice({ hasSession: false, profileCount: 2, provider: 'claude' })).toBe(false)
  })
})

describe('formatSpawnError', () => {
  it('surfaces the underlying Error message', () => {
    expect(formatSpawnError(new Error('Codex CLI not found on PATH. Install with npm i -g @openai/codex')))
      .toContain('Codex CLI not found on PATH')
  })
  it('strips the IPC invoke wrapper noise', () => {
    expect(formatSpawnError(new Error("Error invoking remote method 'pty:spawn': Error: boom"))).toBe('boom')
  })
  it('handles a non-Error value', () => {
    expect(formatSpawnError('plain failure')).toBe('plain failure')
  })
  it('falls back for a nullish error', () => {
    expect(formatSpawnError(undefined)).toBe('unknown error')
  })
})
