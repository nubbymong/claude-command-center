// tests/unit/session-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { updateSessionMeta, getSessionsForProject, getSessionsForDependentBranches, clearSessionMeta, allSessionMeta } from '../../src/main/session-registry'

describe('session-registry', () => {
  beforeEach(() => allSessionMeta().forEach(m => clearSessionMeta(m.id)))
  it('groups sessions by project path prefix', () => {
    updateSessionMeta({ id: 'a', label: 'A', cwd: '/repo/app', provider: 'claude' })
    updateSessionMeta({ id: 'b', label: 'B', cwd: '/repo/app/sub', provider: 'claude' })
    updateSessionMeta({ id: 'c', label: 'C', cwd: '/other', provider: 'claude' })
    const ids = getSessionsForProject('/repo/app').map(m => m.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })
  it('dependent-branches excludes the session bound to the merged branch itself', () => {
    updateSessionMeta({ id: 'main-sess', label: 'M', cwd: '/r', branch: 'main', provider: 'claude' })
    updateSessionMeta({ id: 'feat', label: 'F', cwd: '/r', branch: 'fix/api', provider: 'claude' })
    const ids = getSessionsForDependentBranches('main').map(m => m.id)
    expect(ids).toEqual(['feat'])
  })
})
