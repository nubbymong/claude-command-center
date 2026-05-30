import { describe, it, expect } from 'vitest'
import { attentionForEvent } from '../../../src/main/attention-source'
import type { HookEvent } from '../../../src/shared/hook-types'

const ev = (over: Partial<HookEvent>): HookEvent => ({ sessionId: 's', event: 'Stop', payload: {}, ts: 0, ...over })

describe('attentionForEvent', () => {
  it('raises on Notification(idle_prompt)', () => {
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'idle_prompt' } }))).toBe(true)
  })
  it('raises on Notification(permission_prompt) (unanswerable on-screen prompt)', () => {
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'permission_prompt' } }))).toBe(true)
  })
  it('clears on UserPromptSubmit / PreToolUse / PostToolUse', () => {
    expect(attentionForEvent(ev({ event: 'UserPromptSubmit' }))).toBe(false)
    expect(attentionForEvent(ev({ event: 'PreToolUse' }))).toBe(false)
    expect(attentionForEvent(ev({ event: 'PostToolUse' }))).toBe(false)
  })
  it('ignores other events', () => {
    expect(attentionForEvent(ev({ event: 'Stop' }))).toBeNull()
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'auth_success' } }))).toBeNull()
  })
})
