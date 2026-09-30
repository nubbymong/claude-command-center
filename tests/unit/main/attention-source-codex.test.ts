// P3.10 (row 47): a Codex session's own hook events drive the attention dot and
// waiting-for-input, mapped as Claude Code's are. Codex's PermissionRequest is
// Claude's permission_prompt (raise at once); Codex has no idle notification,
// so its turn's end (Stop) arms the wait Claude Code's idle_prompt makes (about
// 60 s), raised then unless something happened; a prompt, or a tool about to
// run or just run, clears. A Claude session's events map exactly as before.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/main/ipc/channel-handlers', () => ({ pushAttention: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

import { routeAttentionEvent, codexAttentionForEvent, CODEX_IDLE_ATTENTION_MS, CODEX_OWN_PRE_WINDOW_MS, _resetAttentionSourceForTest, clearCodexIdleAttention } from '../../../src/main/attention-source'
import { onInternal } from '../../../src/main/internal-events'
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

// P3.10 round 1 (V1): Codex fires PreToolUse and PermissionRequest for one
// shell command at the same moment, both async, so they reach the gateway in
// either order (VM: 3 of 6 rounds on 0.153.4 had PreToolUse second, and 0.155.1
// raced too). Codex's PermissionRequest carries turn_id and tool_name but no
// tool_use_id; the pair is matched by those (VM payloads).
describe('Codex attention: an approval and its own PreToolUse, in either order (round 1, V1)', () => {
  beforeEach(() => _resetAttentionSourceForTest())
  const TURN = '01a0ef84-4e89-7613-a2b3-d39e98c11bb2'
  const perm = (turn = TURN, tool = 'Bash') => ({ ...ev('c', 'PermissionRequest', { turn_id: turn, tool_name: tool, tool_input: { command: 'x' } }), toolName: tool })
  const pre = (turn = TURN, tool = 'Bash') => ({ ...ev('c', 'PreToolUse', { turn_id: turn, tool_name: tool, tool_input: { command: 'x' }, tool_use_id: 'call_1' }), toolName: tool })
  const preId = (id: string) => ({ ...ev('c', 'PreToolUse', { turn_id: TURN, tool_name: 'Bash', tool_input: { command: id }, tool_use_id: id }), toolName: 'Bash' })
  const postId = (id: string) => ({ ...ev('c', 'PostToolUse', { turn_id: TURN, tool_name: 'Bash', tool_use_id: id }), toolName: 'Bash' })

  it('PreToolUse first, then the approval: the dot is up while the approval waits', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(pre(), h.opts)
    routeAttentionEvent(perm(), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true]])
  })

  it('the approval first, then its own PreToolUse: the dot stays up (it used to be cleared)', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(pre(), h.opts)
    expect(h.pushed).toEqual([['c', true]])
    // The tool then runs once approved: cleared.
    routeAttentionEvent({ ...ev('c', 'PostToolUse', { turn_id: TURN, tool_name: 'Bash' }), toolName: 'Bash' }, h.opts)
    expect(h.pushed).toEqual([['c', true], ['c', false]])
  })

  it('round 2 (R3): once its own PreToolUse is taken, only that call\'s PostToolUse ends the approval: another call of the turn clears nothing (lens B\'s parallel-call shape)', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(postId('call_0'), h.opts) // an earlier call of the turn finishing before its own starts
    routeAttentionEvent(preId('call_1'), h.opts) // its own, taken
    routeAttentionEvent(preId('call_2'), h.opts) // a call running beside it
    routeAttentionEvent(postId('call_2'), h.opts) // that call done
    expect(h.pushed).toEqual([['c', true]])
    routeAttentionEvent(postId('call_1'), h.opts) // the approved call ran
    expect(h.pushed).toEqual([['c', true], ['c', false]])
  })

  it('a PreToolUse of another turn ends the approval and clears; one of another tool in the same turn, while the approval waits, does not', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(pre('01a0ef84-ffff-7613-a2b3-d39e98c11bb2', 'Bash'), h.opts)
    expect(h.pushed).toEqual([['c', true], ['c', false]])
    _resetAttentionSourceForTest()
    const h2 = harness(new Set(['c']))
    routeAttentionEvent(perm(), h2.opts)
    routeAttentionEvent(pre(TURN, 'apply_patch'), h2.opts)
    expect(h2.pushed).toEqual([['c', true]])
  })

  it('round 2 (R3): the approval after its own PreToolUse takes nothing: the next call\'s PreToolUse clears (the model moving on after the user declined), in either arrival order of the first pair', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('call_1'), h.opts)
    routeAttentionEvent(perm(), h.opts)
    // The user declines; the model's next call of the same turn and tool.
    routeAttentionEvent(preId('call_2'), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true], ['c', false]])
    // And in the other order the approved call's own PostToolUse clears.
    _resetAttentionSourceForTest()
    const h2 = harness(new Set(['c']))
    routeAttentionEvent(perm(), h2.opts)
    routeAttentionEvent(preId('call_1'), h2.opts)
    routeAttentionEvent(postId('call_1'), h2.opts)
    expect(h2.pushed).toEqual([['c', true], ['c', false]])
  })

  it('round 2 (R3): a PostToolUse of a call that finished before the approval came clears, as any tool event does', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('call_1'), h.opts)
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(postId('call_1'), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true], ['c', false]])
  })

  it('a PreToolUse whose payload was cut down for the feed (no turn, no tool) keeps the dot: it may be the approved call', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(ev('c', 'PreToolUse', { note: 'payload too large for feed history', originalBytes: 99999 }), h.opts)
    expect(h.pushed).toEqual([['c', true]])
  })

  it('a prompt and a turn\'s end still end the approval: a later PreToolUse clears', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(perm(), h.opts)
    routeAttentionEvent(ev('c', 'UserPromptSubmit', { turn_id: TURN }), h.opts)
    routeAttentionEvent(pre(), h.opts)
    expect(h.pushed).toEqual([['c', true], ['c', false], ['c', false]])
    const h2 = harness(new Set(['c']))
    routeAttentionEvent(perm(), h2.opts)
    routeAttentionEvent(ev('c', 'Stop', { turn_id: TURN }), h2.opts)
    routeAttentionEvent(pre(), h2.opts)
    expect(h2.pushed).toEqual([['c', true], ['c', false]])
  })

  it('a Claude session is untouched: its PreToolUse after its PermissionRequest clears as before', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent({ ...ev('k', 'Notification', { notification_type: 'permission_prompt' }) }, h.opts)
    routeAttentionEvent(ev('k', 'PreToolUse', { tool_name: 'Bash' }), h.opts)
    expect(h.pushed).toEqual([['k', true], ['k', false]])
  })
})

