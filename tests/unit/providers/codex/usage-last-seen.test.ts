// Codex usage port (usage track MP3): the last-seen reader and the live figure.
//
// The last-seen reader opens only `rollout-*.jsonl` files under the realm's
// own `sessions/YYYY/MM/DD` folders, newest folder then newest name first.
// Below the realm home (whose own path the launch's canonical-home check
// proves link-free) it follows no link: the sessions folder and every year,
// month and day folder are checked with lstat before they are listed and
// again, by device and inode, after; every rollout is checked with lstat
// before it is opened and again, by device and inode, after (a regular file
// with one link only). It reads a bounded tail (256 KiB, once growing to
// 2 MiB), examines at most CODEX_USAGE_MAX_FILES rollouts and takes the one
// whose allowance was reported last, keeps the whole walk inside one budget of
// folder visits and entries (and at most 64 day folders), and never touches
// the sign-in file or anything else in the realm. The live figure comes from
// memory only and is forgotten when the realm's last session stops.
//
// PURE: an in-memory filesystem port records every call (the real port is
// driven through an injected fs api); no real file is read and no process is
// started.
import { describe, it, expect } from 'vitest'
import {
  readLastSeenAllowance, createCodexLiveUsage, createCodexUsageOperations, realCodexUsageFsPort,
  CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES, CODEX_USAGE_MAX_FILES, CODEX_USAGE_WALK_BUDGET, CODEX_USAGE_MAX_DAYS,
} from '../../../../src/main/providers/codex/usage'
import type { CodexUsageFsPort, CodexUsageEntry, CodexUsageFsApi } from '../../../../src/main/providers/codex/usage'
import { CODEX_DEFAULT_LIMIT_ID } from '../../../../src/main/providers/codex/rate-limits'
import type { AllowanceReading } from '../../../../src/shared/usage-types'

const SESSIONS = 'C:\\Users\\u\\.codex\\sessions'

interface FakeNode { kind: 'file' | 'dir' | 'link' | 'other'; ino: number; nlink: number; mtimeMs: number; data?: Buffer }

/** A Windows-shaped in-memory tree: folders, files, links and other things,
 *  every call logged. `afterList` runs after a folder is listed (to swap
 *  something in the gap). */
function fakeFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const nodes = new Map<string, FakeNode>()
  const spelled = new Map<string, string>()
  const calls: string[] = []
  const listed = { entries: 0 }
  let seq = 0
  const hooks: { afterList?: (dir: string) => void; afterLstat?: (p: string) => void } = {}
  const parentOf = (p: string) => p.replace(/[\\/]+$/, '').split('\\').slice(0, -1).join('\\')
  const put = (p: string, n: FakeNode) => { const s = p.replace(/[\\/]+$/, ''); nodes.set(norm(s), n); spelled.set(norm(s), s.split('\\').pop()!) }
  const addDir = (p: string) => {
    const parts = p.replace(/[\\/]+$/, '').split('\\')
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('\\')
      if (!nodes.has(norm(d))) put(d, { kind: 'dir', ino: ++seq, nlink: 1, mtimeMs: 1 })
    }
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const entry = (n: FakeNode): CodexUsageEntry => ({ kind: n.kind, dev: '9', ino: String(n.ino), nlink: n.nlink, size: n.data?.length ?? 0, mtimeMs: n.mtimeMs })
  const port: CodexUsageFsPort = {
    platform: 'win32',
    lstat: async (p) => {
      calls.push(`lstat ${p}`)
      const n = nodes.get(norm(p))
      if (!n) throw err('ENOENT')
      const e = entry(n)
      hooks.afterLstat?.(p)
      return e
    },
    readdir: async (dir, limit) => {
      calls.push(`readdir ${dir}`)
      const n = nodes.get(norm(dir))
      if (!n || n.kind !== 'dir') throw err('ENOTDIR')
      const key = norm(dir)
      const names = [...nodes.keys()].filter((x) => parentOf(x) === key).map((x) => spelled.get(x)!)
      hooks.afterList?.(dir)
      const shown = names.slice(0, limit)
      listed.entries += shown.length
      return { names: shown, more: names.length > limit }
    },
    readTail: async (file, maxBytes, expected) => {
      calls.push(`readTail ${file} ${maxBytes}`)
      const n = nodes.get(norm(file))
      if (!n || n.kind !== 'file' || !n.data) throw err('ENOENT')
      if (expected.dev !== '9' || expected.ino !== String(n.ino)) throw err('ECHANGED')
      if (n.nlink !== 1) throw err('ELINKED')
      const len = Math.min(n.data.length, maxBytes)
      return { text: n.data.subarray(n.data.length - len).toString('utf8'), whole: len === n.data.length }
    },
  }
  return {
    port, calls, hooks, listed,
    file: (p: string, text: string, over: Partial<FakeNode> = {}) => { addDir(parentOf(p)); put(p, { kind: 'file', ino: ++seq, nlink: 1, mtimeMs: 1, data: Buffer.from(text, 'utf8'), ...over }) },
    grow: (p: string, more: string) => { const n = nodes.get(norm(p))!; n.data = Buffer.concat([n.data!, Buffer.from(more, 'utf8')]); n.mtimeMs++ },
    dir: (p: string) => addDir(p),
    link: (p: string) => { addDir(parentOf(p)); put(p, { kind: 'link', ino: ++seq, nlink: 1, mtimeMs: 1 }) },
    other: (p: string) => { addDir(parentOf(p)); put(p, { kind: 'other', ino: ++seq, nlink: 1, mtimeMs: 1 }) },
    swap: (p: string) => { const n = nodes.get(norm(p))!; n.ino = ++seq },
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
const NOW = Date.parse('2026-09-27T12:00:00Z')
const read = (f: ReturnType<typeof fakeFs>) => readLastSeenAllowance(SESSIONS, f.port, NOW)

describe('readLastSeenAllowance: which rollout', () => {
  it('lists the newest day folder first and the newest name first in it', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '26')}\\rollout-2026-09-26T10-00-00-a.jsonl`, rollout(meta('2026-09-26T10:00:00Z'), tokenCount('2026-09-26T10:00:01Z', limits(10))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-b.jsonl`, rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T08:00:01Z', limits(20))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-c.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(30))))
    const r = await read(f)
    expect(pct(r)).toBe(30)
    expect(r!.readingAt).toBe(Date.parse('2026-09-27T09:00:01Z'))
    expect(f.reads().map((x) => x.split('\\').pop())).toEqual([
      `rollout-2026-09-27T09-00-00-c.jsonl ${CODEX_USAGE_TAIL_BYTES}`,
      `rollout-2026-09-27T08-00-00-b.jsonl ${CODEX_USAGE_TAIL_BYTES}`,
      `rollout-2026-09-26T10-00-00-a.jsonl ${CODEX_USAGE_TAIL_BYTES}`,
    ])
  })

  it('orders years, months and days numerically newest first across a year boundary', async () => {
    const f = fakeFs()
    f.file(`${day('2025', '12', '31')}\\rollout-2025-12-31T23-00-00-a.jsonl`, rollout(meta('2025-12-31T23:00:00Z'), tokenCount('2025-12-31T23:00:01Z', limits(11))))
    f.file(`${day('2026', '01', '01')}\\rollout-2026-01-01T00-10-00-b.jsonl`, rollout(meta('2026-01-01T00:10:00Z'), tokenCount('2026-01-01T00:10:01Z', limits(12))))
    expect(pct(await read(f))).toBe(12)
  })

  it('takes the rollout whose allowance was reported last: an earlier-started session that ended later wins', async () => {
    const f = fakeFs()
    // Started 08:00, still reporting at 11:00.
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-long.jsonl`, rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T08:00:01Z', limits(5)), tokenCount('2026-09-27T11:00:00Z', limits(45))))
    // Started 09:00, done by 09:30.
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-short.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:30:00Z', limits(30))))
    const r = await read(f)
    expect(pct(r)).toBe(45)
    expect(r!.readingAt).toBe(Date.parse('2026-09-27T11:00:00Z'))
  })

  it('falls back to an older rollout when the newest has no allowance yet', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-a.jsonl`, rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T08:00:01Z', limits(40))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-b.jsonl`, rollout(meta('2026-09-27T09:00:00Z')))
    expect(pct(await read(f))).toBe(40)
  })

  it('counts a pre-response token_count (info null) and keeps the newest reading of each limit in the tail', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(
      meta('2026-09-27T09:00:00Z'),
      tokenCount('2026-09-27T09:00:01Z', limits(5)),
      tokenCount('2026-09-27T09:00:02Z', { limit_id: 'codex_spark', limit_name: 'Spark', primary: { used_percent: 3, window_minutes: 300 } }, { total_token_usage: { input_tokens: 1 } }),
    ))
    const r = (await read(f))!
    expect(r.limits.map((l) => [l.limitId, l.primary?.usedPercent])).toEqual([['codex', 5], ['codex_spark', 3]])
    expect(r.planType).toBe('plus')
  })

  it('is null for no sessions folder, an empty one, or rollouts with no allowance at all', async () => {
    expect(await read(fakeFs())).toBeNull()
    const f = fakeFs()
    f.dir(SESSIONS)
    expect(await read(f)).toBeNull()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', null)))
    expect(await read(f)).toBeNull()
  })

  it('never throws: a port that rejects, or throws before it returns a promise, reads as no reading', async () => {
    const rejecting: CodexUsageFsPort = { platform: 'win32', lstat: async () => { throw new Error('EIO') }, readdir: async () => { throw new Error('EIO') }, readTail: async () => { throw new Error('EIO') } }
    expect(await readLastSeenAllowance(SESSIONS, rejecting, NOW)).toBeNull()
    const throwing = { platform: 'win32', lstat: () => { throw new Error('EIO') }, readdir: () => { throw new Error('EIO') }, readTail: () => { throw new Error('EIO') } } as unknown as CodexUsageFsPort
    expect(await readLastSeenAllowance(SESSIONS, throwing, NOW)).toBeNull()
  })

  it('holds a reading time from the far future to now plus a small skew', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2036-01-01T00:00:00Z', limits(9))))
    const r = (await read(f))!
    expect(r.readingAt).toBeLessThanOrEqual(NOW + 5 * 60_000)
    expect(r.readingAt).toBeGreaterThan(NOW)
  })
})

