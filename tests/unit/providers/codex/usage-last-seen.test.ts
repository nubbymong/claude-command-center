// Codex usage port (usage track MP3): the last-seen reader and the live figure.
//
// The last-seen reader opens only `rollout-*.jsonl` files under the realm's
// own `sessions/YYYY/MM/DD` folders, newest folder then newest name first,
// reads a bounded tail (256 KiB, once growing to 2 MiB), follows no link at
// any level, examines a bounded number of files, and never touches the sign-in
// file or anything else in the realm. The live figure comes from memory only.
//
// PURE: an in-memory filesystem port records every call; no real file is
// read and no process is started.
import { describe, it, expect } from 'vitest'
import {
  readLastSeenAllowance, createCodexLiveUsage, createCodexUsageOperations,
  CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES, CODEX_USAGE_MAX_FILES,
} from '../../../../src/main/providers/codex/usage'
import type { CodexUsageFsPort } from '../../../../src/main/providers/codex/usage'
import { CODEX_DEFAULT_LIMIT_ID } from '../../../../src/main/providers/codex/rate-limits'
import type { AllowanceReading } from '../../../../src/shared/usage-types'

const SESSIONS = 'C:\\Users\\u\\.codex\\sessions'
const S = (iso: string) => Math.floor(Date.parse(iso) / 1000)

/** A Windows-shaped in-memory tree: folders, files and links, every call logged. */
function fakeFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const dirs = new Set<string>()
  const files = new Map<string, Buffer>()
  const links = new Set<string>()
  const calls: string[] = []
  // Each entry's name as it was created (lookups are case-insensitive).
  const spelled = new Map<string, string>()
  const remember = (p: string) => { const s = p.replace(/[\\/]+$/, ''); spelled.set(norm(s), s.split('\\').pop()!) }
  const parent = (p: string) => norm(p).split('\\').slice(0, -1).join('\\')
  const addDir = (p: string) => {
    const parts = p.replace(/[\\/]+$/, '').split('\\')
    for (let i = 1; i <= parts.length; i++) { const d = parts.slice(0, i).join('\\'); dirs.add(norm(d)); remember(d) }
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const port: CodexUsageFsPort = {
    platform: 'win32',
    lstat: (p) => {
      calls.push(`lstat ${p}`)
      const n = norm(p)
      if (links.has(n)) return { kind: 'link' }
      if (dirs.has(n)) return { kind: 'dir' }
      if (files.has(n)) return { kind: 'file' }
      throw err('ENOENT')
    },
    readdir: (dir) => {
      calls.push(`readdir ${dir}`)
      const n = norm(dir)
      if (links.has(n)) throw err('ELOOP')
      if (!dirs.has(n)) throw err('ENOENT')
      const names = new Set<string>()
      for (const x of [...dirs, ...files.keys(), ...links]) if (parent(x) === n) names.add(spelled.get(x) ?? x.slice(n.length + 1))
      return [...names]
    },
    readTail: (file, maxBytes) => {
      calls.push(`readTail ${file} ${maxBytes}`)
      const n = norm(file)
      if (links.has(n)) throw err('ELOOP')
      const b = files.get(n)
      if (!b) throw err('ENOENT')
      const len = Math.min(b.length, maxBytes)
      return { text: b.subarray(b.length - len).toString('utf8'), whole: len === b.length }
    },
  }
  return {
    port, calls,
    file: (p: string, text: string) => { addDir(p.split('\\').slice(0, -1).join('\\')); files.set(norm(p), Buffer.from(text, 'utf8')); remember(p) },
    dir: (p: string) => addDir(p),
    link: (p: string) => { addDir(p.split('\\').slice(0, -1).join('\\')); links.add(norm(p)); remember(p) },
    reads: () => calls.filter((c) => c.startsWith('readTail ')),
  }
}

