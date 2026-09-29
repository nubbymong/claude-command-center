// P3.7 (row 36): a Codex session's lines changed. Codex writes no line
// count (P3.1 evidence, answer 5); each edit it applies is recorded in the
// rollout as a completed FileChange item whose unified diff says which lines
// went and came, so the count is derived from those, over the whole
// conversation, as Claude Code's is (its cost ledger is restored from the
// transcript on resume). Real files in a temp folder; no Codex, no process.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fsPromises } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import {
  countFileChangeLines,
  countRolloutRange,
  parseCodexRollout,
  watchAndClaimRollout,
  __codexRolloutBytesReadForTests,
  __codexEditCountBytesReadForTests,
  __codexEditCountTakeMostHeldForTests,
  CLAIM_HEAD_BYTES,
  CLAIM_TAIL_BYTES,
} from '../../../../src/main/providers/codex/telemetry'
import { codexFolderIdentity } from '../../../../src/main/providers/codex/rollout-lookup'
import type { StatuslineData } from '../../../../src/shared/types'

const ID = '019dd000-0001-7000-8000-0000000000c1'
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-lines-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-lines-'))
  temps.push(base)
  return join(base, 'sessions')
}
function dayOf(sessions: string, d: Date): string {
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
/** The edit both supported versions recorded on the VM (answer 5): beta replaced by delta and epsilon. */
const DIFF = '@@ -1,3 +1,4 @@\n alpha\n-beta\n+delta\n+epsilon\n gamma\n'
const metaLine = (id: string, cwd: string, iso: string) => JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } })
const tokenLine = (iso: string, input: number) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })
const editLine = (iso: string, changes: Record<string, unknown> = { 'C:\\p\\demo\\note.txt': { type: 'update', unified_diff: DIFF, move_path: null } }, status: unknown = 'completed') =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'item_completed', thread_id: ID, turn_id: 't-1', item: { type: 'FileChange', id: 'exec-1', changes, status, stdout: '', stderr: '' } } })
const filler = (bytes: number) => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(900) }] } })
  return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line).join('\n') + '\n'
}
const identityOf = (file: string) => { const st = lstatSync(file, { bigint: true }); return `${st.dev}:${st.ino}` }
function watch(sessions: string, cwd: string, resumeId?: string) {
  const updates: StatuslineData[] = []
  const src = watchAndClaimRollout('sess-lines', cwd, Date.now(), (d) => updates.push(d), sessions, undefined, resumeId ? { resumeId } : undefined)
  return { updates, src }
}