// Round 3 (F1): an open call is the approval's own only when its PreToolUse
// came within CODEX_OWN_PRE_WINDOW_MS of the approval request (VM: a shell
// command's pair within 13 ms, an apply_patch's PreToolUse up to 2156 ms
// before; the model's next call about 7 s after). An older open call is a
// previous call's: the approval waits for its own PreToolUse.
describe('Codex attention: an approval pairs only with a PreToolUse close to it (round 3, F1)', () => {
  beforeEach(() => _resetAttentionSourceForTest())
  const TURN = '01a0ef84-4e89-7613-a2b3-d39e98c11bb2'
  const at = (e: HookEvent, ts: number): HookEvent => ({ ...e, ts })
  const perm = (ts: number, tool = 'Bash') => at({ ...ev('c', 'PermissionRequest', { turn_id: TURN, tool_name: tool }), toolName: tool }, ts)
  const preId = (id: string, ts: number, tool = 'Bash') => at({ ...ev('c', 'PreToolUse', { turn_id: TURN, tool_name: tool, tool_use_id: id }), toolName: tool }, ts)
  const postId = (id: string, ts: number, tool = 'Bash') => at({ ...ev('c', 'PostToolUse', { turn_id: TURN, tool_name: tool, tool_use_id: id }), toolName: tool }, ts)

  it('the window is 3 s', () => {
    expect(CODEX_OWN_PRE_WINDOW_MS).toBe(3000)
  })

  it('the previous call\'s PostToolUse landing after the next approval request keeps the dot up (a)', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('y', 0), h.opts)
    routeAttentionEvent(perm(7000), h.opts)
    routeAttentionEvent(postId('y', 7010), h.opts)
    routeAttentionEvent(preId('z', 7012), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true]])
    routeAttentionEvent(postId('z', 9000), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true], ['c', false]])
  })

  it('a stale open call (its PostToolUse never came) does not make the next approval its own: that approval\'s PreToolUse keeps the dot up (b)', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('y', 0), h.opts)
    routeAttentionEvent(perm(9000), h.opts)
    routeAttentionEvent(preId('z', 9004), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true]])
    routeAttentionEvent(postId('z', 12000), h.opts)
    expect(h.pushed.at(-1)).toEqual(['c', false])
  })

  it('the VM orders still pair: a shell command\'s PreToolUse 13 ms before, an apply_patch\'s 2156 ms before, and the next call clears', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('b1', 1000), h.opts)
    routeAttentionEvent(perm(1013), h.opts)
    routeAttentionEvent(preId('b2', 8000), h.opts)
    expect(h.pushed).toEqual([['c', false], ['c', true], ['c', false]])
    _resetAttentionSourceForTest()
    const h2 = harness(new Set(['c']))
    routeAttentionEvent(preId('p1', 1000, 'apply_patch'), h2.opts)
    routeAttentionEvent(perm(3156, 'apply_patch'), h2.opts)
    routeAttentionEvent(preId('p2', 10000, 'apply_patch'), h2.opts)
    expect(h2.pushed).toEqual([['c', false], ['c', true], ['c', false]])
    _resetAttentionSourceForTest()
    const h3 = harness(new Set(['c']))
    routeAttentionEvent(perm(1000), h3.opts)
    routeAttentionEvent(preId('b1', 1004), h3.opts)
    routeAttentionEvent(preId('b2', 1100), h3.opts)
    expect(h3.pushed).toEqual([['c', true]])
    routeAttentionEvent(postId('b1', 5000), h3.opts)
    expect(h3.pushed).toEqual([['c', true], ['c', false]])
  })

  it('the edge: a PreToolUse exactly 3 s before pairs, one 3001 ms before does not', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(preId('y', 0), h.opts)
    routeAttentionEvent(perm(3000), h.opts)
    routeAttentionEvent(preId('z', 3005), h.opts)
    expect(h.pushed.at(-1)).toEqual(['c', false])
    _resetAttentionSourceForTest()
    const h2 = harness(new Set(['c']))
    routeAttentionEvent(preId('y', 0), h2.opts)
    routeAttentionEvent(perm(3001), h2.opts)
    routeAttentionEvent(preId('z', 3005), h2.opts)
    expect(h2.pushed.at(-1)).toEqual(['c', true])
  })
})

