import { describe, it, expect, beforeEach, vi } from 'vitest'

const pasted: Array<{ id: string; env: string }> = []
const ledger: any[] = []
vi.mock('../../src/main/pty-manager', () => ({
  isSessionWritable: (id: string) => id !== 'dead',
  pastePty: (id: string, env: string) => { pasted.push({ id, env }); return id === 'full' ? 1 : 0 },
}))
vi.mock('../../src/main/channel-ledger', () => ({
  appendLedger: (r: any) => { ledger.push(r); return 'lid' },
}))
vi.mock('../../src/main/channel-capability', () => ({
  pickTransport: () => 'pty', formatTier2: () => '', sendTier2: vi.fn(),
}))
vi.mock('../../src/main/channel-attachments', () => ({ persistAttachment: () => '/res/conductor-channels/attachments/x.png' }))
const { send } = await import('../../src/main/channel-bus')

describe('channel-bus.send', () => {
  beforeEach(() => { pasted.length = 0; ledger.length = 0 })
  it('delivers a github-pr payload via PTY and writes a bus-fire ledger row', async () => {
    const res = await send({ targetSessionId: 's1', payload: { kind: 'github-pr', title: 't', number: 48, url: 'u' }, meta: { source: 'github', ts: '2026-05-27T00:00:00Z' } })
    expect(res.ok).toBe(true)
    expect(pasted).toHaveLength(1)
    expect(pasted[0].env).toContain('[ccc-channel:github')
    expect(ledger[0].kind).toBe('bus-fire')
    expect(ledger[0].transport).toBe('pty')
  })
  it('refuses a dead target with a distinct failure + failed ledger row', async () => {
    const res = await send({ targetSessionId: 'dead', payload: { kind: 'rule', text: 'x' }, meta: { source: 'manual', ts: 'now' } })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/not writable|disconnected/i)
    expect(ledger[0].kind).toBe('failed')
  })
  it('records bus-overflow when the paste queue is full', async () => {
    const res = await send({ targetSessionId: 'full', payload: { kind: 'rule', text: 'x' }, meta: { source: 'manual', ts: 'now' } })
    expect(res.ok).toBe(false)
    expect(ledger.some(r => r.kind === 'bus-overflow')).toBe(true)
  })
  it('rejects the reserved file-diff payload', async () => {
    const res = await send({ targetSessionId: 's1', payload: { kind: 'file-diff', path: 'a', diff: 'd' }, meta: { source: 'manual', ts: 'now' } })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/file-diff/i)
  })
})
