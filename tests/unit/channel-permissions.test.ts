import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let hookCb!: (e: any) => void
const pushMock = vi.fn()
const readConfigMock = vi.fn(() => ({}))
const logInfoMock = vi.fn()
const logDebugMock = vi.fn()
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: any) => { hookCb = cb; return () => {} } }) }))
vi.mock('../../src/main/session-registry', () => ({ getSessionMeta: () => ({ label: 'api-server', provider: 'claude' }) }))
vi.mock('../../src/main/channel-ledger', () => ({ appendLedger: vi.fn() }))
vi.mock('../../src/main/ipc/channel-handlers', () => ({ pushPendingPermissions: (...a: any[]) => pushMock(...a) }))
vi.mock('../../src/main/config-manager', () => ({ readConfig: (...a: any[]) => readConfigMock(...a) }))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: any[]) => logInfoMock(...a),
  logDebug: (...a: any[]) => logDebugMock(...a),
}))

const mod = await import('../../src/main/channel-permissions')
const { startPermissionTray, getPending, dismissPermission, _resetPending } = mod as any

const notif = (sid: string, ts = 1) => ({ sessionId: sid, event: 'Notification', payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission' }, ts })
const notifWithTool = (sid: string, ts = 1) => ({ sessionId: sid, event: 'Notification', payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, ts })
const notifQueued = (sid: string, ts = 1, msg = 'Edit your queued messages') => ({ sessionId: sid, event: 'Notification', payload: { notification_type: 'permission_prompt', message: msg }, ts })
const pre = (sid: string, tool: string, input: any, tuid: string, ts = 1) => ({ sessionId: sid, event: 'PreToolUse', toolName: tool, payload: { tool_name: tool, tool_input: input, tool_use_id: tuid }, ts })
const post = (sid: string, tuid: string, ts = 1) => ({ sessionId: sid, event: 'PostToolUse', payload: { tool_use_id: tuid }, ts })
const postNamed = (sid: string, tool: string, ts = 1) => ({ sessionId: sid, event: 'PostToolUse', payload: { tool_name: tool }, ts })

// Past the grace window (GRACE_MS = 500) before a candidate becomes a real card.
const GRACE = 600

describe('channel-permissions (genuine-only, grace-deferred)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetPending(); pushMock.mockClear(); logInfoMock.mockClear(); logDebugMock.mockClear()
    readConfigMock.mockReturnValue({}); startPermissionTray()
  })
  afterEach(() => { vi.useRealTimers() })

  it('PreToolUse alone never creates a card (it only tracks)', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 't1'))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('a permission_prompt surfaces ONE card only AFTER the grace window', () => {
    hookCb(notif('s1'))
    expect(getPending()).toHaveLength(0) // deferred, not yet visible
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].sessionId).toBe('s1')
  })

  it('does NOT surface a card when the tool proceeds within the grace window (phantom prevented)', () => {
    hookCb(pre('s1', 'Glob', { query: '**/x' }, 't1'))
    hookCb(notif('s1', 2))       // candidate enriched from Glob (which never really blocks)
    hookCb(post('s1', 't1', 3))  // Glob proceeds before grace elapses
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('cancels the candidate by tool NAME when PostToolUse omits tool_use_id', () => {
    hookCb(pre('s1', 'Glob', { query: '**/x' }, 't1'))
    hookCb(notif('s1', 2))
    hookCb(postNamed('s1', 'Glob', 3)) // proceeds, no tool_use_id on the Post
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('does NOT cancel a blocked candidate when a same-named sibling proceeds id-less (ambiguous)', () => {
    // Two Bash tools in flight: t1 auto-approves, t2 is genuinely blocked.
    hookCb(pre('s1', 'Bash', { command: 'echo a' }, 't1'))
    hookCb(pre('s1', 'Bash', { command: 'rm -rf /x' }, 't2'))
    hookCb(notif('s1', 3))             // candidate enriched from the newest (blocked t2)
    hookCb(postNamed('s1', 'Bash', 4)) // t1 proceeds but carries no tool_use_id -> ambiguous
    vi.advanceTimersByTime(GRACE)
    // The genuinely-blocked Bash card must still surface, not be suppressed.
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].tool).toBe('Bash')
  })

  it('enriches the card from the blocked in-flight PreToolUse', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 't1'))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)
    const card = getPending()[0]
    expect(card.tool).toBe('Bash')
    expect(card.payloadPreview).toBe('whoami')
  })

  it('enriches WebFetch from the url', () => {
    hookCb(pre('s1', 'WebFetch', { url: 'https://example.com' }, 't1'))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()[0].tool).toBe('WebFetch')
    expect(getPending()[0].payloadPreview).toBe('https://example.com')
  })

  it('a sibling tool completing does NOT wipe the blocked tool detail (parallel calls)', () => {
    hookCb(pre('s1', 'Read', { file_path: '/a' }, 't1'))
    hookCb(pre('s1', 'Glob', { query: '**/x' }, 't2'))
    hookCb(post('s1', 't1', 3))           // Read auto-approves and completes
    hookCb(notif('s1', 4))                // Glob is the blocked one
    vi.advanceTimersByTime(GRACE)
    const card = getPending()[0]
    expect(card.tool).toBe('Glob')
    expect(card.payloadPreview).toBe('**/x')
  })

  it('falls back to the generic message when no tool is in-flight', () => {
    hookCb(notif('s1'))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()[0].payloadPreview).toBe('Claude needs your permission')
  })

  it('flags a destructive pending command as high-risk', () => {
    hookCb(pre('s1', 'Bash', { command: 'rm -rf /tmp/x' }, 't1'))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()[0].highRisk?.matched).toBe('rm -rf')
  })

  it('the matching PostToolUse AFTER surfacing auto-dismisses the card (approve path)', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 't1'))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)         // genuinely blocked -> surfaces
    expect(getPending()).toHaveLength(1)
    hookCb(post('s1', 't1', 3))           // approved in-terminal later
    expect(getPending()).toHaveLength(0)
  })

  it('a SIBLING PostToolUse does NOT dismiss the card; the matching one does', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 't1'))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)
    hookCb(pre('s1', 'Read', { file_path: '/b' }, 't2'))
    hookCb(post('s1', 't2', 3))           // sibling completes -> card stays
    expect(getPending()).toHaveLength(1)
    hookCb(post('s1', 't1', 4))           // matching -> dismiss
    expect(getPending()).toHaveLength(0)
  })

  it('Stop AFTER surfacing dismisses the session card', () => {
    hookCb(notif('s1'))
    vi.advanceTimersByTime(GRACE)
    hookCb({ sessionId: 's1', event: 'Stop', payload: {}, ts: 2 })
    expect(getPending()).toHaveLength(0)
  })

  it('Stop BEFORE the grace window cancels the candidate (no card)', () => {
    hookCb(notif('s1'))
    hookCb({ sessionId: 's1', event: 'Stop', payload: {}, ts: 2 })
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('dismissPermission removes a single card without touching others', () => {
    hookCb(notif('s1', 1)); hookCb(notif('s2', 2))
    vi.advanceTimersByTime(GRACE)
    const id = getPending()[0].requestId
    expect(dismissPermission({ requestId: id })).toEqual({ ok: true })
    expect(getPending().map((p: any) => p.sessionId)).toEqual(['s2'])
  })

  it('does NOT capture when the tray is disabled in settings', () => {
    readConfigMock.mockReturnValue({ permissionTrayEnabled: false })
    hookCb(notif('s1'))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('surfaces a genuine prompt whose message includes the tool name (conservative substring, not exact-match)', () => {
    // "Claude needs your permission to use Bash" contains "permission" -> must surface
    hookCb(notifWithTool('s1'))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].sessionId).toBe('s1')
  })

  it('does NOT surface a permission_prompt notification whose message lacks "permission" (queued-messages false positive)', () => {
    // e.g. "Edit your queued messages" has notification_type='permission_prompt' but no "permission" in message
    hookCb(notifQueued('s1'))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  it('does NOT surface a permission_prompt notification with an empty message', () => {
    hookCb(notifQueued('s1', 1, ''))
    vi.advanceTimersByTime(GRACE)
    expect(getPending()).toHaveLength(0)
  })

  // ---- Bug #2: enrichment correctness + phantom auto-dismiss + diagnostics ----

  it('B: enriches from a genuinely-pending tool, NOT an auto-approved one whose PostToolUse arrived', () => {
    // Glob auto-approves and completes (PostToolUse arrives), THEN Bash is the
    // genuinely-pending blocked tool when the notification fires.
    hookCb(pre('s1', 'Glob', { query: '**/x' }, 't1', 1))
    hookCb(post('s1', 't1', 2))               // Glob proceeded -> removed from in-flight
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 't2', 3))
    hookCb(notif('s1', 4))
    vi.advanceTimersByTime(GRACE)
    const card = getPending()[0]
    expect(card.tool).toBe('Bash')             // never the auto-approved Glob
    expect(card.payloadPreview).toBe('whoami')
  })

  it('B: shows the GENERIC message when NO tool is genuinely pending (all completed)', () => {
    // The only in-flight tool already completed before the notification fires.
    hookCb(pre('s1', 'Glob', { query: '**/x' }, 't1', 1))
    hookCb(post('s1', 't1', 2))               // Glob done -> in-flight now empty
    hookCb(notif('s1', 3))
    vi.advanceTimersByTime(GRACE)
    const card = getPending()[0]
    expect(card.tool).toBe('Permission')
    expect(card.payloadPreview).toBe('Claude needs your permission')
    expect(card.highRisk).toBeUndefined()
  })

  it('C: phantom auto-dismiss -- card enriched from U is dismissed when PostToolUse(U) arrives', () => {
    hookCb(pre('s1', 'Glob', { query: '/outside' }, 'u1', 1))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)              // surfaces enriched from u1
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].tool).toBe('Glob')
    hookCb(post('s1', 'u1', 3))               // u1 actually proceeded -> phantom
    expect(getPending()).toHaveLength(0)
  })

  it('SAFETY: a card whose tool is still pending is NEVER dismissed by a different tool PostToolUse', () => {
    hookCb(pre('s1', 'Bash', { command: 'rm -rf /x' }, 'u1', 1))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)              // surfaces enriched from u1 (still blocked)
    expect(getPending()).toHaveLength(1)
    // A DIFFERENT tool completes -- must NOT dismiss the genuinely-pending card.
    hookCb(pre('s1', 'Read', { file_path: '/b' }, 'u2', 3))
    hookCb(post('s1', 'u2', 4))
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].tool).toBe('Bash')
    // No PostToolUse(u1) ever arrives -> the real prompt stays surfaced forever.
    vi.advanceTimersByTime(10_000)
    expect(getPending()).toHaveLength(1)
  })

  it('A: notification log records session, in-flight set, and the enrichment choice', () => {
    hookCb(pre('s1', 'Read', { file_path: '/a' }, 'u1', 1))
    hookCb(pre('s1', 'Bash', { command: 'whoami' }, 'u2', 2))
    hookCb(notif('s1', 3))
    const line = logInfoMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes('enrich'))
    expect(line).toBeTruthy()
    expect(line).toContain('s1')          // session_id
    expect(line).toContain('u1')          // full in-flight set
    expect(line).toContain('u2')
    expect(line).toContain('Read')
    expect(line).toContain('Bash')
    // The chosen tool + its tool_use_id (most-recent = u2/Bash).
    expect(line).toMatch(/enrich(ed)?=Bash/)
    expect(line).toContain('u2')
  })

  it('A: a PostToolUse for the ENRICHED tool_use_id after the card shows logs a phantom note', () => {
    hookCb(pre('s1', 'Glob', { query: '/outside' }, 'u1', 1))
    hookCb(notif('s1', 2))
    vi.advanceTimersByTime(GRACE)         // surfaces enriched from u1
    logInfoMock.mockClear()
    hookCb(post('s1', 'u1', 3))           // u1 proceeded -> phantom/mislabel
    const line = logInfoMock.mock.calls.map((c) => String(c[0])).find((s) => /phantom|not actually blocked|NOT.*blocked/i.test(s))
    expect(line).toBeTruthy()
    expect(line).toContain('u1')
  })
})
