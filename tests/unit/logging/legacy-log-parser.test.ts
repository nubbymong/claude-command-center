/**
 * Pure unit test (system Node) for the legacy log parser. Builds a fixture tree
 * under mkdtemp that mirrors the real on-disk format, then asserts deterministic
 * parsing, partner-fold, rotation ordering, and unparseable-file collection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseLegacyLogs, planLegacyGroups, streamGroup } from '../../../src/main/logging/legacy-log-parser'
import type { GroupStreamMsg } from '../../../src/main/logging/legacy-log-parser'

let logsDir: string
let root: string

function line(o: object): string {
  return JSON.stringify(o) + '\n'
}

function makeSession(label: string, id: string, files: Record<string, string>, meta?: object) {
  const dir = join(logsDir, label, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  if (meta) writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
}

describe('legacy-log-parser', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacyparse-'))
    logsDir = join(root, 'logs')
    mkdirSync(logsDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('parses a single session into ordered events with meta', async () => {
    makeSession(
      'APP_DEV',
      's1',
      { 'session.jsonl': line({ ts: 10, type: 'start' }) + line({ ts: 11, type: 'data', data: 'hello' }) + line({ ts: 12, type: 'end' }) },
      { configLabel: 'APP DEV', accountEmail: 'a@b.com', profileId: 'p1' },
    )

    const { sessions, unparseable } = await parseLegacyLogs(logsDir)
    expect(unparseable).toEqual([])
    expect(sessions.length).toBe(1)
    const s = sessions[0]
    expect(s.sessionId).toBe('s1')
    expect(s.configLabel).toBe('APP DEV') // from meta.json, not the sanitized dir name
    expect(s.accountEmail).toBe('a@b.com')
    expect(s.profileId).toBe('p1')
    expect(s.provider).toBe('claude') // defaulted (not on disk)
    expect(s.startedAt).toBe(10)
    expect(s.events.map((e) => e.type)).toEqual(['start', 'data', 'end'])
    expect(s.events[1].data).toBe('hello')
  })

  it('falls back to the sanitized dir label when meta.json is absent', async () => {
    makeSession('NO_META', 's2', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'x' }) })
    const { sessions } = await parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's2')!
    expect(s.configLabel).toBe('NO_META')
  })

  it('orders rotated files oldest-first then session.jsonl last', async () => {
    makeSession('R', 's3', {
      'session.jsonl': line({ ts: 100, type: 'data', data: 'newest' }),
      'session.jsonl.1': line({ ts: 90, type: 'data', data: 'mid' }),
      'session.jsonl.2': line({ ts: 80, type: 'data', data: 'oldest' }),
    })
    const { sessions } = await parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's3')!
    // .2 (oldest) -> .1 -> session.jsonl (newest)
    expect(s.events.map((e) => e.data)).toEqual(['oldest', 'mid', 'newest'])
    expect(s.startedAt).toBe(80)
  })

  it('folds <id>-partner into the base session, appended after base events', async () => {
    makeSession('P', 's4', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    makeSession('P', 's4-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'partner' }) })
    const { sessions, foldedPartnerDirs, noEventDirs } = await parseLegacyLogs(logsDir)
    // Exactly one logical session s4 (partner folded in), no separate s4-partner.
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s4'])
    const s = sessions.find((x) => x.sessionId === 's4')!
    expect(s.events.map((e) => e.data)).toEqual(['base', 'partner'])
    // The partner dir folded into the base counts toward reconciliation.
    expect(foldedPartnerDirs).toBe(1)
    expect(noEventDirs).toBe(0)
  })

  it('reports foldedPartnerDirs === 0 when no partner/duplicate folders exist', async () => {
    makeSession('A', 's1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    makeSession('B', 's2', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'b' }) })
    const { foldedPartnerDirs, noEventDirs } = await parseLegacyLogs(logsDir)
    expect(foldedPartnerDirs).toBe(0)
    expect(noEventDirs).toBe(0)
  })

  it('does NOT count a 0-event partner dir as folded (it is unparseable instead)', async () => {
    makeSession('P', 's8', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    // Partner dir with no valid events -> reported unparseable, NOT folded.
    makeSession('P', 's8-partner', { 'session.jsonl': 'garbage\n' })
    const { sessions, unparseable, foldedPartnerDirs } = await parseLegacyLogs(logsDir)
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s8'])
    expect(foldedPartnerDirs).toBe(0)
    expect(unparseable.some((u) => u.path.includes('s8-partner'))).toBe(true)
  })

  it('collects unparseable / malformed-line files instead of dropping silently', async () => {
    // A session whose only file has nothing but a corrupt line -> 0 valid events.
    makeSession('BAD', 's5', { 'session.jsonl': 'this is not json\n{also bad\n' })
    // A good session alongside it must still import.
    makeSession('OK', 's6', { 'session.jsonl': line({ ts: 5, type: 'data', data: 'ok' }) })

    const { sessions, unparseable, noEventDirs } = await parseLegacyLogs(logsDir)
    expect(sessions.map((s) => s.sessionId)).toContain('s6')
    expect(sessions.map((s) => s.sessionId)).not.toContain('s5')
    // s5's file is listed (path + reason), never thrown away.
    expect(unparseable.length).toBeGreaterThan(0)
    expect(unparseable.some((u) => u.path.includes('s5'))).toBe(true)
    // s5 has all-malformed files -> counts as noEventDirs; s6 is valid -> not counted.
    // Key: noEventDirs is incremented unconditionally even when file-level unparseable
    // entries suppress the dir-level 'no parseable events' entry (the s5 case).
    expect(noEventDirs).toBe(1)
  })

  it('skips malformed lines within an otherwise-valid file and records the skip count', async () => {
    makeSession('MIX', 's7', {
      'session.jsonl': line({ ts: 1, type: 'data', data: 'good1' }) + 'garbage line\n' + line({ ts: 2, type: 'data', data: 'good2' }),
    })
    const { sessions, unparseable } = await parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's7')!
    expect(s.events.map((e) => e.data)).toEqual(['good1', 'good2'])
    // The file is reported as having skipped lines (partial), but still imported.
    expect(unparseable.some((u) => u.path.includes('s7') && u.skippedLines === 1)).toBe(true)
  })

  it('is deterministic: two runs yield identical session ordering', async () => {
    makeSession('Z', 'b', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'b' }) })
    makeSession('A', 'a', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    const r1 = (await parseLegacyLogs(logsDir)).sessions.map((s) => s.sessionId)
    const r2 = (await parseLegacyLogs(logsDir)).sessions.map((s) => s.sessionId)
    expect(r1).toEqual(r2)
    expect(r1).toEqual(['a', 'b']) // pinned: final order is lexicographic by sessionId
  })

  it('reconciliation identity: detectedFolders === sessions + foldedPartnerDirs + noEventDirs', async () => {
    // 1 valid session, 1 partner fold (2 dirs -> 1 session), 1 all-malformed dir.
    makeSession('VALID', 'v1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'ok' }) })
    makeSession('VALID', 'v1-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'ok2' }) })
    makeSession('VALID', 'v2', { 'session.jsonl': line({ ts: 3, type: 'data', data: 'ok3' }) })
    makeSession('BAD', 'bad1', { 'session.jsonl': 'not json at all\n' })
    // Folder count: v1 + v1-partner + v2 + bad1 = 4 dirs total.
    const detectedFolders = 4
    const { sessions, foldedPartnerDirs, noEventDirs } = await parseLegacyLogs(logsDir)
    // v1 + v1-partner fold into 1 session; v2 is a separate session -> 2 sessions total.
    expect(sessions.length).toBe(2)
    expect(foldedPartnerDirs).toBe(1)
    expect(noEventDirs).toBe(1)
    // The identity must hold.
    expect(sessions.length + foldedPartnerDirs + noEventDirs).toBe(detectedFolders)
  })

  it('returns empty result for a missing logs dir', async () => {
    const { sessions, unparseable, foldedPartnerDirs, noEventDirs } = await parseLegacyLogs(join(root, 'does-not-exist'))
    expect(sessions).toEqual([])
    expect(unparseable).toEqual([])
    expect(foldedPartnerDirs).toBe(0)
    expect(noEventDirs).toBe(0)
  })
})

// ── Streaming API (the fix for the 16GB main-thread freeze) ──────────────────
// planLegacyGroups = readdir-only pre-pass; streamGroup = one group at a time,
// events in bounded batches. parseLegacyLogs above is a thin wrapper over these,
// so the legacy describe block doubles as the semantic-equivalence proof.

async function drain(g: AsyncGenerator<GroupStreamMsg>): Promise<GroupStreamMsg[]> {
  const out: GroupStreamMsg[] = []
  for await (const m of g) out.push(m)
  return out
}

describe('planLegacyGroups', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacyplan-'))
    logsDir = join(root, 'logs')
    mkdirSync(logsDir, { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('groups a base dir with its -partner dir under one baseId, members in walk order', () => {
    makeSession('P', 's4', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    makeSession('P', 's4-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'p' }) })
    const groups = planLegacyGroups(logsDir)
    expect(groups.length).toBe(1)
    expect(groups[0].baseId).toBe('s4')
    expect(groups[0].members.map((m) => m.dirPath.endsWith('s4-partner'))).toEqual([false, true])
  })

  it('groups the same baseId across DIFFERENT labels (cross-label duplicate)', () => {
    makeSession('A_LBL', 'dup', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    makeSession('Z_LBL', 'dup', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'z' }) })
    const groups = planLegacyGroups(logsDir)
    expect(groups.length).toBe(1)
    expect(groups[0].members.length).toBe(2)
    // Walk order: A_LBL before Z_LBL.
    expect(groups[0].members[0].label).toBe('A_LBL')
  })

  it('returns groups sorted by baseId and ignores plain files at both levels', () => {
    makeSession('L', 'b', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'b' }) })
    makeSession('L', 'a', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    writeFileSync(join(logsDir, 'stray.txt'), 'x')
    writeFileSync(join(logsDir, 'L', 'stray2.txt'), 'x')
    const groups = planLegacyGroups(logsDir)
    expect(groups.map((g) => g.baseId)).toEqual(['a', 'b'])
  })

  it('returns [] for a missing dir', () => {
    expect(planLegacyGroups(join(root, 'nope'))).toEqual([])
  })
})

describe('streamGroup', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacystream-'))
    logsDir = join(root, 'logs')
    mkdirSync(logsDir, { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('emits meta (from the first member with events), event batches, then group-done with tallies', async () => {
    makeSession('S', 'g1', { 'session.jsonl': line({ ts: 5, type: 'start' }) + line({ ts: 6, type: 'data', data: 'hi' }) },
      { configLabel: 'Streamy', accountEmail: 'a@b.com' })
    const [g] = planLegacyGroups(logsDir)
    const msgs = await drain(streamGroup(g))
    expect(msgs[0].kind).toBe('meta')
    const meta = msgs[0] as Extract<GroupStreamMsg, { kind: 'meta' }>
    expect(meta.meta.sessionId).toBe('g1')
    expect(meta.meta.configLabel).toBe('Streamy')
    expect(meta.meta.accountEmail).toBe('a@b.com')
    expect(meta.firstTs).toBe(5) // ts of the first valid event — begin-time startedAt for the DB row
    const evMsgs = msgs.filter((m) => m.kind === 'events') as Extract<GroupStreamMsg, { kind: 'events' }>[]
    expect(evMsgs.flatMap((m) => m.events.map((e) => e.type))).toEqual(['start', 'data'])
    const done = msgs[msgs.length - 1] as Extract<GroupStreamMsg, { kind: 'group-done' }>
    expect(done.kind).toBe('group-done')
    expect(done.hadEvents).toBe(true)
    expect(done.minTs).toBe(5)
    expect(done.maxTs).toBe(6)
    expect(done.eventCount).toBe(2)
    expect(done.unparseable).toEqual([])
    expect(done.foldedPartnerDirs).toBe(0)
    expect(done.noEventDirs).toBe(0)
  })

  it('splits events into batches bounded by batchBytes', async () => {
    const big = 'x'.repeat(1000)
    let content = ''
    for (let i = 0; i < 10; i++) content += line({ ts: i, type: 'data', data: big })
    makeSession('S', 'g2', { 'session.jsonl': content })
    const [g] = planLegacyGroups(logsDir)
    const msgs = await drain(streamGroup(g, 2500)) // ~2 events per batch
    const evMsgs = msgs.filter((m) => m.kind === 'events') as Extract<GroupStreamMsg, { kind: 'events' }>[]
    expect(evMsgs.length).toBeGreaterThanOrEqual(4)
    for (const m of evMsgs) expect(m.events.length).toBeLessThanOrEqual(3)
    expect(evMsgs.reduce((n, m) => n + m.events.length, 0)).toBe(10)
  })

  it('a fully-malformed group: no meta, group-done has hadEvents=false + noEventDirs + unparseable', async () => {
    makeSession('S', 'g3', { 'session.jsonl': 'not json\n' })
    const [g] = planLegacyGroups(logsDir)
    const msgs = await drain(streamGroup(g))
    expect(msgs.some((m) => m.kind === 'meta')).toBe(false)
    const done = msgs[msgs.length - 1] as Extract<GroupStreamMsg, { kind: 'group-done' }>
    expect(done.hadEvents).toBe(false)
    expect(done.noEventDirs).toBe(1)
    expect(done.unparseable.some((u) => u.path.includes('g3'))).toBe(true)
  })

  it('folds a partner member: events append after base, foldedPartnerDirs=1, meta from base', async () => {
    makeSession('S', 'g4', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) }, { configLabel: 'BaseLbl' })
    makeSession('S', 'g4-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'partner' }) }, { configLabel: 'PartnerLbl' })
    const [g] = planLegacyGroups(logsDir)
    const msgs = await drain(streamGroup(g))
    const meta = msgs.find((m) => m.kind === 'meta') as Extract<GroupStreamMsg, { kind: 'meta' }>
    expect(meta.meta.configLabel).toBe('BaseLbl')
    const evs = (msgs.filter((m) => m.kind === 'events') as Extract<GroupStreamMsg, { kind: 'events' }>[]).flatMap((m) => m.events)
    expect(evs.map((e) => e.data)).toEqual(['base', 'partner'])
    const done = msgs[msgs.length - 1] as Extract<GroupStreamMsg, { kind: 'group-done' }>
    expect(done.foldedPartnerDirs).toBe(1)
    expect(done.minTs).toBe(1)
    expect(done.maxTs).toBe(2)
  })

  it('a 0-event partner member is NOT folded (counts as noEventDirs + unparseable)', async () => {
    makeSession('S', 'g5', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    makeSession('S', 'g5-partner', { 'session.jsonl': 'garbage\n' })
    const [g] = planLegacyGroups(logsDir)
    const msgs = await drain(streamGroup(g))
    const done = msgs[msgs.length - 1] as Extract<GroupStreamMsg, { kind: 'group-done' }>
    expect(done.hadEvents).toBe(true)
    expect(done.foldedPartnerDirs).toBe(0)
    expect(done.noEventDirs).toBe(1)
    expect(done.unparseable.some((u) => u.path.includes('g5-partner'))).toBe(true)
  })
})
