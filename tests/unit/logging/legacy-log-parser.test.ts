/**
 * Pure unit test (system Node) for the legacy log parser. Builds a fixture tree
 * under mkdtemp that mirrors the real on-disk format, then asserts deterministic
 * parsing, partner-fold, rotation ordering, and unparseable-file collection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseLegacyLogs } from '../../../src/main/logging/legacy-log-parser'

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

  it('parses a single session into ordered events with meta', () => {
    makeSession(
      'APP_DEV',
      's1',
      { 'session.jsonl': line({ ts: 10, type: 'start' }) + line({ ts: 11, type: 'data', data: 'hello' }) + line({ ts: 12, type: 'end' }) },
      { configLabel: 'APP DEV', accountEmail: 'a@b.com', profileId: 'p1' },
    )

    const { sessions, unparseable } = parseLegacyLogs(logsDir)
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

  it('falls back to the sanitized dir label when meta.json is absent', () => {
    makeSession('NO_META', 's2', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'x' }) })
    const { sessions } = parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's2')!
    expect(s.configLabel).toBe('NO_META')
  })

  it('orders rotated files oldest-first then session.jsonl last', () => {
    makeSession('R', 's3', {
      'session.jsonl': line({ ts: 100, type: 'data', data: 'newest' }),
      'session.jsonl.1': line({ ts: 90, type: 'data', data: 'mid' }),
      'session.jsonl.2': line({ ts: 80, type: 'data', data: 'oldest' }),
    })
    const { sessions } = parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's3')!
    // .2 (oldest) -> .1 -> session.jsonl (newest)
    expect(s.events.map((e) => e.data)).toEqual(['oldest', 'mid', 'newest'])
    expect(s.startedAt).toBe(80)
  })

  it('folds <id>-partner into the base session, appended after base events', () => {
    makeSession('P', 's4', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    makeSession('P', 's4-partner', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'partner' }) })
    const { sessions, foldedPartnerDirs } = parseLegacyLogs(logsDir)
    // Exactly one logical session s4 (partner folded in), no separate s4-partner.
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s4'])
    const s = sessions.find((x) => x.sessionId === 's4')!
    expect(s.events.map((e) => e.data)).toEqual(['base', 'partner'])
    // The partner dir folded into the base counts toward reconciliation.
    expect(foldedPartnerDirs).toBe(1)
  })

  it('reports foldedPartnerDirs === 0 when no partner/duplicate folders exist', () => {
    makeSession('A', 's1', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    makeSession('B', 's2', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'b' }) })
    const { foldedPartnerDirs } = parseLegacyLogs(logsDir)
    expect(foldedPartnerDirs).toBe(0)
  })

  it('does NOT count a 0-event partner dir as folded (it is unparseable instead)', () => {
    makeSession('P', 's8', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'base' }) })
    // Partner dir with no valid events -> reported unparseable, NOT folded.
    makeSession('P', 's8-partner', { 'session.jsonl': 'garbage\n' })
    const { sessions, unparseable, foldedPartnerDirs } = parseLegacyLogs(logsDir)
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s8'])
    expect(foldedPartnerDirs).toBe(0)
    expect(unparseable.some((u) => u.path.includes('s8-partner'))).toBe(true)
  })

  it('collects unparseable / malformed-line files instead of dropping silently', () => {
    // A session whose only file has nothing but a corrupt line -> 0 valid events.
    makeSession('BAD', 's5', { 'session.jsonl': 'this is not json\n{also bad\n' })
    // A good session alongside it must still import.
    makeSession('OK', 's6', { 'session.jsonl': line({ ts: 5, type: 'data', data: 'ok' }) })

    const { sessions, unparseable } = parseLegacyLogs(logsDir)
    expect(sessions.map((s) => s.sessionId)).toContain('s6')
    expect(sessions.map((s) => s.sessionId)).not.toContain('s5')
    // s5's file is listed (path + reason), never thrown away.
    expect(unparseable.length).toBeGreaterThan(0)
    expect(unparseable.some((u) => u.path.includes('s5'))).toBe(true)
  })

  it('skips malformed lines within an otherwise-valid file and records the skip count', () => {
    makeSession('MIX', 's7', {
      'session.jsonl': line({ ts: 1, type: 'data', data: 'good1' }) + 'garbage line\n' + line({ ts: 2, type: 'data', data: 'good2' }),
    })
    const { sessions, unparseable } = parseLegacyLogs(logsDir)
    const s = sessions.find((x) => x.sessionId === 's7')!
    expect(s.events.map((e) => e.data)).toEqual(['good1', 'good2'])
    // The file is reported as having skipped lines (partial), but still imported.
    expect(unparseable.some((u) => u.path.includes('s7') && u.skippedLines === 1)).toBe(true)
  })

  it('is deterministic: two runs yield identical session ordering', () => {
    makeSession('Z', 'b', { 'session.jsonl': line({ ts: 2, type: 'data', data: 'b' }) })
    makeSession('A', 'a', { 'session.jsonl': line({ ts: 1, type: 'data', data: 'a' }) })
    const r1 = parseLegacyLogs(logsDir).sessions.map((s) => s.sessionId)
    const r2 = parseLegacyLogs(logsDir).sessions.map((s) => s.sessionId)
    expect(r1).toEqual(r2)
    expect(r1).toEqual(['a', 'b']) // pinned: final order is lexicographic by sessionId
  })

  it('returns empty result for a missing logs dir', () => {
    const { sessions, unparseable, foldedPartnerDirs } = parseLegacyLogs(join(root, 'does-not-exist'))
    expect(sessions).toEqual([])
    expect(unparseable).toEqual([])
    expect(foldedPartnerDirs).toBe(0)
  })
})
