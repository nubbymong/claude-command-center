/**
 * P3.12 (W4, X1-X3): the Codex conversations written while not indexed,
 * kept by conversation (its rollout id), cleared once a run binds one; a
 * damaged or full record fails toward not indexing; written coalesced, off
 * the claim path, and at quit. Real files in a fresh temp folder that only
 * this test removes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initIndexingGaps, markNotIndexed, notIndexedFor, noteNotIndexedBound, flushIndexingGaps, conversationKey,
  indexingGapsWritesForTests, resetIndexingGapsForTests, NOT_INDEXED_MARKS_MAX,
} from '../../../src/main/logging/indexing-gaps'

const PREFIX = 'ccc-p312-gaps-'
const ID = '019dd000-0001-7000-8000-0000000000a1'
const A = `/r/a/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${ID}.jsonl`
const COPY = `/r/b/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${ID}.jsonl`
const OTHER = '/r/a/sessions/2026/09/30/rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-0000000000a2.jsonl'
let dir: string
beforeEach(() => { resetIndexingGapsForTests(); dir = mkdtempSync(join(tmpdir(), PREFIX)) })
afterEach(() => { vi.useRealTimers(); resetIndexingGapsForTests(); if (basename(dir).startsWith(PREFIX) && dirname(dir) === tmpdir()) rmSync(dir, { recursive: true, force: true }) })

describe('the conversations written while not indexed (P3.12)', () => {
  it('a conversation is known by its rollout id: its copy in another account is the same conversation', () => {
    expect(conversationKey(A)).toBe(ID)
    expect(conversationKey(COPY)).toBe(ID)
    expect(conversationKey(OTHER)).not.toBe(ID)
  })

  it('marked, it is not indexed from before (whichever path); bound by a run, the mark goes; never marked, nothing', () => {
    markNotIndexed(A, 100)
    markNotIndexed(A, 50)
    expect(notIndexedFor(COPY)).toEqual({ since: 100 })
    expect(notIndexedFor(OTHER)).toBeNull()
    noteNotIndexedBound(COPY)
    expect(notIndexedFor(A)).toBeNull()
  })

  it('kept on disk once a file is named, read back after a restart', () => {
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 1000)
    markNotIndexed(A, 300)
    flushIndexingGaps()
    resetIndexingGapsForTests()
    initIndexingGaps(file, 2000)
    expect(notIndexedFor(A)).toEqual({ since: 300 })
  })

  it('X2: a damaged record at start is kept aside, and every conversation begun before then counts as not indexed until a run binds it (kept across restarts)', () => {
    const file = join(dir, 'logging-gaps.json')
    writeFileSync(file, '{"version":2,"marks":{"x":')
    initIndexingGaps(file, 5000)
    expect(readdirSync(dir).some((f) => f.startsWith('logging-gaps.json.damaged-'))).toBe(true)
    expect(notIndexedFor(A)).toEqual({ ifBegunBefore: 5000 })
    noteNotIndexedBound(A)
    expect(notIndexedFor(A)).toBeNull()
    expect(notIndexedFor(OTHER)).toEqual({ ifBegunBefore: 5000 })
    flushIndexingGaps()
    resetIndexingGapsForTests()
    initIndexingGaps(file, 9000)
    expect(notIndexedFor(A)).toBeNull()
    expect(notIndexedFor(OTHER)).toEqual({ ifBegunBefore: 5000 })
  })

  it('X2: a record in another shape (an earlier one) is taken as damaged; a missing one is a fresh start', () => {
    const file = join(dir, 'logging-gaps.json')
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { S: 5 } }))
    initIndexingGaps(file, 7000)
    expect(notIndexedFor(A)).toEqual({ ifBegunBefore: 7000 })
    resetIndexingGapsForTests()
    initIndexingGaps(join(dir, 'none.json'), 7000)
    expect(notIndexedFor(A)).toBeNull()
  })

  it('X2: full, no mark is dropped for a conversation not bound since: every conversation begun before then counts as not indexed', () => {
    for (let i = 0; i < NOT_INDEXED_MARKS_MAX; i++) markNotIndexed(`/r/rollout-x-${i}.jsonl`, i + 1)
    markNotIndexed(A, NOT_INDEXED_MARKS_MAX + 1)
    expect(notIndexedFor('/r/rollout-x-0.jsonl')).not.toBeNull()
    expect(notIndexedFor(A)).toEqual({ since: NOT_INDEXED_MARKS_MAX + 1 })
    expect(notIndexedFor(OTHER)).not.toBeNull()
  })

  it('X3: a conversation\'s first mark is written at once; later marks of marked conversations are written once, later and atomically; a flush at quit writes what is pending', () => {
    vi.useFakeTimers()
    const file = join(dir, 'logging-gaps.json')
    initIndexingGaps(file, 1)
    const before = indexingGapsWritesForTests()
    markNotIndexed(A, 10)
    expect(indexingGapsWritesForTests()).toBe(before + 1)
    expect(JSON.parse(readFileSync(file, 'utf8')).marks[ID]).toBe(10)
    for (let i = 0; i < 50; i++) markNotIndexed(A, 11 + i)
    expect(indexingGapsWritesForTests()).toBe(before + 1)
    vi.advanceTimersByTime(5000)
    expect(indexingGapsWritesForTests()).toBe(before + 2)
    expect(JSON.parse(readFileSync(file, 'utf8')).marks[ID]).toBe(60)
    markNotIndexed(A, 99)
    flushIndexingGaps()
    expect(indexingGapsWritesForTests()).toBe(before + 3)
    expect(JSON.parse(readFileSync(file, 'utf8')).marks[ID]).toBe(99)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('X2: the newest three damaged records are kept aside; older ones go (only this record\'s own, in its own folder)', () => {
    const file = join(dir, 'logging-gaps.json')
    const own = (ts: number) => `logging-gaps.json.damaged-${ts}`
    for (const ts of [100, 200, 300, 400]) writeFileSync(join(dir, own(ts)), 'x')
    writeFileSync(join(dir, 'other.json.damaged-50'), 'keep')
    writeFileSync(join(dir, 'logging-gaps.json.damaged-notatime'), 'keep')
    writeFileSync(file, 'not json')
    initIndexingGaps(file, 500)
    const left = readdirSync(dir).sort()
    expect(left.filter((f) => /^logging-gaps\.json\.damaged-\d+$/.test(f))).toEqual([own(300), own(400), own(500)])
    expect(left).toContain('other.json.damaged-50')
    expect(left).toContain('logging-gaps.json.damaged-notatime')
  })
})