describe('the lines one recorded edit added and removed', () => {
  it('the edit recorded on 0.153.4 and 0.155.1: two added, one removed', () => {
    expect(countFileChangeLines({ 'C:\\p\\note.txt': { type: 'update', unified_diff: DIFF, move_path: null } })).toEqual({ added: 2, removed: 1 })
  })

  it('every changed file of the edit counts, and each hunk of a file', () => {
    const two = '@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10,1 +10,3 @@\n k\n+l\n+m\n'
    expect(countFileChangeLines({ '/p/x.ts': { type: 'update', unified_diff: two }, '/p/y.ts': { type: 'update', unified_diff: DIFF } })).toEqual({ added: 5, removed: 2 })
  })

  it('only lines inside a hunk count: a file header before it, and one after its lines are used up, do not', () => {
    const headed = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n--- a/y.ts\n+++ b/y.ts\n'
    expect(countFileChangeLines({ '/p/x.ts': { type: 'update', unified_diff: headed } })).toEqual({ added: 1, removed: 1 })
  })

  it('a removed line whose text begins with dashes counts; the no-newline marker and a blank context line do not', () => {
    const odd = '@@ -1,3 +1,2 @@\n--- a heading underline\n\n+++ plus signs\n-x\n\\ No newline at end of file\n'
    expect(countFileChangeLines({ '/p/x.md': { type: 'update', unified_diff: odd } })).toEqual({ added: 1, removed: 2 })
  })

  it('a hunk header without a count means one line', () => {
    expect(countFileChangeLines({ '/p/x': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n+c\n' } })).toEqual({ added: 1, removed: 1 })
  })

  it('the no-newline marker inside a hunk is passed over; a line that is no hunk line ends the hunk early', () => {
    expect(countFileChangeLines({ '/p/x': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n' } })).toEqual({ added: 1, removed: 1 })
    expect(countFileChangeLines({ '/p/x': { type: 'update', unified_diff: '@@ -1,9 +1,9 @@\n-a\n+b\ndiff --git a/y b/y\n+x\n-y\n@@ -4,1 +4,1 @@\n-p\n+q\n' } })).toEqual({ added: 2, removed: 2 })
  })

  it('a new file counts its lines as added, a deleted one as removed', () => {
    expect(countFileChangeLines({ '/p/new.ts': { type: 'add', content: 'one\ntwo\nthree\n' } })).toEqual({ added: 3, removed: 0 })
    expect(countFileChangeLines({ '/p/old.ts': { type: 'delete', content: 'one\ntwo' } })).toEqual({ added: 0, removed: 2 })
    expect(countFileChangeLines({ '/p/empty.ts': { type: 'add', content: '' } })).toEqual({ added: 0, removed: 0 })
  })

  it('anything else counts nothing', () => {
    for (const changes of [null, undefined, 'x', 7, [], [{ type: 'add', content: 'a\n' }], { '/p/x': null }, { '/p/x': { type: 'update' } }, { '/p/x': { type: 'update', unified_diff: 42 } }, { '/p/x': { type: 'rename' } }, { '/p/x': { type: 'update', unified_diff: '-a\n+b\n' } }]) {
      expect(countFileChangeLines(changes)).toEqual({ added: 0, removed: 0 })
    }
  })
})

describe('a rollout\'s lines changed', () => {
  const fixture = (v: string, f: string) => readFileSync(join(__dirname, `../../../fixtures/codex/cli/${v}/${f}`), 'utf-8')

  it('the real edit rollouts of both supported versions: two added, one removed', () => {
    for (const v of ['0.153.4', '0.155.1']) {
      const r = parseCodexRollout(fixture(v, 'rollout-edit.jsonl'))
      expect([r.linesAdded, r.linesRemoved]).toEqual([2, 1])
    }
  })

  it('the edit the sandbox refused (0.155.1) and a conversation with no edit: none', () => {
    const refused = parseCodexRollout(fixture('0.155.1', 'rollout-edit-sandbox-refused.jsonl'))
    expect([refused.linesAdded, refused.linesRemoved]).toEqual([0, 0])
    const plain = parseCodexRollout(fixture('0.155.1', 'rollout-exec-then-resume.jsonl'))
    expect([plain.linesAdded, plain.linesRemoved]).toEqual([0, 0])
  })

  it('only an edit that completed counts', () => {
    const iso = new Date().toISOString()
    const noStatus = JSON.parse(editLine(iso)) as { payload: { item: { status?: string } } }
    delete noStatus.payload.item.status
    const lines = [metaLine(ID, '/p', iso), editLine(iso), editLine(iso, undefined, 'failed'), editLine(iso, undefined, 'declined'), editLine(iso, undefined, 'in_progress'), editLine(iso, undefined, null), JSON.stringify(noStatus)]
    const r = parseCodexRollout(lines.join('\n') + '\n')
    expect([r.linesAdded, r.linesRemoved]).toEqual([2, 1])
  })

  it('only a FileChange item counts, and only as an item_completed event', () => {
    const iso = new Date().toISOString()
    const notAnEdit = JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', changes: { '/p/x': { type: 'update', unified_diff: DIFF } }, status: 'completed' } } })
    const started = JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'item_started', item: { type: 'FileChange', changes: { '/p/x': { type: 'update', unified_diff: DIFF } }, status: 'completed' } } })
    const asResponse = JSON.stringify({ timestamp: iso, type: 'response_item', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/p/x': { type: 'update', unified_diff: DIFF } }, status: 'completed' } } })
    const r = parseCodexRollout([metaLine(ID, '/p', iso), notAnEdit, started, asResponse].join('\n') + '\n')
    expect([r.linesAdded, r.linesRemoved]).toEqual([0, 0])
  })
})

describe('a Codex session\'s status line carries its lines changed', () => {
  it('from its first figures (none yet: zero, as Claude Code reports), then each edit as it lands', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const file = join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(ID, '/p/demo', now.toISOString()) + '\n' + tokenLine(now.toISOString(), 5) + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(600)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 5, linesAdded: 0, linesRemoved: 0 })
    appendFileSync(file, editLine(new Date().toISOString()) + '\n' + tokenLine(new Date().toISOString(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 9, linesAdded: 2, linesRemoved: 1 })
    appendFileSync(file, editLine(new Date().toISOString(), { '/p/demo/new.ts': { type: 'add', content: 'a\nb\nc\n' } }) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(updates.at(-1)).toMatchObject({ inputTokens: 9, linesAdded: 5, linesRemoved: 1 })
  })

  it('before its first usage figures too: an update carrying only the account\'s allowance carries them', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const iso = now.toISOString()
    const allowanceOnly = JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }, secondary: null, plan_type: 'pro' } } })
    writeFileSync(join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`), [metaLine(ID, '/p/demo', iso), allowanceOnly, editLine(iso)].join('\n') + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBeUndefined()
    expect(updates.at(-1)?.usageBuckets?.length).toBeGreaterThan(0)
    expect(updates.at(-1)).toMatchObject({ linesAdded: 2, linesRemoved: 1 })
  })

  it('a resumed conversation counts the edits it made before, as Claude Code carries its count across a resume', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const iso = old.toISOString()
    writeFileSync(join(dayOf(sessions, old), `rollout-x-${ID}.jsonl`), [metaLine(ID, '/p/demo', iso), editLine(iso), editLine(iso), tokenLine(iso, 50)].join('\n') + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates.at(-1)).toMatchObject({ inputTokens: 50, linesAdded: 4, linesRemoved: 2 })
  })
})

describe('a large rollout: the edits between its head and its tail', () => {
  /** meta, then three edits spread through the middle, then one in the tail with the newest figures. */
  function large(sessions: string, middleEdits = 3): string {
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    const iso = old.toISOString()
    const file = join(dayOf(sessions, old), `rollout-x-${ID}.jsonl`)
    let body = metaLine(ID, '/p/demo', iso) + '\n' + filler(1024 * 1024)
    for (let i = 0; i < middleEdits; i++) body += editLine(iso) + '\n' + filler(1024 * 1024)
    body += filler(512 * 1024) + editLine(iso) + '\n' + tokenLine(iso, 777) + '\n'
    writeFileSync(file, body)
    expect(body.length).toBeGreaterThan(CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES)
    return file
  }

  it('are counted in the background once it is claimed, and the claim itself still reads only its head and tail', async () => {
    const sessions = realm()
    large(sessions)
    const before = __codexRolloutBytesReadForTests()
    const { updates, src } = watch(sessions, '/p/demo', ID)
    try {
      // The head and tail at once: the tail's edit.
      expect(updates[0]).toMatchObject({ inputTokens: 777, linesAdded: 2, linesRemoved: 1 })
      expect(__codexRolloutBytesReadForTests() - before).toBeLessThanOrEqual(CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES)
      // Then the whole conversation's.
      await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ inputTokens: 777, linesAdded: 8, linesRemoved: 4 }), { timeout: 10_000, interval: 20 })
    } finally {
      src.stop()
    }
  })

  it('a watch stopped before that count finishes says nothing more', async () => {
    const sessions = realm()
    large(sessions)
    const { updates, src } = watch(sessions, '/p/demo', ID)
    src.stop()
    await new Promise((r) => setTimeout(r, 400))
    expect(updates.map((u) => u.linesAdded)).toEqual([2])
  })

  it('a claim let go while that count waits to open the file: it stops without reading any of it', async () => {
    const sessions = realm()
    large(sessions)
    const pickFile = join(sessions, '..', 'pick.json')
    const realOpen = fsPromises.open
    let letOpen!: () => void
    const gate = new Promise<void>((r) => { letOpen = r })
    let opens = 0
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
      if (opens++ === 0) await gate
      return realOpen.apply(fsPromises, args)
    }) as typeof fsPromises.open)
    const updates: StatuslineData[] = []
    let releases = 0
    const src = watchAndClaimRollout('sess-lines', '/p/demo', Date.now(), (d) => updates.push(d), sessions, undefined,
      { pickFile, pickFolder: codexFolderIdentity(dirname(pickFile)) ?? undefined, onRelease: () => { releases++ } })
    try {
      writeFileSync(pickFile, JSON.stringify({ id: ID }))
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 })
      expect(updates[0]).toMatchObject({ linesAdded: 2 })
      expect(opens).toBe(1)
      // The picker decides again: the claim is let go.
      writeFileSync(pickFile, JSON.stringify({ fresh: true }))
      await vi.waitFor(() => expect(releases).toBe(1), { timeout: 5_000, interval: 20 })
      const before = __codexEditCountBytesReadForTests()
      letOpen()
      await new Promise((r) => setTimeout(r, 300))
      expect(__codexEditCountBytesReadForTests()).toBe(before)
      expect(updates.some((u) => u.linesAdded === 8)).toBe(false)
    } finally {
      src.stop()
      spy.mockRestore()
    }
  })
})

describe('countRolloutRange (the background count)', () => {
  function fileWith(lines: string[]): { file: string; text: string } {
    const dir = realm()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'r.jsonl')
    const text = lines.join('\n') + '\n'
    writeFileSync(file, text)
    return { file, text }
  }
  const iso = new Date().toISOString()

  it('counts the edits in whole lines between start and end only', async () => {
    const { file, text } = fileWith([editLine(iso), editLine(iso), editLine(iso)])
    const firstEnd = text.indexOf('\n') + 1
    const lastStart = text.lastIndexOf('\n', text.length - 2) + 1
    expect(await countRolloutRange(file, identityOf(file), firstEnd, lastStart)).toEqual({ added: 2, removed: 1, turnMs: 0 })
    expect(await countRolloutRange(file, identityOf(file), 0, text.length)).toEqual({ added: 6, removed: 3, turnMs: 0 })
    // A last line with no newline before the end is not a whole record.
    expect(await countRolloutRange(file, identityOf(file), 0, text.length - 1)).toEqual({ added: 4, removed: 2, turnMs: 0 })
  })

  it('a line read across several reads counts once', async () => {
    const { file, text } = fileWith([editLine(iso), filler(300).trimEnd(), editLine(iso)])
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => false, { chunkBytes: 7 })).toEqual({ added: 4, removed: 2, turnMs: 0 })
  })

  it('another file at the path: no count', async () => {
    const { file, text } = fileWith([editLine(iso)])
    expect(await countRolloutRange(file, '1:2', 0, text.length)).toBeNull()
  })

  it('no longer wanted part way: no count, and it reads no further', async () => {
    const { file, text } = fileWith([editLine(iso), editLine(iso), editLine(iso)])
    let asks = 0
    const before = __codexEditCountBytesReadForTests()
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => ++asks > 2, { chunkBytes: 64 })).toBeNull()
    expect(__codexEditCountBytesReadForTests() - before).toBe(128)
  })

  it('no longer wanted once the last chunk is read: no count', async () => {
    const { file, text } = fileWith([editLine(iso)])
    let asks = 0
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => ++asks > 1)).toBeNull()
  })

  it('a line with the edit mark is read as an edit; the others are passed over', async () => {
    const { file, text } = fileWith([editLine(iso), tokenLine(iso, 3)])
    expect(await countRolloutRange(file, identityOf(file), 0, text.length)).toEqual({ added: 2, removed: 1, turnMs: 0 })
  })

  it('a line longer than the most it keeps is passed over without being held, and the next line still counts', async () => {
    const big = editLine(iso, { '/p/big.ts': { type: 'add', content: 'y\n'.repeat(400) } })
    const { file, text } = fileWith([big, editLine(iso)])
    __codexEditCountTakeMostHeldForTests()
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => false, { chunkBytes: 50, lineMaxBytes: 400 })).toEqual({ added: 2, removed: 1, turnMs: 0 })
    expect(__codexEditCountTakeMostHeldForTests()).toBeLessThanOrEqual(400)
    // Read in one chunk, the same line is passed over too.
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => false, { lineMaxBytes: 400 })).toEqual({ added: 2, removed: 1, turnMs: 0 })
    expect(await countRolloutRange(file, identityOf(file), 0, text.length, () => false, { chunkBytes: 50, lineMaxBytes: big.length })).toEqual({ added: 402, removed: 1, turnMs: 0 })
  })
})
