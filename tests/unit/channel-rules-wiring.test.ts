// tests/unit/channel-rules-wiring.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
const sent: any[] = []
vi.mock('../../src/main/channel-bus', () => ({ send: vi.fn(async (r: any) => { sent.push(r); return { ok: true } }) }))
vi.mock('../../src/main/channel-rules-store', () => ({
  loadRules: () => ([{ id: 'pr-cascade', name: 'PR Cascade', enabled: true, builtin: true, fireCount: 0, cooldownMs: 0,
    when: { event: 'pr:merged', branch: 'main' }, then: { template: 'PR #{n} merged', target: 'dependent-branches' } }]),
  saveRule: vi.fn(),
}))
vi.mock('../../src/main/session-registry', () => ({
  getSessionsForDependentBranches: () => ([{ id: 'feat', label: 'F', branch: 'fix/api' }]),
  getSessionsForProject: () => ([]),
  getSessionMeta: (id: string) => ({ id, label: id }),
}))
const internal: Record<string, (p: any) => void> = {}
vi.mock('../../src/main/internal-events', () => ({ onInternal: (e: string, cb: any) => { internal[e] = cb; return () => {} } }))
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: () => () => {} }) }))
const { startRulesEngine } = await import('../../src/main/channel-rules')

describe('channel-rules wiring', () => {
  beforeEach(() => { sent.length = 0 })
  it('PR Cascade fires a send to each dependent branch on pr:merged main', () => {
    startRulesEngine()
    internal['pr:merged']({ repo: 'a/b', number: 48, branch: 'main' })
    expect(sent).toHaveLength(1)
    expect(sent[0].targetSessionId).toBe('feat')
    expect(sent[0].payload.text).toBe('PR #48 merged')
    expect(sent[0].meta.source).toBe('rule:pr-cascade')
    expect(sent[0].meta.firedBy).toBe('system')
  })
})
