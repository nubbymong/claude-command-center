/**
 * P3.12 (W4, Y1, Z1, Z2, K1, K3): when each Codex conversation was written while
 * not indexed, as windows per conversation (its rollout id): opened (when the
 * session became not indexed) and closed per session (a killed session's once
 * its process has ended), never cleared; kept on disk (a new window at once,
 * the rest coalesced, open windows left open at a final flush and closed at the
 * next start, as after a crash); a damaged or full record fails toward not
 * indexing. Real files in a fresh temp folder that only this test removes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initIndexingGaps, openNotIndexedWindow, closeNotIndexedWindow, releaseNotIndexedWindow, notIndexedSnapshot, setNotIndexedListener, flushIndexingGaps,
  conversationKey, indexingGapsWritesForTests, resetIndexingGapsForTests, NOT_INDEXED_CONVERSATIONS_MAX, WINDOWS_PER_CONVERSATION_MAX,
  keepNotIndexedWindow, closeHeldNotIndexedWindow, HELD_WINDOWS_PER_SESSION_MAX, HELD_COVER_WINDOWS_MAX,
  type NotIndexedUpdate,
} from '../../../src/main/logging/indexing-gaps'

const PREFIX = 'ccc-p312-gaps-'
const ID = '019dd000-0001-7000-8000-0000000000a1'
const A = `/r/a/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${ID}.jsonl`
const COPY = `/r/b/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${ID}.jsonl`
const OTHER_ID = '019dd000-0001-7000-8000-0000000000a2'
const OTHER = `/r/a/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${OTHER_ID}.jsonl`
const of = (key: string) => notIndexedSnapshot().conversations[key] ?? []
let dir: string
beforeEach(() => { resetIndexingGapsForTests(); dir = mkdtempSync(join(tmpdir(), PREFIX)) })
afterEach(() => { vi.useRealTimers(); resetIndexingGapsForTests(); if (basename(dir).startsWith(PREFIX) && dirname(dir) === tmpdir()) rmSync(dir, { recursive: true, force: true }) })

describe('when Codex conversations were written while not indexed (P3.12)', () => {
  it('a conversation is known by its rollout id: its copy in another account is the same conversation', () => {
    expect(conversationKey(A)).toBe(ID)
    expect(conversationKey(COPY)).toBe(ID)
    expect(conversationKey(OTHER)).not.toBe(ID)
  })

  it('a session opens a window on what it holds and closes it when it stops holding it; holding another closes the first; nothing clears them', () => {
    openNotIndexedWindow('s1', A, 100)
    openNotIndexedWindow('s1', COPY, 150)
    expect(of(ID)).toEqual([[100, null]])
    openNotIndexedWindow('s1', OTHER, 200)
    expect(of(ID)).toEqual([[100, 200]])
    expect(of(OTHER_ID)).toEqual([[200, null]])
    closeNotIndexedWindow('s1', 300)
    expect(of(OTHER_ID)).toEqual([[200, 300]])
    openNotIndexedWindow('s2', A, 400)
    closeNotIndexedWindow('s2', 500)
    expect(of(ID)).toEqual([[100, 200], [400, 500]])
    closeNotIndexedWindow('nobody', 600)
  })

  it('every change is told whole for the conversations it touches', () => {
    const told: NotIndexedUpdate[] = []
    setNotIndexedListener((u) => told.push(u))
    openNotIndexedWindow('s1', A, 100)
    openNotIndexedWindow('s1', OTHER, 200)
    expect(told).toEqual([
      { conversations: { [ID]: [[100, null]] }, before: null },
      { conversations: { [ID]: [[100, 200]], [OTHER_ID]: [[200, null]] }, before: null },
    ])
  })

  it('kept on disk and read back; a window still open when the app stopped is closed at the next start', () => {
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 50)
    openNotIndexedWindow('s1', A, 100)
    resetIndexingGapsForTests()
    initIndexingGaps(file, 900)
    expect(of(ID)).toEqual([[100, 900]])
    expect(JSON.parse(readFileSync(file, 'utf8')).conversations[ID]).toEqual([[100, 900]])
  })

  it('Z2: at quit, a window still open stays open on disk (Codex writes its last records after the quit); a close reported after it changes nothing; the next start closes it at its time', () => {
    vi.useFakeTimers()
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 50)
    openNotIndexedWindow('s1', A, 100)
    openNotIndexedWindow('s2', OTHER, 120)
    closeNotIndexedWindow('s2', 130)
    flushIndexingGaps()
    // What was already closed is written; what was open is written open.
    const saved = () => JSON.parse(readFileSync(file, 'utf8')).conversations
    expect(saved()[ID]).toEqual([[100, null]])
    expect(saved()[OTHER_ID]).toEqual([[120, 130]])
    // The teardown that follows ends the sessions: their windows are left open.
    closeNotIndexedWindow('s1', 800)
    vi.advanceTimersByTime(5000)
    expect(of(ID)).toEqual([[100, null]])
    expect(saved()[ID]).toEqual([[100, null]])
    // A window opened while stopping is still opened, and written.
    openNotIndexedWindow('s3', OTHER, 850)
    expect(saved()[OTHER_ID]).toEqual([[120, 130], [850, null]])
    resetIndexingGapsForTests()
    initIndexingGaps(file, 900)
    expect(of(ID)).toEqual([[100, 900]])
    expect(of(OTHER_ID)).toEqual([[120, 130], [850, 900]])
  })

  // ---- round 6 (Z1): a window opens when the session became not indexed ----

  const NOW = Date.now()

  it('Z1 (round 7, K2): the window opens at the moment the session became not indexed, whatever its rollout says of its own start: nothing of the rollout is read, so a stamp out of order cannot narrow it', () => {
    // A real rollout whose session_meta is stamped after the moment the session became not indexed (5 s ago): the window still starts at that moment.
    const f = join(dir, `rollout-2026-09-30T10-00-00-${ID}.jsonl`)
    writeFileSync(f, JSON.stringify({ timestamp: new Date(NOW - 4000).toISOString(), type: 'session_meta', payload: { id: ID, cwd: '/w' } }) + '\n')
    openNotIndexedWindow('s1', f, NOW - 5000, NOW)
    expect(of(ID)).toEqual([[NOW - 5000, null]])
  })

  it('Z1: a moment later than the claim is not one the session was on it: the window opens at the claim', () => {
    openNotIndexedWindow('s1', A, NOW + 1000, NOW)
    expect(of(ID)).toEqual([[NOW, null]])
  })

  it('Z1: claiming another conversation closes the first at the claim, though the new window opens at the earlier moment', () => {
    openNotIndexedWindow('s1', A, NOW - 9000, NOW - 8000)
    openNotIndexedWindow('s1', OTHER, NOW - 9000, NOW)
    expect(of(ID)).toEqual([[NOW - 9000, NOW]])
    expect(of(OTHER_ID)).toEqual([[NOW - 9000, null]])
  })

  // ---- round 7 (K1): a killed session's window closes when its process has ended ----

  it('K1: a session released from its window leaves it open until the returned closer runs, at the time given; its next launch opens a window of its own, which the old closer never closes', () => {
    openNotIndexedWindow('s1', A, 100)
    const close = releaseNotIndexedWindow('s1')!
    expect(close).toEqual(expect.any(Function))
    expect(of(ID)).toEqual([[100, null]])
    // It holds nothing now: its end reported while the process winds down changes nothing.
    closeNotIndexedWindow('s1', 200)
    expect(of(ID)).toEqual([[100, null]])
    // The next launch opens its own window on the same conversation.
    openNotIndexedWindow('s1', A, 300)
    close(400)
    expect(of(ID)).toEqual([[100, 400], [300, null]])
    close(500)
    expect(of(ID)).toEqual([[100, 400], [300, null]])
    expect(releaseNotIndexedWindow('nobody')).toBeNull()
  })

  it('K1: each session closes only its own window: two sessions on one conversation, released or ended in either order', () => {
    openNotIndexedWindow('s1', A, 100)
    openNotIndexedWindow('s2', A, 150)
    const close1 = releaseNotIndexedWindow('s1')!
    closeNotIndexedWindow('s2', 250)
    expect(of(ID)).toEqual([[100, null], [150, 250]])
    close1(300)
    expect(of(ID)).toEqual([[100, 300], [150, 250]])
    // The other way: the one opened first ends normally while the later is released.
    openNotIndexedWindow('s3', A, 400)
    openNotIndexedWindow('s4', A, 450)
    const close4 = releaseNotIndexedWindow('s4')!
    closeNotIndexedWindow('s3', 500)
    close4(600)
    expect(of(ID)).toEqual([[100, 300], [150, 250], [400, 500], [450, 600]])
  })

  it('K1: a closer does nothing once the app is stopping (the next start closes the window), and nothing for a window merged into an older one (it stays open: toward not indexing)', () => {
    openNotIndexedWindow('s1', A, 100)
    const close = releaseNotIndexedWindow('s1')!
    flushIndexingGaps()
    close(200)
    expect(of(ID)).toEqual([[100, null]])
    resetIndexingGapsForTests()
    // Merged: the released window is the oldest, so it is spanned into one with the next oldest.
    openNotIndexedWindow('s1', A, 100)
    const closeMerged = releaseNotIndexedWindow('s1')!
    for (let i = 0; i < WINDOWS_PER_CONVERSATION_MAX; i++) { openNotIndexedWindow('s2', A, 1000 + i * 10); closeNotIndexedWindow('s2', 1005 + i * 10) }
    expect(of(ID)).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    expect(of(ID)[0][1]).toBeNull()
    closeMerged(9000)
    expect(of(ID)[0]).toEqual([100, null])
  })

  it('L1: a session that ends while its window was merged into an older one leaves it open, and closes no other session\'s window on the conversation (toward not indexing)', () => {
    openNotIndexedWindow('s1', A, 100)
    for (let i = 0; i < WINDOWS_PER_CONVERSATION_MAX; i++) { openNotIndexedWindow('s2', A, 1000 + i * 10); closeNotIndexedWindow('s2', 1005 + i * 10) }
    expect(of(ID)[0]).toEqual([100, null])
    // Another session holds the conversation too.
    openNotIndexedWindow('s3', A, 20_000)
    expect(of(ID).at(-1)).toEqual([20_000, null])
    closeNotIndexedWindow('s1', 30_000)
    expect(of(ID)[0]).toEqual([100, null])
    expect(of(ID).at(-1)).toEqual([20_000, null])
    // Its own window, still in the record, closes as ever.
    closeNotIndexedWindow('s3', 40_000)
    expect(of(ID).at(-1)).toEqual([20_000, 40_000])
  })

  it('K3: a flush that is not final writes what is pending but does not latch: a close after it still closes; a final flush latches', () => {
    vi.useFakeTimers()
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 50)
    openNotIndexedWindow('s1', A, 100)
    openNotIndexedWindow('s2', OTHER, 120)
    closeNotIndexedWindow('s2', 130)
    flushIndexingGaps({ final: false })
    const saved = () => JSON.parse(readFileSync(file, 'utf8')).conversations
    expect(saved()[OTHER_ID]).toEqual([[120, 130]])
    // The app went on running (the shutdown was vetoed): the session ends and its window closes.
    closeNotIndexedWindow('s1', 800)
    vi.advanceTimersByTime(5000)
    expect(of(ID)).toEqual([[100, 800]])
    expect(saved()[ID]).toEqual([[100, 800]])
    // A final flush latches.
    openNotIndexedWindow('s3', A, 900)
    flushIndexingGaps({ final: true })
    closeNotIndexedWindow('s3', 950)
    expect(of(ID)).toEqual([[100, 800], [900, null]])
  })

  it('a damaged record at start is kept aside (the newest three), and every record stamped before then counts as written while not indexed', () => {
    const file = join(dir, 'logging-gaps.json')
    const own = (ts: number) => `logging-gaps.json.damaged-${ts}`
    for (const ts of [100, 200, 300]) writeFileSync(join(dir, own(ts)), 'x')
    writeFileSync(join(dir, 'other.json.damaged-50'), 'keep')
    writeFileSync(join(dir, 'logging-gaps.json.damaged-notatime'), 'keep')
    writeFileSync(file, '{"version":3,"conversations":{"x":')
    initIndexingGaps(file, 5000)
    expect(notIndexedSnapshot().before).toBe(5000)
    const left = readdirSync(dir).sort()
    expect(left.filter((f) => /^logging-gaps\.json\.damaged-\d+$/.test(f))).toEqual([own(200), own(300), own(5000)])
    expect(left).toContain('other.json.damaged-50')
    expect(left).toContain('logging-gaps.json.damaged-notatime')
    resetIndexingGapsForTests()
    initIndexingGaps(file, 9000)
    expect(notIndexedSnapshot().before).toBe(5000)
  })

  it('an earlier record (marks by conversation) is read as windows up to this start; another shape is damaged; a missing one is a fresh start', () => {
    const file = join(dir, 'logging-gaps.json')
    writeFileSync(file, JSON.stringify({ version: 2, marks: { [ID]: 100 }, suspectBefore: 40 }))
    initIndexingGaps(file, 800)
    expect(of(ID)).toEqual([[100, 800]])
    expect(notIndexedSnapshot().before).toBe(40)
    resetIndexingGapsForTests()
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { S: 5 } }))
    initIndexingGaps(file, 7000)
    expect(notIndexedSnapshot().before).toBe(7000)
    resetIndexingGapsForTests()
    initIndexingGaps(join(dir, 'none.json'), 7000)
    expect(notIndexedSnapshot()).toEqual({ conversations: {}, before: null })
  })

  it('full, a conversation\'s oldest windows are merged into one spanning them; past the conversations kept, the oldest goes after before is raised past its windows', () => {
    for (let i = 0; i <= WINDOWS_PER_CONVERSATION_MAX; i++) {
      openNotIndexedWindow('s1', A, 1000 + i * 10)
      closeNotIndexedWindow('s1', 1005 + i * 10)
    }
    const list = of(ID)
    expect(list).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    expect(list[0]).toEqual([1000, 1015])
    for (let i = 0; i < NOT_INDEXED_CONVERSATIONS_MAX; i++) { openNotIndexedWindow('s2', `/r/rollout-z-${i}.jsonl`, 5000 + i); closeNotIndexedWindow('s2', 5000 + i) }
    expect(of(ID)).toEqual([])
    expect(notIndexedSnapshot().before).toBeGreaterThanOrEqual(1005 + WINDOWS_PER_CONVERSATION_MAX * 10)
  })

  it('a newly opened window is written at once; closing is written later, coalesced and atomically', () => {
    vi.useFakeTimers()
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 1)
    const writes0 = indexingGapsWritesForTests()
    openNotIndexedWindow('s1', A, 10)
    expect(indexingGapsWritesForTests()).toBe(writes0 + 1)
    closeNotIndexedWindow('s1', 20)
    expect(indexingGapsWritesForTests()).toBe(writes0 + 1)
    vi.advanceTimersByTime(5000)
    expect(indexingGapsWritesForTests()).toBe(writes0 + 2)
    expect(JSON.parse(readFileSync(file, 'utf8')).conversations[ID]).toEqual([[10, 20]])
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(existsSync(file)).toBe(true)
  })
})

// P3.16 rounds 1 and 2 (N1, N2, N4; Q2): the windows a session holds beside one
// another (a Claude session: its projects folder's, one per transcript it
// names), each from the moment it became not indexed, until it ends; at most
// HELD_WINDOWS_PER_SESSION_MAX, and up to HELD_COVER_WINDOWS_MAX cover windows
// past them, which only the session's end closes.
describe('keepNotIndexedWindow: the windows one session holds beside one another (P3.16)', () => {
  it('opens a window from the earlier of since and now on a key it does not hold, and says held on one it holds; each stays open beside the others', () => {
    expect(keepNotIndexedWindow('c1', 'folder-key', 100, 150)).toBe('opened')
    expect(keepNotIndexedWindow('c1', 'transcript-1', 300, 200)).toBe('opened')
    expect(keepNotIndexedWindow('c1', 'folder-key', 100, 400)).toBe('held')
    expect(of('folder-key')).toEqual([[100, null]])
    expect(of('transcript-1')).toEqual([[200, null]])
  })

  it('takes nothing it is not given whole: no session or key, one too long, a time that is not a finite number', () => {
    const cases: Array<[string, string, number, number]> = [
      ['', 'k', 1, 1], ['c1', '', 1, 1], ['s'.repeat(201), 'k', 1, 1], ['c1', 'k'.repeat(201), 1, 1],
      ['c1', 'k', Number.NaN, 1], ['c1', 'k', 1, Number.POSITIVE_INFINITY],
    ]
    for (const [sid, key, since, now] of cases) expect(keepNotIndexedWindow(sid, key, since, now), `${sid.length} ${key.length} ${since} ${now}`).toBe('invalid')
    expect(notIndexedSnapshot().conversations).toEqual({})
  })

  it('holds at most 32 windows of names; past them a name is full and a cover takes up to 2 more: 34 at most, per session', () => {
    expect([HELD_WINDOWS_PER_SESSION_MAX, HELD_COVER_WINDOWS_MAX]).toEqual([32, 2])
    for (let i = 0; i < HELD_WINDOWS_PER_SESSION_MAX; i++) expect(keepNotIndexedWindow('c1', `t-${i}`, 100, 100 + i)).toBe('opened')
    expect(keepNotIndexedWindow('c1', 't-late', 100, 500)).toBe('full')
    expect(keepNotIndexedWindow('c1', 'folder-key', 100, 500, { cover: true })).toBe('opened')
    expect(keepNotIndexedWindow('c1', 'root-key', 100, 500, { cover: true })).toBe('opened')
    expect(keepNotIndexedWindow('c1', 'third-cover', 100, 500, { cover: true })).toBe('full')
    expect(of('t-late')).toEqual([])
    expect(of('third-cover')).toEqual([])
    expect(of('root-key')).toEqual([[100, null]])
    // Another session counts its own.
    expect(keepNotIndexedWindow('c2', 't-late', 100, 500)).toBe('opened')
    expect(of('t-late')).toEqual([[100, null]])
  })

  it('closeHeldNotIndexedWindow closes only that window and leaves a cover open; the session\'s end closes every one, the covers too', () => {
    keepNotIndexedWindow('c1', 'folder-key', 100)
    keepNotIndexedWindow('c1', 't-1', 100, 200)
    closeHeldNotIndexedWindow('c1', 'folder-key', 200)
    expect(of('folder-key')).toEqual([[100, 200]])
    expect(of('t-1')).toEqual([[100, null]])
    // A cover, asked for anew or on a key held already, stays open.
    expect(keepNotIndexedWindow('c1', 'root-key', 100, 300, { cover: true })).toBe('opened')
    expect(keepNotIndexedWindow('c1', 't-1', 100, 300, { cover: true })).toBe('held')
    closeHeldNotIndexedWindow('c1', 'root-key', 400)
    closeHeldNotIndexedWindow('c1', 't-1', 400)
    expect(of('root-key')).toEqual([[100, null]])
    expect(of('t-1')).toEqual([[100, null]])
    closeNotIndexedWindow('c1', 900)
    expect(of('root-key')).toEqual([[100, 900]])
    expect(of('t-1')).toEqual([[100, 900]])
    expect(of('folder-key')).toEqual([[100, 200]])
  })

  it('a window asked to be written now is written at once; the rest with the coalesced write', () => {
    vi.useFakeTimers()
    initIndexingGaps(join(dir, 'logging-gaps.json'), 1)
    const writes0 = indexingGapsWritesForTests()
    keepNotIndexedWindow('c1', 'folder-key', 10, 10, { writeNow: true })
    expect(indexingGapsWritesForTests()).toBe(writes0 + 1)
    keepNotIndexedWindow('c1', 't-1', 10, 20)
    expect(indexingGapsWritesForTests()).toBe(writes0 + 1)
    vi.advanceTimersByTime(5000)
    expect(indexingGapsWritesForTests()).toBe(writes0 + 2)
  })
})
