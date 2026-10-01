// P3.10 round 1 (S5): the notification rules treat both assistants alike. A
// Claude session's Notification hook with notification_type idle_prompt, and a
// Codex session's 60 s idle mark (Codex has no Notification hook; the
// attention source tells the rules through 'attention:idle-prompt'), give the
// rule engine the same input.
// P3.16 (M3): that input's duration is how long the session's turn ran: from
// its UserPromptSubmit to its Stop as the Hooks gateway received them (both
// assistants send both events). Claude Code's Notification input carries no
// duration_ms (its own hook-input builder, 2.1.285: hook_event_name, message,
// title, notification_type), and neither assistant's Stop input carries one, so
// the built-in Attention Pulse rule (at least 120000 ms) reads the gateway's
// times, for both.
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
vi.mock('../../src/main/hooks/index', () => ({
  onGateway: (bind: (gw: any) => unknown) => {
    bind({ subscribe: (cb: (e: any) => void) => { h.gwSubscribers.push(cb); return () => {} } })
    return () => {}
  },
}))

const { startRulesEngine, notificationRuleContext } = await import('../../src/main/channel-rules')
const { BUILTIN_RULES } = await vi.importActual<typeof import('../../src/main/channel-rules-store')>('../../src/main/channel-rules-store')
const pulse = BUILTIN_RULES.find((r) => r.id === 'attention-pulse')!

startRulesEngine()
const hook = (sessionId: string, event: string, ts: number, payload: Record<string, unknown> = {}) => {
  for (const cb of h.gwSubscribers) cb({ sessionId, event, payload: { hook_event_name: event, ...payload }, ts })
}
const claudeIdle = (sid = 'claude-1', ts = 0, extra: Record<string, unknown> = {}) =>
  hook(sid, 'Notification', ts, { message: 'Claude is waiting for your input', notification_type: 'idle_prompt', ...extra })
const codexIdle = (sid = 'codex-1') => { h.internal['attention:idle-prompt']({ sessionId: sid }) }
/** A turn the gateway saw: the prompt at `from` s, its Stop at `to` s. */
const turn = (sid: string, from: number, to: number) => { hook(sid, 'UserPromptSubmit', from * 1000); hook(sid, 'Stop', to * 1000) }

describe('the notification rules and a session waiting for a prompt (P3.10 round 1, S5)', () => {
  beforeEach(() => { h.saved = []; h.rules = [] })

  it('a Claude idle_prompt and a Codex idle mark give the rule engine the same input', () => {
    expect(notificationRuleContext('idle_prompt', undefined)).toEqual({ event: 'Notification', matcher: 'idle_prompt', durationMs: 0 })
    expect(notificationRuleContext('idle_prompt', 150_000)).toEqual({ event: 'Notification', matcher: 'idle_prompt', durationMs: 150_000 })
    expect(typeof h.internal['attention:idle-prompt']).toBe('function')
  })

  it('a rule on idle_prompt fires for both alike', () => {
    h.rules = [{ ...pulse, minDurationMs: undefined, when: { event: 'Notification', matcher: 'idle_prompt' }, lastFiredAt: undefined, cooldownMs: 0 }]
    claudeIdle()
    codexIdle()
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse', 'attention-pulse'])
  })
})

describe('the built-in Attention Pulse reads how long the turn ran, for both assistants (P3.16, M3)', () => {
  beforeEach(() => { h.saved = []; h.rules = [{ ...pulse }] })

  it('a Claude turn of 2.5 min, then its idle_prompt a minute later: fires', () => {
    turn('claude-long', 0, 150)
    claudeIdle('claude-long', 210_000)
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse'])
  })

  it('a Codex turn of 2.5 min, then its idle mark: fires', () => {
    turn('codex-long', 1000, 1150)
    codexIdle('codex-long')
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse'])
  })

  it('a turn of 30 s fires for neither', () => {
    turn('claude-short', 0, 30)
    claudeIdle('claude-short', 90_000)
    turn('codex-short', 0, 30)
    codexIdle('codex-short')
    expect(h.saved).toEqual([])
  })

  it('no turn seen (no prompt since the app started) fires for neither', () => {
    claudeIdle('claude-none', 60_000)
    codexIdle('codex-none')
    expect(h.saved).toEqual([])
  })

  it('each session has its own turn: a long turn in one tab is not another tab\'s', () => {
    turn('tab-a', 0, 300)
    turn('tab-b', 0, 20)
    claudeIdle('tab-b', 80_000)
    codexIdle('tab-b')
    expect(h.saved).toEqual([])
  })

  it('a new prompt starts a new turn: the earlier long one no longer counts', () => {
    turn('claude-again', 0, 300)
    turn('claude-again', 400, 410)
    claudeIdle('claude-again', 470_000)
    expect(h.saved).toEqual([])
  })

  it('a duration_ms in the notification\'s own input is not what is read', () => {
    claudeIdle('claude-said', 60_000, { duration_ms: 999_999 })
    expect(h.saved).toEqual([])
  })
})
