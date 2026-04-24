import { describe, it, expect } from 'vitest'
import {
  buildSessionContext,
  extractBranchIssueNumber,
} from '../../../src/main/github/session/session-context-service'

describe('buildSessionContext — priority algorithm', () => {
  it('branch name wins over transcript', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-247-login',
      transcriptRefs: [{ kind: 'issue', number: 999, at: 1 }],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(247)
  })
  it('transcript wins over PR body when no branch match', async () => {
    const r = await buildSessionContext({
      branchName: 'random-name',
      transcriptRefs: [{ kind: 'issue', number: 100, at: 1 }],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(100)
  })
  it('PR body wins when no branch and no transcript', async () => {
    const r = await buildSessionContext({
      branchName: 'random',
      transcriptRefs: [],
      prBodyRefs: [42],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(42)
  })
  it('no primary when no signals', async () => {
    const r = await buildSessionContext({
      branchName: undefined,
      transcriptRefs: [],
      prBodyRefs: [],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue).toBeUndefined()
  })
  it('populates otherSignals with non-winning matches', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-1-x',
      transcriptRefs: [{ kind: 'issue', number: 2, at: 1 }],
      prBodyRefs: [3],
      recentFiles: [],
      enrichIssue: async () => null,
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(1)
    expect(r.otherSignals.map((s) => s.number).sort()).toEqual([2, 3])
  })
  it('enriches primary issue when enricher provided', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-42-x',
      transcriptRefs: [],
      prBodyRefs: [],
      recentFiles: [],
      enrichIssue: async (_repo, n) => ({
        title: `issue ${n}`,
        state: 'open' as const,
        assignee: 'me',
      }),
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.title).toBe('issue 42')
  })
  it('swallows enrichIssue errors and still returns primary', async () => {
    const r = await buildSessionContext({
      branchName: 'fix-42-x',
      transcriptRefs: [],
      prBodyRefs: [],
      recentFiles: [],
      enrichIssue: async () => {
        throw new Error('rate-limited')
      },
      sessionRepo: 'a/b',
    })
    expect(r.primaryIssue?.number).toBe(42)
    expect(r.primaryIssue?.title).toBeUndefined()
  })
})

describe('extractBranchIssueNumber', () => {
  it('matches fix-NNN', () => {
    expect(extractBranchIssueNumber('fix-247-login')).toBe(247)
  })
  it('matches feat/NNN', () => {
    expect(extractBranchIssueNumber('feat/99-xyz')).toBe(99)
  })
  it('matches bare NNN-', () => {
    expect(extractBranchIssueNumber('100-x')).toBe(100)
  })
  it('returns null on no match', () => {
    expect(extractBranchIssueNumber('my-branch')).toBeNull()
  })
})
