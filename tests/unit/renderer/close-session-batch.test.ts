// closeSessionBatch (2.1.1) replaced six identical inline "close all" loops in
// Sidebar.tsx. The order those loops encoded is the contract: kill the PTY,
// forget the SSH browser profile, then drop the store record -- once per id.
// WP2 T24 fix round: before the kill, each session goes through the container
// branch of a single close (endContainerSessionRemote, a no-op for every
// session that does not run in a container), so a bulk close no longer leaves
// a container session's Claude running there. ssh-end-notice.test.tsx drives
// the same path through the real stores.
//
// Mutation to prove this can fail: drop the endContainerSessionRemote call
// from closeSessionBatch, or move it after killSessionPty.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ log: [] as string[], sessions: [] as Array<{ id: string }> }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (id: string) => { calls.log.push(`kill:${id}`) },
}))
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({
  forgetSessionBrowserProfile: (id: string) => { calls.log.push(`forget:${id}`) },
  endContainerSessionRemote: (s: { id: string } | undefined) => { calls.log.push(`end:${s?.id ?? 'none'}`) },
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ sessions: calls.sessions, removeSession: (id: string) => { calls.log.push(`remove:${id}`) } }) },
}))

import { closeSessionBatch } from '../../../src/renderer/utils/closeSessionBatch'

beforeEach(() => { calls.log.length = 0; calls.sessions = [{ id: 'a' }, { id: 'b' }, { id: 'only' }] })

describe('closeSessionBatch', () => {
  it('ends a container remote, kills the PTY, forgets the browser profile, then drops the record -- in that order, once per id', () => {
    closeSessionBatch(['a', 'b'])
    expect(calls.log).toEqual(['end:a', 'kill:a', 'forget:a', 'remove:a', 'end:b', 'kill:b', 'forget:b', 'remove:b'])
  })

  it('hands the container branch the session record (or nothing, for an id the store no longer has)', () => {
    closeSessionBatch(['gone'])
    expect(calls.log).toEqual(['end:none', 'kill:gone', 'forget:gone', 'remove:gone'])
  })

  it('accepts any iterable and touches nothing for an empty one', () => {
    closeSessionBatch(new Set<string>())
    expect(calls.log).toEqual([])
    closeSessionBatch(new Set(['only']))
    expect(calls.log).toEqual(['end:only', 'kill:only', 'forget:only', 'remove:only'])
  })
})
