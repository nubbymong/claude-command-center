// P3.10 round 1 (S5): the notification rules treat both assistants alike. A
// Claude session's Notification hook with notification_type idle_prompt, and a
// Codex session's 60 s idle mark (Codex has no Notification hook; the
// attention source tells the rules through 'attention:idle-prompt'), give the
// rule engine the same input. Claude Code's Notification payload carries no
// duration_ms (read from the CLI's own hook-input builder, 2.1.285:
// hook_event_name, message, title, notification_type), so that input's wait is
// 0 for both, and the built-in Attention Pulse rule (at least 120000 ms)
// matches neither: recorded as a P3.16 sweep item, not changed here.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, any>>,
  saved: [] as Array<Record<string, any>>,
  internal: {} as Record<string, (p: any) => void>,
  gwSubscribers: [] as Array<(e: any) => void>,
}))
vi.mock('../../src/main/channel-bus', () => ({ send: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../src/main/channel-rules-store', () => ({
  loadRules: () => h.rules,
  saveRule: (r: Record<string, any>) => { h.saved.push(r) },
}))
vi.mock('../../src/main/session-registry', () => ({
  getSessionsForDependentBranches: () => [],
  getSessionsForProject: () => [],
  getSessionMeta: () => undefined,
}))
vi.mock('../../src/main/internal-events', () => ({ onInternal: (e: string, cb: any) => { h.internal[e] = cb; return () => {} } }))
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: (e: any) => void) => { h.gwSubscribers.push(cb); return () => {} } }) }))

const { startRulesEngine, notificationRuleContext } = await import('../../src/main/channel-rules')
const { BUILTIN_RULES } = await vi.importActual<typeof import('../../src/main/channel-rules-store')>('../../src/main/channel-rules-store')
const pulse = BUILTIN_RULES.find((r) => r.id === 'attention-pulse')!

startRulesEngine()
const claudeIdle = () => { for (const cb of h.gwSubscribers) cb({ sessionId: 'claude-1', event: 'Notification', payload: { hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }, ts: 0 }) }
const codexIdle = () => { h.internal['attention:idle-prompt']({ sessionId: 'codex-1' }) }

describe('the notification rules and a session waiting for a prompt (P3.10 round 1, S5)', () => {
  beforeEach(() => { h.saved = []; h.rules = [] })

  it('a Claude idle_prompt and a Codex idle mark give the rule engine the same input', () => {
    expect(notificationRuleContext('idle_prompt', undefined)).toEqual({ event: 'Notification', matcher: 'idle_prompt', durationMs: 0 })
    expect(typeof h.internal['attention:idle-prompt']).toBe('function')
  })

  it('a rule on idle_prompt fires for both alike', () => {
    h.rules = [{ ...pulse, minDurationMs: undefined, when: { event: 'Notification', matcher: 'idle_prompt' }, lastFiredAt: undefined, cooldownMs: 0 }]
    claudeIdle()
    codexIdle()
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse', 'attention-pulse'])
  })

  it('the built-in Attention Pulse (at least 120000 ms) matches neither, as Claude\'s payload carries no wait (a P3.16 sweep item)', () => {
    h.rules = [{ ...pulse }]
    claudeIdle()
    codexIdle()
    expect(h.saved).toEqual([])
  })
})
