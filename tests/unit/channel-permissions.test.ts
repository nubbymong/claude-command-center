import { describe, it, expect, beforeEach, vi } from 'vitest'

let hookCb!: (e: any) => void
const pushMock = vi.fn()
const readConfigMock = vi.fn(() => ({}))
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: any) => { hookCb = cb; return () => {} } }) }))
vi.mock('../../src/main/session-registry', () => ({ getSessionMeta: () => ({ label: 'api-server', provider: 'claude' }) }))
vi.mock('../../src/main/channel-ledger', () => ({ appendLedger: vi.fn() }))
vi.mock('../../src/main/ipc/channel-handlers', () => ({ pushPendingPermissions: (...a: any[]) => pushMock(...a) }))
vi.mock('../../src/main/config-manager', () => ({ readConfig: (...a: any[]) => readConfigMock(...a) }))

const mod = await import('../../src/main/channel-permissions')
const { startPermissionTray, getPending, dismissPermission, _resetPending } = mod as any

const notif = (sid: string, ts = 1) => ({ sessionId: sid, event: 'Notification', payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission' }, ts })
const pre = (sid: string, tool: string, input: any, ts = 1) => ({ sessionId: sid, event: 'PreToolUse', toolName: tool, payload: { tool_name: tool, tool_input: input }, ts })

describe('channel-permissions (genuine-only)', () => {
  beforeEach(() => { _resetPending(); pushMock.mockClear(); readConfigMock.mockReturnValue({}) ; startPermissionTray() })

  it('PreToolUse alone never creates a card (it only tracks)', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }))
    expect(getPending()).toHaveLength(0)
  })

  it('a permission_prompt Notification creates ONE card', () => {
    hookCb(notif('s1'))
    expect(getPending()).toHaveLength(1)
    expect(getPending()[0].sessionId).toBe('s1')
  })

  it('enriches the card from the session pending PreToolUse', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }))
    hookCb(notif('s1', 2))
    const card = getPending()[0]
    expect(card.tool).toBe('Bash')
    expect(card.payloadPreview).toBe('whoami')
  })

  it('falls back to the generic message when no pending tool', () => {
    hookCb(notif('s1'))
    expect(getPending()[0].payloadPreview).toBe('Claude needs your permission')
  })

  it('flags a destructive pending command as high-risk', () => {
    hookCb(pre('s1', 'Bash', { command: 'rm -rf /tmp/x' }))
    hookCb(notif('s1', 2))
    expect(getPending()[0].highRisk?.matched).toBe('rm -rf')
  })

  it('PostToolUse for the session auto-dismisses its card and clears tracking', () => {
    hookCb(pre('s1', 'Bash', { command: 'whoami' }))
    hookCb(notif('s1', 2))
    expect(getPending()).toHaveLength(1)
    hookCb({ sessionId: 's1', event: 'PostToolUse', toolName: 'Bash', payload: {}, ts: 3 })
    expect(getPending()).toHaveLength(0)
  })

  it('Stop for the session auto-dismisses its card', () => {
    hookCb(notif('s1'))
    hookCb({ sessionId: 's1', event: 'Stop', payload: {}, ts: 2 })
    expect(getPending()).toHaveLength(0)
  })

  it('dismissPermission removes a single card without touching others', () => {
    hookCb(notif('s1', 1)); hookCb(notif('s2', 2))
    const id = getPending()[0].requestId
    expect(dismissPermission({ requestId: id })).toEqual({ ok: true })
    expect(getPending().map((p: any) => p.sessionId)).toEqual(['s2'])
  })

  it('does NOT capture when the tray is disabled in settings', () => {
    readConfigMock.mockReturnValue({ permissionTrayEnabled: false })
    hookCb(notif('s1'))
    expect(getPending()).toHaveLength(0)
  })
})
