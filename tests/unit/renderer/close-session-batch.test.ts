// closeSessionBatch (2.1.1) replaced six identical inline "close all" loops in
// Sidebar.tsx. The order those loops encoded is the contract: kill the PTY,
// forget the SSH browser profile, then drop the store record -- once per id.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ log: [] as string[] }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (id: string) => { calls.log.push(`kill:${id}`) },
}))
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({
  forgetSessionBrowserProfile: (id: string) => { calls.log.push(`forget:${id}`) },
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ removeSession: (id: string) => { calls.log.push(`remove:${id}`) } }) },
}))

import { closeSessionBatch } from '../../../src/renderer/utils/closeSessionBatch'

beforeEach(() => { calls.log.length = 0 })

describe('closeSessionBatch', () => {
  it('kills the PTY, forgets the browser profile, then drops the record -- in that order, once per id', () => {
    closeSessionBatch(['a', 'b'])
    expect(calls.log).toEqual(['kill:a', 'forget:a', 'remove:a', 'kill:b', 'forget:b', 'remove:b'])
  })

  it('accepts any iterable and touches nothing for an empty one', () => {
    closeSessionBatch(new Set<string>())
    expect(calls.log).toEqual([])
    closeSessionBatch(new Set(['only']))
    expect(calls.log).toEqual(['kill:only', 'forget:only', 'remove:only'])
  })
})