describe('readLastSeenAllowance: what it may open', () => {
  it('opens only rollout-*.jsonl files under sessions/YYYY/MM/DD, never the sign-in file or anything else', async () => {
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
    expect(pct(await read(f))).toBe(7)
    for (const c of f.calls) expect(c.toLowerCase(), c).not.toContain('auth.json')
    for (const r of f.reads()) expect(r).toMatch(/\\sessions\\\d{4}\\\d{2}\\\d{2}\\rollout-[^\\]+\.jsonl \d+$/)
  })

  it('follows no link below the realm home: not the sessions folder, a year, month or day folder, or a rollout', async () => {
    const linkedRoot = fakeFs()
    linkedRoot.link(SESSIONS)
    expect(await read(linkedRoot)).toBeNull()
    expect(linkedRoot.calls.filter((c) => c.startsWith('readdir') || c.startsWith('readTail'))).toEqual([])

    const f = fakeFs()
    f.link(`${SESSIONS}\\2027`)
    f.link(`${SESSIONS}\\2026\\10`)
    f.link(`${day('2026', '09', '28')}`)
    f.link(`${day('2026', '09', '27')}\\rollout-2026-09-27T10-00-00-link.jsonl`)
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-real.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(8))))
    expect(pct(await read(f))).toBe(8)
    expect(f.reads()).toEqual([`readTail ${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-real.jsonl ${CODEX_USAGE_TAIL_BYTES}`])
    expect(f.calls.some((c) => /readdir .*(2027|\\10|\\28)$/.test(c))).toBe(false)
  })

  it('refuses a folder replaced between its check and its listing', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(8))))
    const monthDir = `${SESSIONS}\\2026\\09`
    f.hooks.afterList = (dir) => { if (dir === monthDir) f.swap(monthDir) }
    expect(await read(f)).toBeNull()
    expect(f.reads()).toEqual([])
  })

  it('opens a rollout only when it is still the regular, singly linked file it was checked to be', async () => {
    const f = fakeFs()
    const linked = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-linked.jsonl`
    const pipe = `${day('2026', '09', '27')}\\rollout-2026-09-27T10-00-00-pipe.jsonl`
    const swapped = `${day('2026', '09', '27')}\\rollout-2026-09-27T11-00-00-swapped.jsonl`
    f.file(linked, rollout(tokenCount('2026-09-27T09:00:01Z', limits(61))), { nlink: 2 })
    f.other(pipe)
    f.file(swapped, rollout(tokenCount('2026-09-27T11:00:01Z', limits(62))))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-ok.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(8))))
    // The swapped one is replaced right after the walk checked it.
    let once = false
    f.hooks.afterLstat = (p) => { if (p === swapped && !once) { once = true; f.swap(swapped) } }
    expect(pct(await read(f))).toBe(8)
    expect(f.reads().some((r) => r.includes('linked') || r.includes('pipe'))).toBe(false)
  })

  it('reads a 256 KiB tail, grows once to 2 MiB when the allowance is further back, and never past it', async () => {
    const filler = JSON.stringify({ timestamp: '2026-09-27T09:00:02Z', type: 'response_item', payload: { text: 'x'.repeat(1000) } })
    const f = fakeFs()
    const near = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-near.jsonl`
    f.file(near, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(21)), ...Array(400).fill(filler)))
    expect(pct(await read(f))).toBe(21)
    expect(f.reads()).toEqual([`readTail ${near} ${CODEX_USAGE_TAIL_BYTES}`, `readTail ${near} ${CODEX_USAGE_TAIL_MAX_BYTES}`])

    const g = fakeFs()
    const far = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-far.jsonl`
    g.file(far, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(22)), ...Array(2300).fill(filler)))
    expect(await read(g)).toBeNull()
    expect(g.reads()).toEqual([`readTail ${far} ${CODEX_USAGE_TAIL_BYTES}`, `readTail ${far} ${CODEX_USAGE_TAIL_MAX_BYTES}`])
  })

  it('ignores the cut first line of a tail and any line that is not JSON', async () => {
    const filler = JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(1000) } })
    const f = fakeFs()
    // Invalid as a whole line, but its end alone parses as a token_count of
    // another limit: the 256 KiB window starts inside its run of spaces, so a
    // reader that kept the cut first line would report that limit.
    const cut = '{"broken":' + ' '.repeat(200_000) + tokenCount('2026-09-27T09:00:01Z', limits(77, { limit_id: 'codex_cut' }))
    const rest = rollout(...Array(96).fill(filler), 'not json {', tokenCount('2026-09-27T09:00:05Z', limits(23)))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, cut + '\n' + rest)
    const r = (await read(f))!
    expect(r.limits.map((l) => [l.limitId, l.primary?.usedPercent])).toEqual([['codex', 23]])
    expect(f.reads()).toHaveLength(1)
  })

  it(`examines at most ${CODEX_USAGE_MAX_FILES} rollouts`, async () => {
    const f = fakeFs()
    for (let i = 0; i < 20; i++) f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-${String(i).padStart(2, '0')}-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z')))
    expect(await read(f)).toBeNull()
    expect(new Set(f.reads().map((r) => r.split(' ')[1])).size).toBe(CODEX_USAGE_MAX_FILES)
  })

  it(`lists at most ${CODEX_USAGE_MAX_DAYS} day folders`, async () => {
    const f = fakeFs()
    for (let d = 1; d <= 70; d++) f.dir(`${SESSIONS}\\2026\\${String(d).padStart(2, '0')}\\01`)
    expect(await read(f)).toBeNull()
    const dayLists = f.calls.filter((c) => /^readdir .*\\2026\\\d{2}\\01$/.test(c))
    expect(dayLists).toHaveLength(CODEX_USAGE_MAX_DAYS)
  })

  it('keeps the whole walk inside one budget of folder visits and entries, year and month folders included', async () => {
    const years = fakeFs()
    for (let y = 1000; y < 4000; y++) years.dir(`${SESSIONS}\\${y}`)
    expect(await read(years)).toBeNull()
    expect(years.calls.length).toBeLessThan(10)

    const months = fakeFs()
    for (let y = 2000; y < 2200; y++) for (let m = 1; m <= 12; m++) months.dir(`${SESSIONS}\\${y}\\${String(m).padStart(2, '0')}`)
    expect(await read(months)).toBeNull()
    // Every folder listed and every entry it returned count against one budget.
    const visits = months.calls.filter((c) => c.startsWith('readdir')).length
    expect(visits + months.listed.entries).toBeLessThanOrEqual(CODEX_USAGE_WALK_BUDGET)
    expect(months.calls.length).toBeLessThanOrEqual(3 * CODEX_USAGE_WALK_BUDGET)
  })
})

describe('the live figure (memory only)', () => {
  const reading = (p: number, at: number): AllowanceReading => ({ limits: [{ limitId: 'codex', limitName: null, readingAt: at, primary: { windowMinutes: 300, usedPercent: p, resetsAt: null }, secondary: null }], planType: 'pro', readingAt: at })

  it('keeps the newest reading per sessions folder, named the same however it is spelled on Windows', () => {
    const live = createCodexLiveUsage('win32')
    const release = live.open(SESSIONS)
    live.record(`${SESSIONS}\\`, reading(10, 2000))
    live.record(SESSIONS.toUpperCase(), reading(5, 1000))
    expect(live.get(SESSIONS)?.limits[0].primary?.usedPercent).toBe(10)
    live.record(SESSIONS, reading(12, 3000))
    expect(live.get(SESSIONS.toLowerCase())?.limits[0].primary?.usedPercent).toBe(12)
    expect(live.get('C:\\Users\\u\\other\\sessions')).toBeNull()
    release()
  })

  it('keeps every realm apart and stays bounded', () => {
    const live = createCodexLiveUsage('linux')
    for (let i = 0; i < 200; i++) { live.open(`/r/${i}/sessions`); live.record(`/r/${i}/sessions`, reading(i % 100, i)) }
    expect(live.get('/r/199/sessions')?.limits[0].primary?.usedPercent).toBe(99)
    expect(live.get('/r/0/sessions')).toBeNull()
    // Case matters off Windows and macOS.
    live.record('/R/x/sessions', reading(1, 1))
    expect(live.get('/r/x/sessions')).toBeNull()
  })

  it('forgets a realm\'s figure when its last session stops, so a new session never shows an old figure as live', () => {
    const live = createCodexLiveUsage('win32')
    const first = live.open(SESSIONS)
    const second = live.open(SESSIONS)
    live.record(SESSIONS, reading(33, 1))
    first()
    first() // a second release of the same session changes nothing
    expect(live.get(SESSIONS)?.limits[0].primary?.usedPercent).toBe(33)
    second()
    expect(live.get(SESSIONS)).toBeNull()
    const third = live.open(SESSIONS)
    expect(live.get(SESSIONS)).toBeNull()
    third()
  })
})

describe('createCodexUsageOperations', () => {
  const realm = { authRealmId: 'realm-' + '1'.repeat(32) }
  const livePair = () => { const live = createCodexLiveUsage('win32'); return { live, release: live.open(SESSIONS) } }

  it('live reads memory only; last-seen reads the realm\'s own folder; both give buckets, reading time and plan label', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33, { plan_type: 'pro' }))))
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    expect(await ops.live(realm)).toEqual({ ok: true, reading: null })
    expect(f.calls).toEqual([])
    live.record(SESSIONS, { limits: [{ limitId: 'codex', limitName: null, readingAt: 5, primary: { windowMinutes: 300, usedPercent: 44, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 5 })
    expect(await ops.live(realm)).toEqual({ ok: true, reading: { buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent: 44, resetsAt: '', severity: 'normal' }], readingAt: 5, planLabel: 'Plus' } })
    expect(f.calls).toEqual([])
    const seen = await ops.lastSeen(realm)
    expect(seen.ok && seen.reading?.buckets.map((b) => [b.label, b.percent])).toEqual([['5h', 33], ['Weekly', 34]])
    expect(seen.ok && seen.reading?.planLabel).toBe('Pro')
    expect(seen.ok && seen.reading?.readingAt).toBe(Date.parse('2026-09-27T09:00:01Z'))
  })

  it('a realm whose home fails the launch\'s canonical-home check is refused before any read', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    const { live } = livePair()
    live.record(SESSIONS, { limits: [], planType: null, readingAt: 1 })
    for (const sessionsDir of [async () => null, async () => { throw new Error('x') }]) {
      const ops = createCodexUsageOperations({ sessionsDir, fs: f.port, live, now: () => NOW })
      expect(await ops.lastSeen(realm)).toEqual({ ok: false })
      expect(await ops.live(realm)).toEqual({ ok: false })
    }
    expect(f.calls).toEqual([])
  })

  it('reuses a last-seen reading while the newest rollouts are unchanged, and reads again once one grows', async () => {
    const f = fakeFs()
    const file = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`
    f.file(file, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    await ops.lastSeen(realm)
    expect(f.reads()).toHaveLength(1)
    const again = await ops.lastSeen(realm)
    expect(f.reads()).toHaveLength(1)
    expect(again.ok && again.reading?.buckets[0].percent).toBe(33)
    f.grow(file, tokenCount('2026-09-27T09:10:00Z', limits(35)) + '\n')
    const grown = await ops.lastSeen(realm)
    expect(f.reads()).toHaveLength(2)
    expect(grown.ok && grown.reading?.buckets[0].percent).toBe(35)
  })

  it('shares one read between concurrent requests for the same realm', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    const [a, b, c] = await Promise.all([ops.lastSeen(realm), ops.lastSeen(realm), ops.lastSeen(realm)])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(f.calls.filter((x) => x === `readdir ${SESSIONS}`)).toHaveLength(1)
  })

  it('never throws: whatever the filesystem does, the answer is a result', async () => {
    const throwing = { platform: 'win32', lstat: () => { throw new Error('EIO') }, readdir: () => { throw new Error('EIO') }, readTail: () => { throw new Error('EIO') } } as unknown as CodexUsageFsPort
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: throwing, live, now: () => NOW })
    expect(await ops.lastSeen(realm)).toEqual({ ok: true, reading: null })
  })

  it('never throws on a reading it cannot draw: it is no reading', async () => {
    const f = fakeFs()
    const { live } = livePair()
    const broken = Object.defineProperty({ limitId: 'codex', limitName: null, readingAt: 1, secondary: null }, 'primary', { get() { throw new Error('boom') } })
    live.record(SESSIONS, { limits: [broken as never], planType: null, readingAt: 1 })
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    expect(await ops.live(realm)).toEqual({ ok: true, reading: null })
  })
})