// P3.10 round 1 (Q1): the 60 s mark a turn's end arms is dropped with the run
// it was for (pty-manager calls clearCodexIdleAttention from the session's
// resource cleanup: an exit, a Restart, a Switch), so a fresh run of the same
// tab is never marked for its predecessor's turn.
describe('Codex attention: the idle mark ends with its run (round 1, Q1)', () => {
  beforeEach(() => _resetAttentionSourceForTest())

  it('a Restart within the wait: the fresh session is not marked', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent(ev('c', 'Stop'), h.opts)
    // The tab restarts (same id, still a Codex session): its resources go.
    clearCodexIdleAttention('c')
    expect(h.timers[0].cleared).toBe(true)
    h.fire()
    expect(h.pushed).toEqual([])
  })

  it('and a pending approval goes with it', () => {
    const h = harness(new Set(['c']))
    routeAttentionEvent({ ...ev('c', 'PermissionRequest', { turn_id: 't1', tool_name: 'Bash' }), toolName: 'Bash' }, h.opts)
    clearCodexIdleAttention('c')
    routeAttentionEvent(ev('c', 'PreToolUse', {}), h.opts)
    expect(h.pushed).toEqual([['c', true], ['c', false]])
  })
})

// P3.10 round 1 (S5): the notification rules get from a Codex session's idle
// mark what they get from Claude Code's Notification idle_prompt.
describe('Codex attention: the idle mark feeds the notification rules (round 1, S5)', () => {
  beforeEach(() => _resetAttentionSourceForTest())

  it('the mark raises the dot and tells the rules the session waits for a prompt; a dropped or stale mark tells them nothing', () => {
    const told: string[] = []
    const off = onInternal('attention:idle-prompt', (p) => { told.push(p.sessionId) })
    try {
      const codex = new Set(['c'])
      const h = harness(codex)
      routeAttentionEvent(ev('c', 'Stop'), h.opts)
      h.fire()
      expect(h.pushed).toEqual([['c', true]])
      expect(told).toEqual(['c'])
      routeAttentionEvent(ev('c', 'Stop'), h.opts)
      routeAttentionEvent(ev('c', 'UserPromptSubmit'), h.opts)
      h.fire()
      routeAttentionEvent(ev('c', 'Stop'), h.opts)
      codex.delete('c')
      h.fire()
      expect(told).toEqual(['c'])
    } finally {
      off()
    }
  })
})
