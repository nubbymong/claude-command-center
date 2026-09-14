// tests/unit/shared/ssh-tmux-persistence.test.ts
//
// #242 tier 5. isSshPersistenceFailureReason/formatPersistenceUnavailableMessage
// back the SshFlowOverlay rendering (tested separately, renderer-side, via
// typecheck + the existing renderer suite per this item's acceptance);
// resolveRunningClaudeInfo backs pty-manager's writeClaudeCmd default. All
// three are pure, so covered directly here without pty-manager's dependency
// graph.
import { describe, it, expect } from 'vitest'
import {
  isSshPersistenceFailureReason,
  formatPersistenceUnavailableMessage,
  resolveRunningClaudeInfo,
  SSH_PERSISTENCE_PROBE_NONE,
} from '../../../src/shared/ssh-tmux-persistence'

describe('isSshPersistenceFailureReason', () => {
  it('recognises probe=none', () => {
    expect(isSshPersistenceFailureReason('probe=none')).toBe(true)
  })

  it('recognises tmux-stage-fail:<reason> and tmux-push-fail:<reason>, including terminfo', () => {
    expect(isSshPersistenceFailureReason('tmux-stage-fail:terminfo')).toBe(true)
    expect(isSshPersistenceFailureReason('tmux-push-fail:terminfo')).toBe(true)
    expect(isSshPersistenceFailureReason('tmux-stage-fail:timeout')).toBe(true)
    expect(isSshPersistenceFailureReason('tmux-push-fail:aborted')).toBe(true)
  })

  it('returns false for undefined info (persistence succeeded, no reason to show)', () => {
    expect(isSshPersistenceFailureReason(undefined)).toBe(false)
  })

  it('returns false for an unrelated info string from a different stage', () => {
    // 'inner' is awaiting-claude's info value (container post-connect shell) --
    // must never be mistaken for a persistence failure.
    expect(isSshPersistenceFailureReason('inner')).toBe(false)
    expect(isSshPersistenceFailureReason('host')).toBe(false)
  })
})

describe('formatPersistenceUnavailableMessage', () => {
  it('formats the one-line message with the reason interpolated verbatim, for a non-terminfo reason', () => {
    expect(formatPersistenceUnavailableMessage('tmux-stage-fail:timeout')).toBe(
      'persistent session unavailable: tmux-stage-fail:timeout — conversation will resume via --continue on reconnect',
    )
    expect(formatPersistenceUnavailableMessage('probe=none')).toBe(
      'persistent session unavailable: probe=none — conversation will resume via --continue on reconnect',
    )
  })

  // M6 (adversarial review round 5): terminfo is the likeliest real-world hit
  // (#242's own plan) and gets plain language instead of the raw token.
  // Mutation to prove this can fail: remove the terminfo special-case --
  // both assertions below then fail, reverting to the raw-token message the
  // generic test above already covers for OTHER reasons.
  it('special-cases both tmux-stage-fail:terminfo and tmux-push-fail:terminfo with plain language, not the raw token', () => {
    const stage = formatPersistenceUnavailableMessage('tmux-stage-fail:terminfo')
    const push = formatPersistenceUnavailableMessage('tmux-push-fail:terminfo')
    expect(stage).not.toContain('tmux-stage-fail:terminfo')
    expect(push).not.toContain('tmux-push-fail:terminfo')
    expect(stage).toContain('terminfo database')
    expect(push).toContain('terminfo database')
    expect(stage).toBe(push) // same plain-language message regardless of which tier hit it
  })
})

describe('resolveRunningClaudeInfo (#242 tier 5)', () => {
  it('passes an explicit reason through verbatim regardless of tmuxInPlay', () => {
    expect(resolveRunningClaudeInfo('tmux-stage-fail:terminfo', false)).toBe('tmux-stage-fail:terminfo')
    expect(resolveRunningClaudeInfo('tmux-push-fail:timeout', true)).toBe('tmux-push-fail:timeout')
  })

  // Mutation this catches: defaulting unconditionally to probe=none
  // (dropping the `tmuxInPlay` check) would make this fail -- a successful
  // tmux wrap has nothing to report.
  it('resolves to undefined with no explicit reason when tmux IS in play', () => {
    expect(resolveRunningClaudeInfo(undefined, true)).toBeUndefined()
  })

  // Mutation this catches: returning `explicitReason` unconditionally
  // (dropping the default entirely) would make this fail -- the whole
  // point of this function is to never emit 'running-claude' with no info
  // at all when persistence is unavailable.
  it('defaults to probe=none with no explicit reason when tmux is NOT in play', () => {
    expect(resolveRunningClaudeInfo(undefined, false)).toBe(SSH_PERSISTENCE_PROBE_NONE)
  })
})
