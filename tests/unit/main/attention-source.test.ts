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
  it('raises on Notification(agent_needs_input) — a subagent escalated a decision (#274)', () => {
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'agent_needs_input' } }))).toBe(true)
  })
  it('raises on the elicitation dialogs (an MCP tool is blocking on the user)', () => {
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'elicitation_dialog' } }))).toBe(true)
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'elicitation_url_dialog' } }))).toBe(true)
  })
  it('clears on UserPromptSubmit / PreToolUse / PostToolUse', () => {
    expect(attentionForEvent(ev({ event: 'UserPromptSubmit' }))).toBe(false)
    expect(attentionForEvent(ev({ event: 'PreToolUse' }))).toBe(false)
    expect(attentionForEvent(ev({ event: 'PostToolUse' }))).toBe(false)
  })
  it('ignores other events and informational notifications', () => {
    expect(attentionForEvent(ev({ event: 'Stop' }))).toBeNull()
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'auth_success' } }))).toBeNull()
    expect(attentionForEvent(ev({ event: 'Notification', payload: { notification_type: 'agent_completed' } }))).toBeNull()
    // A Notification with no type at all must not pulse.
    expect(attentionForEvent(ev({ event: 'Notification', payload: {} }))).toBeNull()
  })
})
