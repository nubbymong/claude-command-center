// P3.8 round 3 (DB): an open of the Tokenomics database that fails while it
// is being set up (a locked file, say) closes the handle it opened before the
// error goes on, so a retry is not left holding a second one. The database
// driver is replaced by a stand-in; no file is opened.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ opened: 0, closed: 0, failOn: '' }))

vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() { state.opened++ }
    exec(sql: string) { if (state.failOn && sql.includes(state.failOn)) throw new Error('database is locked'); return this }
    prepare() { return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] } }
    pragma() { return [] }
    transaction(fn: (...a: unknown[]) => unknown) { return fn }
    close() { state.closed++ }
  },
}))

const { openTkDb } = await import('../../../src/main/tokenomics/tk-db')

beforeEach(() => { state.opened = 0; state.closed = 0; state.failOn = '' })

describe('opening the Tokenomics database', () => {
  it('a failure while it is set up closes the handle it opened, then fails', () => {
    state.failOn = 'CREATE TABLE'
    expect(() => openTkDb('tk.db')).toThrow(/locked/)
    expect(state.opened).toBe(1)
    expect(state.closed).toBe(1)
  })
})
