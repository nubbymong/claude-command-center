import { describe, it, expect } from 'vitest'
import { groupSessionsByConfig, type LogSessionRow } from '../../../src/renderer/lib/groupSessions'

const row = (over: Partial<LogSessionRow>): LogSessionRow => ({
  sessionId: 's', configId: null, configLabel: 'L', projectCwd: null,
  accountEmail: null, profileId: null, provider: 'claude', startedAt: 1,
  endedAt: null, status: 'exited', byteSize: 0, eventCount: 0, ...over,
})

describe('groupSessionsByConfig', () => {
  it('buckets native rows under their configId, newest-first within and across groups', () => {
    const sessions = [
      row({ sessionId: 'a', configId: 'c1', configLabel: 'APP', startedAt: 100 }),
      row({ sessionId: 'b', configId: 'c1', configLabel: 'APP', startedAt: 300 }),
      row({ sessionId: 'c', configId: 'c2', configLabel: 'WEB', startedAt: 200 }),
    ]
    const live = new Map([['c1', 'APP'], ['c2', 'WEB']])
    const { groups, orphaned } = groupSessionsByConfig(sessions, new Set(live.keys()), live)
    expect(groups.map((g) => g.configId)).toEqual(['c1', 'c2'])
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['b', 'a'])
    expect(orphaned).toEqual([])
  })

  it('routes a session whose live config no longer exists to Orphaned', () => {
    const sessions = [row({ sessionId: 'x', configId: 'gone', configLabel: 'OLD' })]
    const { groups, orphaned } = groupSessionsByConfig(sessions, new Set(['c1']), new Map([['c1', 'APP']]))
    expect(groups).toEqual([])
    expect(orphaned.map((s) => s.sessionId)).toEqual(['x'])
  })

  it('tags a migrated (configId=null) row whose label matches a live config as legacy under that group', () => {
    const sessions = [
      row({ sessionId: 'native', configId: 'c1', configLabel: 'APP', startedAt: 50 }),
      row({ sessionId: 'legacy', configId: null, configLabel: 'APP', startedAt: 40 }),
    ]
    const live = new Map([['c1', 'APP']])
    const { groups, orphaned } = groupSessionsByConfig(sessions, new Set(live.keys()), live)
    expect(groups.length).toBe(1)
    const ids = groups[0].sessions.map((s) => ({ id: s.sessionId, legacy: s.legacy }))
    expect(ids).toContainEqual({ id: 'native', legacy: false })
    expect(ids).toContainEqual({ id: 'legacy', legacy: true })
    expect(orphaned).toEqual([])
  })

  it('routes a migrated row whose label matches NO live config to Orphaned', () => {
    const sessions = [row({ sessionId: 'm', configId: null, configLabel: 'DELETED_CFG' })]
    const { groups, orphaned } = groupSessionsByConfig(sessions, new Set(['c1']), new Map([['c1', 'APP']]))
    expect(groups).toEqual([])
    expect(orphaned.map((s) => s.sessionId)).toEqual(['m'])
  })

  it('collapses duplicate historical labels into the single matching live group (accepted limitation)', () => {
    const sessions = [
      row({ sessionId: 'm1', configId: null, configLabel: 'APP', startedAt: 10 }),
      row({ sessionId: 'm2', configId: null, configLabel: 'APP', startedAt: 20 }),
    ]
    const live = new Map([['c1', 'APP']])
    const { groups } = groupSessionsByConfig(sessions, new Set(live.keys()), live)
    expect(groups.length).toBe(1)
    expect(groups[0].sessions.map((s) => s.sessionId).sort()).toEqual(['m1', 'm2'])
    expect(groups[0].sessions.every((s) => s.legacy)).toBe(true)
  })

  it('treats only the FIRST live config with a given label as the match for legacy rows', () => {
    const sessions = [row({ sessionId: 'L', configId: null, configLabel: 'DUP' })]
    const live = new Map([['cA', 'DUP'], ['cB', 'DUP']])
    const { groups } = groupSessionsByConfig(sessions, new Set(live.keys()), live)
    const target = groups.find((g) => g.sessions.some((s) => s.sessionId === 'L'))
    expect(target?.configId).toBe('cA')
  })
})