const meta = (ts: string) => JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'anon', cwd: '/anon', cli_version: '0.155.1' } })
const tokenCount = (ts: string, rateLimits: unknown, info: unknown = null) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: rateLimits } })
const limits = (pct: number, over: Record<string, unknown> = {}) => ({ limit_id: CODEX_DEFAULT_LIMIT_ID, primary: { used_percent: pct, window_minutes: 300 }, secondary: { used_percent: pct + 1, window_minutes: 10080 }, plan_type: 'plus', ...over })
const rollout = (...lines: string[]) => lines.join('\n') + '\n'
const day = (y: string, m: string, d: string) => `${SESSIONS}\\${y}\\${m}\\${d}`
const pct = (r: AllowanceReading | null) => r?.limits[0]?.primary?.usedPercent

describe('readLastSeenAllowance: which rollout', () => {
  it('reads the newest day folder first, then the newest file name in it', () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '26')}\\rollout-2026-09-26T10-00-00-a.jsonl`, rollout(meta('2026-09-26T10:00:00Z'), tokenCount('2026-09-26T10:00:01Z', limits(10))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-b.jsonl`, rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T08:00:01Z', limits(20))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-c.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(30))))
    const r = readLastSeenAllowance(SESSIONS, f.port)
    expect(pct(r)).toBe(30)
    expect(r!.readingAt).toBe(Date.parse('2026-09-27T09:00:01Z'))
    expect(f.reads()).toEqual([`readTail ${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-c.jsonl ${CODEX_USAGE_TAIL_BYTES}`])
  })

  it('orders years, months and days numerically newest first across a year boundary', () => {
    const f = fakeFs()
    f.file(`${day('2025', '12', '31')}\\rollout-2025-12-31T23-00-00-a.jsonl`, rollout(meta('2025-12-31T23:00:00Z'), tokenCount('2025-12-31T23:00:01Z', limits(11))))
    f.file(`${day('2026', '01', '01')}\\rollout-2026-01-01T00-10-00-b.jsonl`, rollout(meta('2026-01-01T00:10:00Z'), tokenCount('2026-01-01T00:10:01Z', limits(12))))
    expect(pct(readLastSeenAllowance(SESSIONS, f.port))).toBe(12)
  })

  it('falls back to an older rollout when the newest has no allowance yet', () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-a.jsonl`, rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T08:00:01Z', limits(40))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-b.jsonl`, rollout(meta('2026-09-27T09:00:00Z')))
    expect(pct(readLastSeenAllowance(SESSIONS, f.port))).toBe(40)
  })

  it('counts a pre-response token_count (info null) and keeps the newest reading of each limit in the tail', () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(
      meta('2026-09-27T09:00:00Z'),
      tokenCount('2026-09-27T09:00:01Z', limits(5)),
      tokenCount('2026-09-27T09:00:02Z', { limit_id: 'codex_spark', limit_name: 'Spark', primary: { used_percent: 3, window_minutes: 300 } }, { total_token_usage: { input_tokens: 1 } }),
    ))
    const r = readLastSeenAllowance(SESSIONS, f.port)!
    expect(r.limits.map((l) => [l.limitId, l.primary?.usedPercent])).toEqual([['codex', 5], ['codex_spark', 3]])
    expect(r.planType).toBe('plus')
  })

  it('is null for no sessions folder, an empty one, or rollouts with no allowance at all', () => {
    expect(readLastSeenAllowance(SESSIONS, fakeFs().port)).toBeNull()
    const f = fakeFs()
    f.dir(SESSIONS)
    expect(readLastSeenAllowance(SESSIONS, f.port)).toBeNull()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', null)))
    expect(readLastSeenAllowance(SESSIONS, f.port)).toBeNull()
  })

  it('never throws: a failing port reads as no reading', () => {
    const broken: CodexUsageFsPort = { platform: 'win32', lstat: () => { throw new Error('EIO') }, readdir: () => { throw new Error('EIO') }, readTail: () => { throw new Error('EIO') } }
    expect(readLastSeenAllowance(SESSIONS, broken)).toBeNull()
  })
})

