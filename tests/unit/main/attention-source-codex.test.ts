// P3.10 (row 47): a Codex session's own hook events drive the attention dot and
// waiting-for-input, mapped as Claude Code's are. Codex's PermissionRequest is
// Claude's permission_prompt (raise at once); Codex has no idle notification,
// so its turn's end (Stop) arms the wait Claude Code's idle_prompt makes (about
// 60 s), raised then unless something happened; a prompt, or a tool about to
// run or just run, clears. A Claude session's events map exactly as before.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/main/ipc/channel-handlers', () => ({ pushAttention: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

import { routeAttentionEvent, codexAttentionForEvent, CODEX_IDLE_ATTENTION_MS, _resetAttentionSourceForTest } from '../../../src/main/attention-source'
import type { HookEvent } from '../../../src/shared/hook-types'

const ev = (sessionId: string, event: string, payload: Record<string, unknown> = {}): HookEvent => ({ sessionId, event, payload, ts: 0 })

function harness(codex: Set<string>) {
  const pushed: Array<[string, boolean]> = []
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
  const opts = {
    isCodexSession: (sid: string) => codex.has(sid),
    push: (sid: string, v: boolean) => { pushed.push([sid, v]) },
    setTimer: (cb: () => void, ms: number) => { const t = { cb, ms, cleared: false }; timers.push(t); return t as unknown as ReturnType<typeof setTimeout> },
    clearTimer: (h: ReturnType<typeof setTimeout>) => { (h as unknown as { cleared: boolean }).cleared = true },
  }
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.cb() }
  return { pushed, timers, opts, fire }
}

describe('Codex attention (row 47)', () => {
  beforeEach(() => _resetAttentionSourceForTest())

  it('codexAttentionForEvent: PermissionRequest raises, Stop waits, a prompt or a tool clears, the rest is ignored', () => {
    expect(codexAttentionForEvent(ev('c', 'PermissionRequest'))).toBe(true)
    expect(codexAttentionForEvent(ev('c', 'Stop'))).toBe('idle')
    for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) expect(codexAttentionForEvent(ev('c', e)), e).toBe(false)
    for (const e of ['SessionStart', 'SessionEnd', 'Notification', 'Interrupt']) expect(codexAttentionForEvent(ev('c', e)), e).toBeNull()
  })

  it('a Codex approval request raises at once, and the tool running clears it', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'PreToolUse'), h.opts)
    routeAttentionEvent(ev('c', 'PermissionRequest'), h.opts)
    routeAttentionEvent(ev('c', 'PostToolUse'), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true], ['c', false]])
  })

  it('a Codex turn\'s end marks the session waiting after the idle wait, as Claude\'s idle_prompt does', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    expect(h.pushed).toEqual([])
    expect(h.timers.map((t) => t.ms)).toEqual([CODEX_IDLE_ATTENTION_MS])
    expect(CODEX_IDLE_ATTENTION_MS).toBe(60_000)
    h.fire()
    expect(h.pushed).toEqual([['c', true]])
  })

  it('a prompt sent within the wait drops it: no mark', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    routeAttentionEvent(ev('c', 'UserPromptSubmit'), h.opts)
    h.fire()
    expect(h.pushed).toEqual([['c', false]])
  })

  it('a second Stop restarts the wait: one mark only', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    h.fire()
    expect(h.pushed).toEqual([['c', true]])
  })

  it('a tab closed (or respawned as another kind) within the wait is not marked', () => {
    const codex = new Set(['c'])
    const h = harness(codex)
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    codex.delete('c')
    h.fire()
    expect(h.pushed).toEqual([])
  })

  it('a Claude session\'s events map exactly as before (no idle wait on its Stop; Notification raises)', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('k', 'Stop'), h.opts)
    routeAttentionEvent(ev('k', 'PermissionRequest'), h.opts)
    routeAttentionEvent(ev('k', 'Notification', { notification_type: 'idle_prompt' }), h.opts)
    routeAttentionEvent(ev('k', 'UserPromptSubmit'), h.opts)
    expect(h.timers).toEqual([])
    expect(h.pushed).toEqual([['k', true], ['k', false]])
  })

  it('a Codex session\'s Notification-shaped event (a forger\'s) is not Claude\'s mapping', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'Notification', { notification_type: 'idle_prompt' }), h.opts)
    expect(h.pushed).toEqual([])
  })
})
