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
  setNotIndexedConversationsMaxForTests,
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

  it('K1: a closer does nothing once the app is stopping (the next start closes the window); past the windows kept, its window is never merged, so the closer closes it (round 2, K3)', () => {
    openNotIndexedWindow('s1', A, 100)
    const close = releaseNotIndexedWindow('s1')!
    flushIndexingGaps()
    close(200)
    expect(of(ID)).toEqual([[100, null]])
    resetIndexingGapsForTests()
    // The released window is the oldest; only the closed ones after it are merged.
    openNotIndexedWindow('s1', A, 100)
    const closeKept = releaseNotIndexedWindow('s1')!
    for (let i = 0; i < WINDOWS_PER_CONVERSATION_MAX; i++) { openNotIndexedWindow('s2', A, 1000 + i * 10); closeNotIndexedWindow('s2', 1005 + i * 10) }
    expect(of(ID)).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    expect(of(ID)[0]).toEqual([100, null])
    expect(of(ID)[1]).toEqual([1000, 1015])
    closeKept(9000)
    expect(of(ID)[0]).toEqual([100, 9000])
  })

  it('L1, K3 (round 2): past the windows kept, a session\'s open window is never merged: its end closes it, and no other session\'s window on the conversation', () => {
    openNotIndexedWindow('s1', A, 100)
    for (let i = 0; i < WINDOWS_PER_CONVERSATION_MAX; i++) { openNotIndexedWindow('s2', A, 1000 + i * 10); closeNotIndexedWindow('s2', 1005 + i * 10) }
    expect(of(ID)[0]).toEqual([100, null])
    // Another session holds the conversation too.
    openNotIndexedWindow('s3', A, 20_000)
    expect(of(ID).at(-1)).toEqual([20_000, null])
    expect(of(ID)).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    closeNotIndexedWindow('s1', 30_000)
    expect(of(ID)[0]).toEqual([100, 30_000])
    expect(of(ID).at(-1)).toEqual([20_000, null])
    closeNotIndexedWindow('s3', 40_000)
    expect(of(ID).at(-1)).toEqual([20_000, 40_000])
  })

  it('K3 (round 2): past the windows kept with every window open, none is merged (each stays its holder\'s; bounded by the sessions holding them); the oldest closed ones merge once there are any', () => {
    const n = WINDOWS_PER_CONVERSATION_MAX + 2
    for (let i = 0; i < n; i++) openNotIndexedWindow(`h${i}`, A, 1000 + i * 10)
    expect(of(ID)).toHaveLength(n)
    expect(of(ID).every((w) => w[1] === null)).toBe(true)
    for (let i = 0; i < n; i++) closeNotIndexedWindow(`h${i}`, 1005 + i * 10)
    expect(of(ID).map((w) => w[1])).toEqual(Array.from({ length: n }, (_, i) => 1005 + i * 10))
    openNotIndexedWindow('late', A, 5000)
    expect(of(ID)).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    expect(of(ID)[0]).toEqual([1000, 1035])
    expect(of(ID).at(-1)).toEqual([5000, null])
  })

  it('K3 (round 2): an open window between closed ones is never merged: the closed ones on either side merge around it, and its holder closes it', () => {
    openNotIndexedWindow('s1', A, 100); closeNotIndexedWindow('s1', 150)
    openNotIndexedWindow('s2', A, 200)
    for (let i = 0; i < WINDOWS_PER_CONVERSATION_MAX - 1; i++) { openNotIndexedWindow('s3', A, 1000 + i * 10); closeNotIndexedWindow('s3', 1005 + i * 10) }
    expect(of(ID)).toHaveLength(WINDOWS_PER_CONVERSATION_MAX)
    expect(of(ID).slice(0, 2)).toEqual([[100, 1005], [200, null]])
    closeNotIndexedWindow('s2', 9000)
    expect(of(ID)[1]).toEqual([200, 9000])
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

// PR-level ADR-009 round 1 (C1): a Codex session not indexed holds a cover
// window on its realm's launch folder beside the one conversation it is on.
// A claim of a conversation, a claim of another and a claim let go close the
// conversation's window only; the cover stays open, and held, until the
// session ends (or, killed, until its process has ended).
describe('a Codex session\'s folder window beside its conversation (PR-level ADR-009 round 1, C1)', () => {
  const FOLDER = 'codex-folder:x'
  it('stays open and held across a claim, another claim and a claim let go; the session\'s end closes it with the rest', () => {
    expect(keepNotIndexedWindow('cx', FOLDER, 100, 100, { cover: true, writeNow: true })).toBe('opened')
    openNotIndexedWindow('cx', A, 100, 200)
    openNotIndexedWindow('cx', OTHER, 100, 300)
    expect(of(FOLDER)).toEqual([[100, null]])
    expect(of(ID)).toEqual([[100, 300]])
    // The claim let go: its conversation's window closes, the folder's stays.
    closeNotIndexedWindow('cx', 400, { coversStay: true })
    expect(of(OTHER_ID)).toEqual([[100, 400]])
    expect(of(FOLDER)).toEqual([[100, null]])
    openNotIndexedWindow('cx', A, 100, 500)
    expect(of(ID)).toEqual([[100, 300], [100, null]])
    closeNotIndexedWindow('cx', 600)
    expect(of(FOLDER)).toEqual([[100, 600]])
    expect(of(ID)).toEqual([[100, 300], [100, 600]])
  })

  it('a killed session\'s folder window stays open with its conversation\'s until the closer runs', () => {
    keepNotIndexedWindow('cx', FOLDER, 100, 100, { cover: true })
    openNotIndexedWindow('cx', A, 100, 200)
    const close = releaseNotIndexedWindow('cx')!
    expect(of(FOLDER)).toEqual([[100, null]])
    close(700)
    expect(of(FOLDER)).toEqual([[100, 700]])
    expect(of(ID)).toEqual([[100, 700]])
  })
})

// PR-level ADR-009 round 1 (C2): past the conversations kept, the least
// recently changed one with no window open goes (after `before` is raised past
// its windows); one whose window is still open (a session not indexed is on it,
// or a killed one winds down) never does, so what it writes after is never in
// no window. Past the cap with every conversation open, a name of a Claude
// session is refused ('full': its caller covers it with its folder's window, as
// past a session's own cap); a cover, and a Codex session's one conversation,
// are still opened. A small cap is set for the test.
describe('the conversations kept past the cap (PR-level ADR-009 round 1, C2)', () => {
  const rollout = (n: number) => `/r/a/sessions/2026/10/02/rollout-2026-10-02T00-00-00-019dd000-0001-7000-8000-${n.toString(16).padStart(12, '0')}.jsonl`
  const key = (n: number) => conversationKey(rollout(n))

  it('C2a: a conversation whose window is open is never dropped; the oldest closed one goes, before raised past it', () => {
    setNotIndexedConversationsMaxForTests(3)
    openNotIndexedWindow('held', rollout(0), 1000)
    openNotIndexedWindow('s1', rollout(1), 1100); closeNotIndexedWindow('s1', 1150)
    openNotIndexedWindow('s2', rollout(2), 1200); closeNotIndexedWindow('s2', 1250)
    openNotIndexedWindow('s3', rollout(3), 1300)
    expect(of(key(0))).toEqual([[1000, null]])
    expect(of(key(1))).toEqual([])
    expect(notIndexedSnapshot().before).toBe(1150)
    closeNotIndexedWindow('held', 9000)
    expect(of(key(0))).toEqual([[1000, 9000]])
  })

  it('C2b (the probe): every conversation open past the cap: none is dropped, the held one included; once one closes, the next new one makes room by it', () => {
    setNotIndexedConversationsMaxForTests(3)
    const told: NotIndexedUpdate[] = []
    setNotIndexedListener((u) => told.push(u))
    openNotIndexedWindow('held', rollout(0), 1000)
    for (let i = 1; i <= 3; i++) openNotIndexedWindow(`s${i}`, rollout(i), 1000 + i)
    expect(Object.keys(notIndexedSnapshot().conversations)).toHaveLength(4)
    expect(of(key(0))).toEqual([[1000, null]])
    expect(notIndexedSnapshot().before).toBeNull()
    closeNotIndexedWindow('s1', 1500)
    openNotIndexedWindow('s4', rollout(4), 1600)
    expect(of(key(1))).toEqual([])
    expect(of(key(0))).toEqual([[1000, null]])
    expect(notIndexedSnapshot().before).toBe(1500)
    // The held session ends later: the worker is told its window, closed, never an empty list.
    told.length = 0
    closeNotIndexedWindow('held', 60_000)
    expect(told[0].conversations[key(0)]).toEqual([[1000, 60_000]])
  })

  it('C2d (round 2, E1): a conversation with one window closed and one still open is never dropped past the cap', () => {
    setNotIndexedConversationsMaxForTests(1)
    openNotIndexedWindow('s1', rollout(0), 1000); closeNotIndexedWindow('s1', 1100)
    openNotIndexedWindow('s2', rollout(0), 1200)
    expect(of(key(0))).toEqual([[1000, 1100], [1200, null]])
    openNotIndexedWindow('s3', rollout(1), 1300)
    expect(of(key(0))).toEqual([[1000, 1100], [1200, null]])
    expect(of(key(1))).toEqual([[1300, null]])
    expect(notIndexedSnapshot().before).toBeNull()
  })

  it('C2c: past the cap with every conversation open, a Claude name is refused and a cover is opened instead; a conversation kept already takes another window; a closed one makes room', () => {
    setNotIndexedConversationsMaxForTests(2)
    expect(keepNotIndexedWindow('a', 'name-a', 100)).toBe('opened')
    expect(keepNotIndexedWindow('b', 'name-b', 100)).toBe('opened')
    expect(keepNotIndexedWindow('c', 'name-c', 100, 200)).toBe('full')
    expect(of('name-c')).toEqual([])
    expect(of('name-a')).toEqual([[100, null]])
    expect(keepNotIndexedWindow('c', 'folder-c', 100, 200, { cover: true })).toBe('opened')
    expect(of('folder-c')).toEqual([[100, null]])
    expect(keepNotIndexedWindow('d', 'name-a', 100, 300)).toBe('opened')
    closeNotIndexedWindow('b', 400)
    expect(keepNotIndexedWindow('e', 'name-e', 100, 500)).toBe('opened')
    expect(of('name-b')).toEqual([])
    expect(of('name-e')).toEqual([[100, null]])
  })
})