describe('readLastSeenAllowance: what it may open', () => {
  it('opens only rollout-*.jsonl files under sessions/YYYY/MM/DD, never the sign-in file or anything else', () => {
    const f = fakeFs()
    const home = 'C:\\Users\\u\\.codex'
    f.file(`${home}\\auth.json`, '{"tokens":"x"}')
    f.file(`${home}\\config.toml`, 'x')
    f.file(`${SESSIONS}\\auth.json`, '{}')
    f.file(`${SESSIONS}\\rollout-2026-09-27T09-00-00-top.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(99))))
    f.file(`${SESSIONS}\\2026\\rollout-2026-09-27T09-00-00-year.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(98))))
    f.file(`${day('2026', '09', '27')}\\auth.json`, '{}')
    f.file(`${day('2026', '09', '27')}\\notes.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(97))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.json`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(96))))
    f.file(`${SESSIONS}\\archive\\09\\27\\rollout-2026-09-27T09-00-00-x.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(95))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-ok.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(7))))
    expect(pct(readLastSeenAllowance(SESSIONS, f.port))).toBe(7)
    for (const c of f.calls) expect(c.toLowerCase(), c).not.toContain('auth.json')
    for (const r of f.reads()) expect(r).toMatch(/\\sessions\\\d{4}\\\d{2}\\\d{2}\\rollout-[^\\]+\.jsonl \d+$/)
  })

  it('follows no link: not the sessions folder, a year, month or day folder, or a rollout', () => {
    const linkedRoot = fakeFs()
    linkedRoot.link(SESSIONS)
    expect(readLastSeenAllowance(SESSIONS, linkedRoot.port)).toBeNull()
    expect(linkedRoot.calls.filter((c) => c.startsWith('readdir') || c.startsWith('readTail'))).toEqual([])

    const f = fakeFs()
    f.link(`${SESSIONS}\\2027`)
    f.link(`${SESSIONS}\\2026\\10`)
    f.link(`${day('2026', '09', '28')}`)
    f.link(`${day('2026', '09', '27')}\\rollout-2026-09-27T10-00-00-link.jsonl`)
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-real.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(8))))
    expect(pct(readLastSeenAllowance(SESSIONS, f.port))).toBe(8)
    expect(f.reads()).toEqual([`readTail ${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-real.jsonl ${CODEX_USAGE_TAIL_BYTES}`])
    expect(f.calls.some((c) => /readdir .*(2027|\\10|\\28)$/.test(c))).toBe(false)
  })

  it('reads a 256 KiB tail, grows once to 2 MiB when the allowance is further back, and never past it', () => {
    const filler = JSON.stringify({ timestamp: '2026-09-27T09:00:02Z', type: 'response_item', payload: { text: 'x'.repeat(1000) } })
    const f = fakeFs()
    const near = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-near.jsonl`
    f.file(near, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(21)), ...Array(400).fill(filler)))
    expect(pct(readLastSeenAllowance(SESSIONS, f.port))).toBe(21)
    expect(f.reads()).toEqual([`readTail ${near} ${CODEX_USAGE_TAIL_BYTES}`, `readTail ${near} ${CODEX_USAGE_TAIL_MAX_BYTES}`])

    const g = fakeFs()
    const far = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-far.jsonl`
    g.file(far, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(22)), ...Array(2300).fill(filler)))
    expect(readLastSeenAllowance(SESSIONS, g.port)).toBeNull()
    expect(g.reads()).toEqual([`readTail ${far} ${CODEX_USAGE_TAIL_BYTES}`, `readTail ${far} ${CODEX_USAGE_TAIL_MAX_BYTES}`])
  })

  it('ignores the cut first line of a tail and any line that is not JSON', () => {
    const filler = JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(1000) } })
    const f = fakeFs()
    // Invalid as a whole line, but its end alone parses as a token_count of
    // another limit: the 256 KiB window starts inside its run of spaces, so a
    // reader that kept the cut first line would report that limit.
    const cut = '{"broken":' + ' '.repeat(200_000) + tokenCount('2026-09-27T09:00:01Z', limits(77, { limit_id: 'codex_cut' }))
    const rest = rollout(...Array(96).fill(filler), 'not json {', tokenCount('2026-09-27T09:00:05Z', limits(23)))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, cut + '\n' + rest)
    const r = readLastSeenAllowance(SESSIONS, f.port)!
    expect(r.limits.map((l) => [l.limitId, l.primary?.usedPercent])).toEqual([['codex', 23]])
    expect(f.reads()).toHaveLength(1)
  })

  it(`examines at most ${CODEX_USAGE_MAX_FILES} rollouts`, () => {
    const f = fakeFs()
    for (let i = 0; i < 20; i++) f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-${String(i).padStart(2, '0')}-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z')))
    expect(readLastSeenAllowance(SESSIONS, f.port)).toBeNull()
    expect(new Set(f.reads().map((r) => r.split(' ')[1])).size).toBe(CODEX_USAGE_MAX_FILES)
  })
})

describe('the live figure (memory only)', () => {
  const reading = (p: number, at: number): AllowanceReading => ({ limits: [{ limitId: 'codex', limitName: null, primary: { windowMinutes: 300, usedPercent: p, resetsAt: null }, secondary: null }], planType: 'pro', readingAt: at })

  it('keeps the newest reading per sessions folder, named the same however it is spelled on Windows', () => {
    const live = createCodexLiveUsage('win32')
    live.record(`${SESSIONS}\\`, reading(10, 2000))
    live.record(SESSIONS.toUpperCase(), reading(5, 1000))
    expect(live.get(SESSIONS)?.limits[0].primary?.usedPercent).toBe(10)
    live.record(SESSIONS, reading(12, 3000))
    expect(live.get(SESSIONS.toLowerCase())?.limits[0].primary?.usedPercent).toBe(12)
    expect(live.get('C:\\Users\\u\\other\\sessions')).toBeNull()
  })

  it('keeps every realm apart and stays bounded', () => {
    const live = createCodexLiveUsage('linux')
    for (let i = 0; i < 200; i++) live.record(`/r/${i}/sessions`, reading(i % 100, i))
    expect(live.get('/r/199/sessions')?.limits[0].primary?.usedPercent).toBe(99)
    expect(live.get('/r/0/sessions')).toBeNull()
    // Case matters off Windows and macOS.
    live.record('/R/x/sessions', reading(1, 1))
    expect(live.get('/r/x/sessions')).toBeNull()
  })
})

describe('createCodexUsageOperations', () => {
  const realm = { authRealmId: 'realm-' + '1'.repeat(32) }

  it('live reads memory only; last-seen reads the realm\'s own folder; both give buckets, reading time and plan label', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33, { plan_type: 'pro' }))))
    const live = createCodexLiveUsage('win32')
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live })
    expect(await ops.live(realm)).toBeNull()
    expect(f.calls).toEqual([])
    live.record(SESSIONS, { limits: [{ limitId: 'codex', limitName: null, primary: { windowMinutes: 300, usedPercent: 44, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 5 })
    expect(await ops.live(realm)).toEqual({ buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent: 44, resetsAt: '', severity: 'normal' }], readingAt: 5, planLabel: 'Plus' })
    expect(f.calls).toEqual([])
    const seen = await ops.lastSeen(realm)
    expect(seen?.buckets.map((b) => [b.label, b.percent])).toEqual([['5h', 33], ['Weekly', 34]])
    expect(seen?.planLabel).toBe('Pro')
    expect(seen?.readingAt).toBe(Date.parse('2026-09-27T09:00:01Z'))
  })

  it('a realm that cannot be located reads nothing', async () => {
    const f = fakeFs()
    const ops = createCodexUsageOperations({ sessionsDir: async () => null, fs: f.port, live: createCodexLiveUsage('win32') })
    expect(await ops.lastSeen(realm)).toBeNull()
    expect(await ops.live(realm)).toBeNull()
    expect(f.calls).toEqual([])
    const throwing = createCodexUsageOperations({ sessionsDir: async () => { throw new Error('x') }, fs: f.port, live: createCodexLiveUsage('win32') })
    expect(await throwing.lastSeen(realm)).toBeNull()
    expect(await throwing.live(realm)).toBeNull()
  })
})