describe('realCodexUsageFsPort (through an injected fs api)', () => {
  type Stat = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeMs: bigint }
  const stat = (over: Partial<{ kind: 'file' | 'dir' | 'link'; ino: bigint; nlink: bigint; size: bigint }> = {}): Stat => {
    const kind = over.kind ?? 'file'
    return { isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link', dev: 9n, ino: over.ino ?? 5n, nlink: over.nlink ?? 1n, size: over.size ?? 0n, mtimeMs: 7n }
  }
  function api(opts: { data?: Buffer; chunk?: number; fstat?: Stat; constants?: CodexUsageFsApi['constants']; names?: string[] } = {}) {
    const data = opts.data ?? Buffer.alloc(0)
    const log: string[] = []
    const a: CodexUsageFsApi = {
      constants: opts.constants ?? { O_RDONLY: 0 },
      lstat: async (p: string) => { log.push(`lstat ${p}`); return stat({ size: BigInt(data.length) }) },
      opendir: async (p: string) => {
        log.push(`opendir ${p}`)
        const names = opts.names ?? []
        let i = 0
        return {
          read: async () => (i < names.length ? { name: names[i++] } : null),
          close: async () => { log.push('closedir') },
        }
      },
      open: async (p: string, flags: number) => {
        log.push(`open ${p} ${flags}`)
        return {
          stat: async () => opts.fstat ?? stat({ size: BigInt(data.length) }),
          read: async (buf: Buffer, off: number, len: number, pos: number) => {
            const n = Math.min(len, opts.chunk ?? len, Math.max(0, data.length - pos))
            data.copy(buf, off, pos, pos + n)
            log.push(`read ${off} ${len} ${pos}`)
            return { bytesRead: n }
          },
          close: async () => { log.push('close') },
        }
      },
    }
    return { a, log }
  }
  const expected: CodexUsageEntry = { kind: 'file', dev: '9', ino: '5', nlink: 1, size: 1000, mtimeMs: 7 }

  it('reads the tail from the right offset, looping over short reads, and says whether that is the whole file', async () => {
    const data = Buffer.from('a'.repeat(700) + 'b'.repeat(300))
    const { a, log } = api({ data, chunk: 70 })
    const port = realCodexUsageFsPort('linux', a)
    const tail = await port.readTail('/x/f.jsonl', 256, expected)
    expect(tail).toEqual({ text: 'b'.repeat(256), whole: false })
    expect(log.filter((l) => l.startsWith('read ')).map((l) => Number(l.split(' ')[3]))).toEqual([744, 814, 884, 954])
    expect(log[log.length - 1]).toBe('close')
    const all = await port.readTail('/x/f.jsonl', 4096, expected)
    expect(all).toEqual({ text: data.toString(), whole: true })
  })

  it('opens without following a link and without blocking where the platform has the flags, and plainly where it does not (Windows)', async () => {
    const posix = api({ data: Buffer.from('x'), constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x800 } })
    await realCodexUsageFsPort('linux', posix.a).readTail('/x/f', 10, { ...expected, size: 1 })
    expect(posix.log.find((l) => l.startsWith('open '))).toBe(`open /x/f ${0x100 | 0x800}`)
    const win = api({ data: Buffer.from('x'), constants: { O_RDONLY: 0 } })
    await realCodexUsageFsPort('win32', win.a).readTail('C:\\x\\f', 10, { ...expected, size: 1 })
    expect(win.log.find((l) => l.startsWith('open '))).toBe('open C:\\x\\f 0')
  })

  it('refuses, after opening, anything but the regular, singly linked file it was checked to be', async () => {
    for (const fstat of [stat({ ino: 6n }), stat({ nlink: 2n }), stat({ kind: 'dir' })]) {
      const { a, log } = api({ data: Buffer.from('x'), fstat })
      await expect(realCodexUsageFsPort('linux', a).readTail('/x/f', 10, expected)).rejects.toThrow()
      expect(log.some((l) => l.startsWith('read '))).toBe(false)
      expect(log[log.length - 1]).toBe('close')
    }
  })

  it('lists at most the names asked for, says whether there were more, and closes the folder', async () => {
    const { a, log } = api({ names: ['a', 'b', 'c', 'd'] })
    const port = realCodexUsageFsPort('linux', a)
    expect(await port.readdir('/x', 2)).toEqual({ names: ['a', 'b'], more: true })
    expect(log[log.length - 1]).toBe('closedir')
    expect(await port.readdir('/x', 4)).toEqual({ names: ['a', 'b', 'c', 'd'], more: false })
  })

  it('lstat reports kind, identity, links, size and time', async () => {
    const { a } = api({ data: Buffer.from('abc') })
    expect(await realCodexUsageFsPort('linux', a).lstat('/x/f')).toEqual({ kind: 'file', dev: '9', ino: '5', nlink: 1, size: 3, mtimeMs: 7 })
  })
})
