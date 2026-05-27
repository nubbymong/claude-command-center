// tests/unit/session-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { updateSessionMeta, getSessionsForProject, getSessionsForDependentBranches, getSessionMeta, clearSessionMeta, allSessionMeta } from '../../src/main/session-registry'

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
  it('dependent-branches with a repo filter excludes other-repo sessions', () => {
    updateSessionMeta({ id: 'same', label: 'S', repo: 'a/b', branch: 'fix/api' })
    updateSessionMeta({ id: 'other', label: 'O', repo: 'x/y', branch: 'fix/api' })
    const ids = getSessionsForDependentBranches('main', 'a/b').map(m => m.id)
    expect(ids).toEqual(['same'])
  })
  it('updateSessionMeta merges, preserving earlier fields', () => {
    updateSessionMeta({ id: 'a', label: 'A', cwd: '/repo', provider: 'claude' })
    updateSessionMeta({ id: 'a', repo: 'a/b', branch: 'main' })
    const m = getSessionMeta('a')!
    expect(m.label).toBe('A'); expect(m.cwd).toBe('/repo'); expect(m.provider).toBe('claude')
    expect(m.repo).toBe('a/b'); expect(m.branch).toBe('main')
  })
})
