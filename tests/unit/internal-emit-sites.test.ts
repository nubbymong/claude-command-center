// tests/unit/internal-emit-sites.test.ts
import { describe, it, expect, vi } from 'vitest'
const emitted: any[] = []
vi.mock('../../src/main/internal-events', () => ({ emitInternal: (e: string, p: any) => emitted.push({ e, p }) }))
const { emitPrMerged, emitCiFailed, emitCodexReviewComplete, emitTokenomicsAnomaly, emitMemoryAdded } = await import('../../src/main/channel-emitters')

describe('channel-emitters', () => {
  it('each emitter forwards a well-shaped internal event', () => {
    emitPrMerged({ repo: 'a/b', number: 48, branch: 'main' })
    emitCiFailed({ sessionId: 's', prBranch: 'f', logTail: 'boom' })
    emitCodexReviewComplete({ prNumber: 1, authorSessionId: 's', findingCount: 2, findings: '...' })
    emitTokenomicsAnomaly({ sessionId: 's', sessionLabel: 'S', headroom: 5, spendDelta: 1, baseline: 0.5 })
    emitMemoryAdded({ project: 'p', projectPath: '/p', entryTitle: 't', entryBody: 'b' })
    expect(emitted.map(x => x.e)).toEqual(['pr:merged', 'ci:failed', 'codex-review:complete', 'tokenomics:anomaly', 'memory:added'])
  })
})
