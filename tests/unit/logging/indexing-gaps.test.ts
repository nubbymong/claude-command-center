/**
 * P3.12 (W4, Y1, Z1, Z2): when each Codex conversation was written while not
 * indexed, as windows per conversation (its rollout id): opened (when the
 * session became not indexed, not before the conversation began) and closed
 * per session, never cleared; kept on disk (a new window at once, the rest
 * coalesced, open windows left open at quit and closed at the next start, as
 * after a crash); a damaged or full record fails toward not indexing. Real
 * files in a fresh temp folder that only this test removes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initIndexingGaps, openNotIndexedWindow, closeNotIndexedWindow, notIndexedSnapshot, setNotIndexedListener, flushIndexingGaps,
  conversationKey, indexingGapsWritesForTests, resetIndexingGapsForTests, NOT_INDEXED_CONVERSATIONS_MAX, WINDOWS_PER_CONVERSATION_MAX,
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

  /** A rollout file whose first record is a session_meta stamped `at` (a string as Codex writes it). */
  const rolloutFile = (id: string, first: string) => {
    const f = join(dir, `rollout-2026-09-30T10-00-00-${id}.jsonl`)
    writeFileSync(f, first + '\n' + JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'x' } }) + '\n')
    return f
  }
  const meta = (at: unknown, type = 'session_meta') => JSON.stringify({ timestamp: at, type, payload: { id: ID, cwd: '/w' } })
  const NOW = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  /** The time as a zoneless text (local time, no zone designator), which Date.parse reads as local time. */
  const localIso = (ms: number) => {
    const d = new Date(ms)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  it('Z1: the window opens at the moment the session became not indexed, not before the conversation began: a conversation begun after that moment starts it at its own session_meta time', () => {
    // The session was launched not indexed 5 s ago; Codex wrote the conversation's session_meta 4 s ago; the claim is now.
    openNotIndexedWindow('s1', rolloutFile(ID, meta(iso(NOW - 4000))), NOW - 5000, NOW)
    expect(of(ID)).toEqual([[NOW - 4000, null]])
  })

  it('Z1: a conversation begun before that moment (a resume) keeps its earlier turns: the window opens at the moment, not at the conversation\'s start', () => {
    openNotIndexedWindow('s1', rolloutFile(OTHER_ID, meta(iso(NOW - 86_400_000))), NOW - 5000, NOW)
    expect(of(OTHER_ID)).toEqual([[NOW - 5000, null]])
  })

  it('Z1: a session_meta time that cannot be trusted bounds nothing (the window keeps its earlier start): later than the claim, with no zone, not a session_meta record, a first line too long, no such file, a folder, a link', () => {
    const since = NOW - 5000
    const cases: Array<[string, string | null]> = [
      ['0001', meta(iso(NOW + 60_000))],
      ['0002', meta(localIso(NOW - 4000))],
      ['0003', meta(iso(NOW - 4000), 'turn_context')],
      ['0004', JSON.stringify({ timestamp: iso(NOW - 4000), type: 'session_meta', payload: { text: 'a'.repeat(600 * 1024) } })],
      ['0005', null],
    ]
    for (const [n, first] of cases) {
      const id = `019dd000-0001-7000-8000-00000000${n}`
      const path = first === null ? join(dir, `rollout-2026-09-30T10-00-00-${id}.jsonl`) : rolloutFile(id, first)
      openNotIndexedWindow(`s-${n}`, path, since, NOW)
      expect(of(id), n).toEqual([[since, null]])
    }
    // A folder at the path.
    const folderId = '019dd000-0001-7000-8000-000000000006'
    const folder = join(dir, `rollout-2026-09-30T10-00-00-${folderId}.jsonl`)
    mkdirSync(folder)
    openNotIndexedWindow('s-0006', folder, since, NOW)
    expect(of(folderId), '0006').toEqual([[since, null]])
    // A link to a rollout that does bound (made where links can be: not on a host that refuses them).
    const target = rolloutFile(ID, meta(iso(NOW - 4000)))
    const linkId = '019dd000-0001-7000-8000-000000000007'
    try { symlinkSync(target, join(dir, `rollout-2026-09-30T10-00-00-${linkId}.jsonl`)) } catch { return }
    openNotIndexedWindow('s-0007', join(dir, `rollout-2026-09-30T10-00-00-${linkId}.jsonl`), since, NOW)
    expect(of(linkId), '0007').toEqual([[since, null]])
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
