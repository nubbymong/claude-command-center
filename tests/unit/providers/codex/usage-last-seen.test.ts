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
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readLastSeenAllowance, lookupLastSeenAllowance, createCodexLiveUsage, createCodexUsageOperations, realCodexUsageFsPort,
  createCodexCarryMarks, codexRolloutIdFromName, newestStampInTail, newestCarriedStamp, CODEX_CARRY_MARKS_MAX, CODEX_CARRY_MARKS_FILE_MAX_CHARS,
  CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES, CODEX_USAGE_MAX_FILES, CODEX_USAGE_WALK_BUDGET, CODEX_USAGE_MAX_DAYS,
  CODEX_USAGE_DAY_ENTRIES,
} from '../../../../src/main/providers/codex/usage'
import type { CodexUsageFsPort, CodexUsageEntry, CodexUsageFsApi, CodexCarryMarks, CodexCarryMarksPort } from '../../../../src/main/providers/codex/usage'
import { CODEX_DEFAULT_LIMIT_ID } from '../../../../src/main/providers/codex/rate-limits'
import type { AllowanceReading } from '../../../../src/shared/usage-types'

const SESSIONS = 'C:\\Users\\u\\.codex\\sessions'

interface FakeNode { kind: 'file' | 'dir' | 'link' | 'other'; ino: number; nlink: number; mtimeMs: number; data?: Buffer }

/** A Windows-shaped in-memory tree: folders, files, links and other things,
 *  every call logged. `afterList` runs after a folder is listed (to swap
 *  something in the gap); `readFails` makes a rollout's read throw;
 *  `listed.entries` counts the names the reader took from a listing. Names
 *  are listed in the order they were added. */
function fakeFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const nodes = new Map<string, FakeNode>()
  const spelled = new Map<string, string>()
  const calls: string[] = []
  const listed = { entries: 0 }
  let seq = 0
  const hooks: { afterList?: (dir: string) => void; afterLstat?: (p: string) => void; readFails?: (file: string) => string | null } = {}
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
    readdir: async (dir, visit) => {
      calls.push(`readdir ${dir}`)
      const n = nodes.get(norm(dir))
      if (!n || n.kind !== 'dir') throw err('ENOTDIR')
      const key = norm(dir)
      const names = [...nodes.keys()].filter((x) => parentOf(x) === key).map((x) => spelled.get(x)!)
      for (const name of names) {
        if (visit(name) === false) break
        listed.entries++
      }
      hooks.afterList?.(dir)
    },
    readTail: async (file, maxBytes, expected) => {
      calls.push(`readTail ${file} ${maxBytes}`)
      const failure = hooks.readFails?.(file)
      if (failure) throw err(failure)
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
    /** An identity that proves nothing (inode 0). */
    zero: (p: string) => { const n = nodes.get(norm(p))!; n.ino = 0 },
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

  // P3.14 (ADR-023): the credits count of the rollout the figure comes from.
  it('keeps the credits of the newest report that carries them, and of the rollout reported last', async () => {
    const f = fakeFs()
    const credits = (balance: string) => ({ has_credits: true, unlimited: false, balance })
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-a.jsonl`, rollout(
      meta('2026-09-27T08:00:00Z'),
      tokenCount('2026-09-27T08:00:01Z', limits(5, { credits: credits('300') })),
    ))
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-b.jsonl`, rollout(
      meta('2026-09-27T09:00:00Z'),
      tokenCount('2026-09-27T09:00:01Z', limits(6, { credits: credits('250.5') })),
      // A newer event that says nothing about credits (no key) does not take them away.
      tokenCount('2026-09-27T09:00:02Z', limits(7)),
      // Nor does a sub-limit's event, whatever it carries.
      tokenCount('2026-09-27T09:00:03Z', { limit_id: 'codex_spark', limit_name: 'Spark', primary: { used_percent: 3, window_minutes: 300 }, credits: null }),
    ))
    const r = (await read(f))!
    expect(pct(r)).toBe(7)
    expect(r.credits).toEqual({ hasCredits: true, unlimited: false, balance: 250.5 })
  })

  // Round 1, C1: the credits are the newest default-limit event's, the one the
  // bars come from. An account without credits writes null, which is "none now".
  it('a newer default-limit event whose credits are null clears the older figure, and a later figure is the new one', async () => {
    const f = fakeFs()
    const credits = (balance: string) => ({ has_credits: true, unlimited: false, balance })
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(
      meta('2026-09-27T09:00:00Z'),
      tokenCount('2026-09-27T09:00:01Z', limits(5, { credits: credits('300') })),
      tokenCount('2026-09-27T09:00:02Z', limits(6, { credits: null })),
    ))
    const cleared = (await read(f))!
    expect(pct(cleared)).toBe(6)
    expect(Object.prototype.hasOwnProperty.call(cleared, 'credits')).toBe(false)
    const g = fakeFs()
    g.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(
      meta('2026-09-27T09:00:00Z'),
      tokenCount('2026-09-27T09:00:01Z', limits(5, { credits: credits('300') })),
      tokenCount('2026-09-27T09:00:02Z', limits(6, { credits: null })),
      tokenCount('2026-09-27T09:00:03Z', limits(7, { credits: credits('290') })),
    ))
    expect((await read(g))!.credits).toEqual({ hasCredits: true, unlimited: false, balance: 290 })
  })

  it('a rollout with no credits gives a reading with no credits key, and hostile credits are not kept', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(5))))
    expect(Object.prototype.hasOwnProperty.call((await read(f))!, 'credits')).toBe(false)
    const g = fakeFs()
    g.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(meta('2026-09-27T09:00:00Z'), tokenCount('2026-09-27T09:00:01Z', limits(5, { credits: { has_credits: 'yes', unlimited: false, balance: '5', extra: 'x-secret' } }))))
    const r = (await read(g))!
    expect(r.credits).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('x-secret')
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

  // Review Q3 (MP3 round 2): a day folder with more entries than the walk has
  // budget left is still listed to its end, holding only its newest names, so
  // a crowded day yields its newest rollouts instead of ending the walk empty.
  it('finds the newest rollouts of a day folder more crowded than the budget left', async () => {
    const f = fakeFs()
    const d = day('2026', '09', '27')
    for (let i = 0; i < 1100; i++) f.file(`${d}\\note-${String(i).padStart(4, '0')}.txt`, 'x')
    // Listed last, after every note.
    const hour = (h: number) => String(h).padStart(2, '0')
    for (let h = 0; h < 10; h++) f.file(`${d}\\rollout-2026-09-27T${hour(h)}-00-00-a.jsonl`, rollout(tokenCount(`2026-09-27T${hour(h)}:00:01Z`, limits(h))))
    expect(pct(await read(f))).toBe(9)
    expect(f.reads().map((x) => x.split('\\').pop()!.split(' ')[0])).toEqual(
      Array.from({ length: CODEX_USAGE_MAX_FILES }, (_, i) => `rollout-2026-09-27T${hour(9 - i)}-00-00-a.jsonl`))
  })

  it(`lists at most ${CODEX_USAGE_DAY_ENTRIES} entries of one day folder, and a day that spends the budget ends the walk`, async () => {
    const f = fakeFs()
    const d = day('2026', '09', '27')
    f.file(`${d}\\rollout-2026-09-27T08-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T08:00:01Z', limits(8))))
    for (let i = 0; i < CODEX_USAGE_DAY_ENTRIES + 500; i++) f.file(`${d}\\note-${String(i).padStart(5, '0')}.txt`, 'x')
    f.file(`${d}\\rollout-2026-09-27T09-00-00-late.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(9))))
    // An older day whose rollout reported later: it would win if it were listed.
    f.file(`${day('2026', '09', '26')}\\rollout-2026-09-26T23-00-00-old.jsonl`, rollout(tokenCount('2026-09-27T11:00:00Z', limits(26))))
    expect(pct(await read(f))).toBe(8)
    // The sessions, year and month folders' entries, then the capped day.
    expect(f.listed.entries).toBe(1 + 1 + 2 + CODEX_USAGE_DAY_ENTRIES)
    expect(f.calls.some((c) => c === `readdir ${day('2026', '09', '26')}`)).toBe(false)
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

  // P3.14 (ADR-023): the credits count rides every reading the port gives.
  it('live and last-seen both carry the reading\'s credits to the usage reading, and omit the key when there are none', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33, { credits: { has_credits: true, unlimited: false, balance: '1250.0000000000' } }))))
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    const seen = await ops.lastSeen(realm)
    expect(seen.ok && seen.reading?.credits).toEqual({ hasCredits: true, unlimited: false, balance: 1250 })
    live.record(SESSIONS, { limits: [{ limitId: 'codex', limitName: null, readingAt: 5, primary: { windowMinutes: 300, usedPercent: 44, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 5 })
    const bare = await ops.live(realm)
    expect(bare.ok && bare.reading && Object.prototype.hasOwnProperty.call(bare.reading, 'credits')).toBe(false)
    live.record(SESSIONS, { limits: [{ limitId: 'codex', limitName: null, readingAt: 6, primary: { windowMinutes: 300, usedPercent: 45, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 6, credits: { hasCredits: true, unlimited: true, balance: null } })
    const open = await ops.live(realm)
    expect(open.ok && open.reading?.credits).toEqual({ hasCredits: true, unlimited: true, balance: null })
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

  // Review Q2 (MP3 round 2): a rollout that could not be read (busy, too many
  // open files) may hold the newest figure: nothing is kept, the next request
  // reads again, and with nothing found the answer is unavailable.
  it('keeps nothing when a rollout could not be read, and reads again next time', async () => {
    const f = fakeFs()
    const newer = `${day('2026', '09', '27')}\\rollout-2026-09-27T10-00-00-b.jsonl`
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    f.file(newer, rollout(tokenCount('2026-09-27T10:00:01Z', limits(55))))
    let busy = true
    f.hooks.readFails = (file) => (busy && file === newer ? 'EMFILE' : null)
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    const first = await ops.lastSeen(realm)
    expect(first.ok && first.reading?.buckets[0].percent).toBe(33)
    busy = false
    const second = await ops.lastSeen(realm)
    expect(second.ok && second.reading?.buckets[0].percent).toBe(55)
  })

  it('is unavailable, not "no session yet", when the only rollout could not be read', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    f.hooks.readFails = () => 'EBUSY'
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    expect(await ops.lastSeen(realm)).toEqual({ ok: false })
  })

  // Review Q4 (MP3 round 2): a failure inside the read is an error card, never
  // "no session yet".
  it('a failure inside the read is unavailable, not "no session yet"', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    let asked = 0
    const port = Object.defineProperty({ ...f.port }, 'platform', { get() { if (++asked > 1) throw new Error('boom'); return 'win32' } }) as CodexUsageFsPort
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: port, live, now: () => NOW })
    expect(await ops.lastSeen(realm)).toEqual({ ok: false })
  })

  // Review R2 (MP3 round 2): inode 0 cannot tell two things apart (some
  // network and FAT volumes report it), so the identity checks would prove
  // nothing: the read is refused and the account shows as unavailable.
  it('refuses the read when an identity on the way is inode 0: the sessions folder, a year or day folder, or a rollout', async () => {
    const file = `${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`
    for (const zeroed of [SESSIONS, `${SESSIONS}\\2026`, day('2026', '09', '27'), file]) {
      const f = fakeFs()
      f.file(file, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
      f.zero(zeroed)
      const { live } = livePair()
      const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
      expect(await ops.lastSeen(realm), zeroed).toEqual({ ok: false })
      expect(f.reads(), zeroed).toEqual([])
    }
  })

  // Review R3 (MP3 round 2): a read that never settles (a hung share) holds
  // no caller past the timeout and is not started again beside itself; once
  // it settles the next request reads afresh.
  const race = <T,>(p: Promise<T>) => Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1000))])
  it('answers unavailable once the timeout passes on a read that hangs, and never starts a second beside it', async () => {
    const f = fakeFs()
    f.file(`${day('2026', '09', '27')}\\rollout-2026-09-27T09-00-00-a.jsonl`, rollout(tokenCount('2026-09-27T09:00:01Z', limits(33))))
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let started = 0
    const port: CodexUsageFsPort = { ...f.port, lstat: async (p) => { if (p === SESSIONS) { started++; await gate } return f.port.lstat(p) } }
    const { live } = livePair()
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: port, live, now: () => NOW, timeoutMs: 20 })
    expect(await race(ops.lastSeen(realm))).toEqual({ ok: false })
    expect(await race(ops.lastSeen(realm))).toEqual({ ok: false })
    expect(started).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 10))
    const after = await race(ops.lastSeen(realm))
    expect(after !== 'hung' && after.ok && after.reading?.buckets[0].percent).toBe(33)
    // The held walk finished, then one new walk: two listings in all.
    expect(f.calls.filter((x) => x === `readdir ${SESSIONS}`)).toHaveLength(2)
  })

  it('live answers unavailable once the timeout passes on locating a realm that hangs', async () => {
    let asked = 0
    const never = new Promise<string | null>(() => {})
    const ops = createCodexUsageOperations({ sessionsDir: () => { asked++; return never }, fs: fakeFs().port, live: createCodexLiveUsage('win32'), now: () => NOW, timeoutMs: 20 })
    expect(await race(ops.live(realm))).toEqual({ ok: false })
    expect(await race(ops.live(realm))).toEqual({ ok: false })
    expect(asked).toBe(1)
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

  it('hands each name to the visitor until it says stop, and closes the folder either way', async () => {
    const { a, log } = api({ names: ['a', 'b', 'c', 'd'] })
    const port = realCodexUsageFsPort('linux', a)
    const seen: string[] = []
    await port.readdir('/x', (n) => { seen.push(n); return seen.length < 2 })
    expect(seen).toEqual(['a', 'b'])
    expect(log[log.length - 1]).toBe('closedir')
    const all: string[] = []
    await port.readdir('/x', (n) => { all.push(n); return true })
    expect(all).toEqual(['a', 'b', 'c', 'd'])
    await expect(port.readdir('/x', () => { throw new Error('visitor') })).rejects.toThrow('visitor')
    expect(log.filter((l) => l === 'closedir')).toHaveLength(3)
  })

  // Review R2 (MP3 round 2).
  it('refuses a rollout whose identity is inode 0, without opening it', async () => {
    const zero = api({ data: Buffer.from('x'), fstat: stat({ ino: 0n, size: 1n }) })
    await expect(realCodexUsageFsPort('win32', zero.a).readTail('C:\\x\\f', 10, { ...expected, ino: '0', size: 1 })).rejects.toThrow()
    expect(zero.log.some((l) => l.startsWith('open '))).toBe(false)
  })

  it('lstat reports kind, identity, links, size and time', async () => {
    const { a } = api({ data: Buffer.from('abc') })
    expect(await realCodexUsageFsPort('linux', a).lstat('/x/f')).toEqual({ kind: 'file', dev: '9', ino: '5', nlink: 1, size: 3, mtimeMs: 7 })
  })
})

// ---------------------------------------------------------------------------
// P3.14 round 1, C2 (ADR-023): a conversation Switch Account carried into an
// account's folder is a copy of the earlier account's rollout, with the earlier
// account's events in it. Its allowance, plan and credits count only from the
// carry on: the marks say when.
// ---------------------------------------------------------------------------

describe('carry marks (ADR-023)', () => {
  const CID = '0198a0b0-1c2d-7e3f-8a4b-5c6d7e8f9a0b'
  const OTHER = '0198a0b0-1c2d-7e3f-8a4b-5c6d7e8f9a0c'
  const AT = Date.parse('2026-09-27T10:30:00Z')
  const CLOSED = Number.MAX_SAFE_INTEGER
  const idN = (n: number) => `0198a0b0-1c2d-7e3f-8a4b-${String(n).padStart(12, '0')}`
  const C_DIR = 'C:\\Users\\u\\c\\sessions'

  /** A persisted file in memory: what a restart would find, and how it fails. */
  const memoryPort = () => {
    const box: { text: string | null; writes: number; reads: number; failWrite: boolean; kind: null | 'unavailable' | 'corrupt' | 'throws' | 'not-ready'; asides: number; asideFails: boolean; asideTexts: string[] } =
      { text: null, writes: 0, reads: 0, failWrite: false, kind: null, asides: 0, asideFails: false, asideTexts: [] }
    const port: CodexCarryMarksPort = {
      read: () => {
        box.reads++
        if (box.kind === 'throws') throw new Error('read')
        if (box.kind === 'unavailable') return { kind: 'unavailable' }
        if (box.kind === 'not-ready') return { kind: 'not-ready' }
        if (box.kind === 'corrupt') return { kind: 'corrupt' }
        return box.text === null ? { kind: 'missing' } : { kind: 'ok', text: box.text }
      },
      write: (text) => { if (box.failWrite) throw new Error('disk full'); box.text = text; box.writes++ },
      // The file is set aside and the replacement put in its place in one step, or nothing changes.
      setAside: (replacement) => { box.asides++; if (box.asideFails) return false; box.asideTexts.push(replacement); box.text = replacement; box.kind = null; return true },
    }
    return { box, port }
  }
  const clock = (t0 = AT) => { let t = t0; return { now: () => t, set: (n: number) => { t = n } } }
  const doc = (marks: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, ...extra, marks })
  const good = { realm: 'realm-b', dir: SESSIONS, id: CID, at: AT }

  it('names the conversation in a rollout file name or path, lower case, and nothing else', () => {
    expect(codexRolloutIdFromName(`rollout-2026-09-27T08-00-00-${CID.toUpperCase()}.jsonl`)).toBe(CID)
    expect(codexRolloutIdFromName(`C:\\Users\\u\\.codex\\sessions\\2026\\09\\27\\rollout-2026-09-27T08-00-00-${CID}.jsonl`)).toBe(CID)
    expect(codexRolloutIdFromName(`/home/u/.codex/sessions/2026/09/27/rollout-2026-09-27T08-00-00-${CID}.jsonl`)).toBe(CID)
    for (const bad of ['', 'rollout-x.jsonl', `${CID}.jsonl`, `rollout-2026-${CID}.json`, `xrollout-2026-09-27T08-00-00-${CID}.jsonl`, `rollout-2026-09-27T08-00-00-${CID}.jsonl.tmp`, 'rollout-2026-09-27T08-00-00-not-a-uuid.jsonl', null, undefined, 7, {}]) {
      expect(codexRolloutIdFromName(bad), String(bad)).toBeNull()
    }
    expect(codexRolloutIdFromName(`rollout-${'a'.repeat(20_000)}-${CID}.jsonl`)).toBeNull()
  })

  it('records a carry and tells its time, by sessions folder and conversation', () => {
    const m = createCodexCarryMarks({ platform: 'win32' })
    expect(m.cutoff(SESSIONS, CID)).toBeNull()
    expect(m.record('realm-b', SESSIONS, CID, AT)).toBe(true)
    expect(m.cutoff(SESSIONS, CID)).toBe(AT)
    expect(m.markOf(SESSIONS, CID)).toBe(AT)
    // Another conversation, another folder, no conversation: no mark.
    expect(m.cutoff(SESSIONS, OTHER)).toBeNull()
    expect(m.cutoff('C:\\Users\\u\\other\\sessions', CID)).toBeNull()
    expect(m.cutoff(SESSIONS, null)).toBeNull()
    // The folder is named the same however it is spelled on Windows (caseless, trailing slash); the id in either case.
    expect(m.cutoff(SESSIONS.toUpperCase() + '\\', CID.toUpperCase())).toBe(AT)
    // A later carry of the same conversation into the same folder replaces it.
    m.record('realm-b', SESSIONS, CID, AT + 1000)
    expect(m.cutoff(SESSIONS, CID)).toBe(AT + 1000)
    // Recorded under an upper-case id: found by the lower-case one.
    m.record('realm-b', SESSIONS, OTHER.toUpperCase(), AT + 2000)
    expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 2000)
  })

  it('takes a mark back, and tells nothing of one that is not there', () => {
    const m = createCodexCarryMarks({ platform: 'win32' })
    m.record('realm-b', SESSIONS, CID, AT)
    m.remove(SESSIONS, OTHER)
    expect(m.markOf(SESSIONS, CID)).toBe(AT)
    m.remove(SESSIONS, CID)
    expect(m.markOf(SESSIONS, CID)).toBeNull()
    expect(m.cutoff(SESSIONS, CID)).toBeNull()
    expect(() => m.remove('', 'x')).not.toThrow()
  })

  it('case matters off Windows and macOS', () => {
    const m = createCodexCarryMarks({ platform: 'linux' })
    m.record('realm-b', '/r/B/sessions', CID, AT)
    expect(m.cutoff('/r/B/sessions', CID)).toBe(AT)
    expect(m.cutoff('/R/B/sessions', CID)).toBeNull()
  })

  it('refuses what is not a realm id, a folder, a conversation id or a time', () => {
    const m = createCodexCarryMarks({ platform: 'win32' })
    for (const [realm, dir, id, at] of [
      ['', SESSIONS, CID, AT], ['a b', SESSIONS, CID, AT], ['x'.repeat(200), SESSIONS, CID, AT], [7, SESSIONS, CID, AT],
      ['realm-b', '', CID, AT], ['realm-b', 'x'.repeat(5000), CID, AT], ['realm-b', null, CID, AT],
      ['realm-b', SESSIONS, 'not-a-uuid', AT], ['realm-b', SESSIONS, '', AT], ['realm-b', SESSIONS, null, AT],
      ['realm-b', SESSIONS, CID, Number.NaN], ['realm-b', SESSIONS, CID, Infinity], ['realm-b', SESSIONS, CID, 9e15], ['realm-b', SESSIONS, CID, '123'],
    ] as unknown[][]) {
      expect(m.record(realm as string, dir as string, id as string, at as number), JSON.stringify([realm, dir, id, at])).toBe(false)
    }
    expect(m.cutoff(SESSIONS, CID)).toBeNull()
  })

  describe('the bound', () => {
    it(`keeps the newest ${CODEX_CARRY_MARKS_MAX} of one realm, and a conversation carried again is the newest`, () => {
      const m = createCodexCarryMarks({ platform: 'linux' })
      for (let i = 0; i < CODEX_CARRY_MARKS_MAX + 10; i++) m.record('realm-b', '/r/B/sessions', idN(i), AT + i)
      expect(m.cutoff('/r/B/sessions', idN(0))).toBeNull()
      expect(m.cutoff('/r/B/sessions', idN(9))).toBeNull()
      expect(m.cutoff('/r/B/sessions', idN(10))).toBe(AT + 10)
      expect(m.cutoff('/r/B/sessions', idN(CODEX_CARRY_MARKS_MAX + 9))).toBe(AT + CODEX_CARRY_MARKS_MAX + 9)
      const small = createCodexCarryMarks({ platform: 'linux', max: 3 })
      for (let i = 0; i < 3; i++) small.record('realm-b', '/r/B/sessions', idN(i), AT + i)
      small.record('realm-b', '/r/B/sessions', idN(0), AT + 100) // carried again: now the newest
      small.record('realm-b', '/r/B/sessions', idN(3), AT + 3)
      expect([0, 1, 2, 3].map((i) => small.cutoff('/r/B/sessions', idN(i)))).toEqual([AT + 100, null, AT + 2, AT + 3])
    })

    it('a realm over its share evicts its own oldest: another realm\'s marks are never evicted by it', () => {
      const m = createCodexCarryMarks({ platform: 'linux' })
      m.record('realm-b', '/r/B/sessions', idN(9000), AT)
      m.record('realm-c', '/r/C/sessions', idN(9001), AT + 1)
      for (let i = 0; i < CODEX_CARRY_MARKS_MAX + 40; i++) m.record('realm-x', '/r/X/sessions', idN(i), AT + 10 + i)
      expect(m.cutoff('/r/B/sessions', idN(9000))).toBe(AT)
      expect(m.cutoff('/r/C/sessions', idN(9001))).toBe(AT + 1)
      // The busy realm lost its own oldest, and kept its newest.
      expect(m.cutoff('/r/X/sessions', idN(0))).toBeNull()
      expect(m.cutoff('/r/X/sessions', idN(CODEX_CARRY_MARKS_MAX + 39))).toBe(AT + 10 + CODEX_CARRY_MARKS_MAX + 39)
      let kept = 0
      for (let i = 0; i < CODEX_CARRY_MARKS_MAX + 40; i++) if (m.cutoff('/r/X/sessions', idN(i)) !== null) kept++
      expect(kept).toBe(CODEX_CARRY_MARKS_MAX - 2)
    })
  })

  it('drops every mark of a realm, and only that realm\'s', () => {
    const m = createCodexCarryMarks({ platform: 'win32' })
    m.record('realm-b', SESSIONS, CID, AT)
    m.record('realm-b', SESSIONS, OTHER, AT)
    m.record('realm-c', C_DIR, CID, AT)
    m.dropRealm('realm-b')
    expect(m.cutoff(SESSIONS, CID)).toBeNull()
    expect(m.cutoff(SESSIONS, OTHER)).toBeNull()
    expect(m.cutoff(C_DIR, CID)).toBe(AT)
    m.dropRealm('realm-nobody')
    m.dropRealm(7 as never)
  })

  it('survives an app restart: a new store over the same file finds the marks, and a dropped realm stays dropped', () => {
    const { box, port } = memoryPort()
    const first = createCodexCarryMarks({ platform: 'win32', port })
    first.record('realm-b', SESSIONS, CID, AT)
    first.record('realm-c', C_DIR, OTHER, AT + 5)
    expect(box.writes).toBeGreaterThan(0)
    const second = createCodexCarryMarks({ platform: 'win32', port })
    expect(second.cutoff(SESSIONS, CID)).toBe(AT)
    expect(second.cutoff(C_DIR, OTHER)).toBe(AT + 5)
    second.dropRealm('realm-b')
    const third = createCodexCarryMarks({ platform: 'win32', port })
    expect(third.cutoff(SESSIONS, CID)).toBeNull()
    expect(third.cutoff(C_DIR, OTHER)).toBe(AT + 5)
  })

  it('what is written is the three facts of a carry and nothing else (no floor when nothing was lost)', () => {
    const { box, port } = memoryPort()
    const m = createCodexCarryMarks({ platform: 'win32', port })
    for (let i = 0; i < 4; i++) m.record('realm-b', SESSIONS, idN(i), AT + i)
    const written = JSON.parse(box.text!) as { schema: number; floor?: number; marks: Array<Record<string, unknown>> }
    expect(written.schema).toBe(1)
    expect(Object.keys(written).sort()).toEqual(['marks', 'schema'])
    expect(written.marks).toHaveLength(4)
    for (const mark of written.marks) expect(Object.keys(mark).sort()).toEqual(['at', 'dir', 'id', 'realm'])
  })

  // Round 3 (H1, H5): the harm guarded against is a temporary display of the
  // user's other account's figures on the wrong card, so an unreadable or
  // unwritable marks file never stops a carry or a Sign in again, and never
  // blanks a card. It fails closed by TIME: the first failed read is a floor
  // for the folders carried into since, marks, drops and adoptions are kept in
  // memory, and all are written once the file reads.
  describe('a file that cannot be read or written now: carries go on, and readers fail closed by time (round 3)', () => {
    it('a carry is kept in memory and read back at once; once the file reads it is written beside the file\'s own marks', () => {
      const { box, port } = memoryPort()
      const t = clock()
      box.kind = 'unavailable'
      box.text = doc([{ ...good, realm: 'realm-c', dir: C_DIR, id: OTHER, at: AT + 9 }])
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      // Not known yet (the file has not been read), not "none".
      expect(m.markOf(SESSIONS, CID)).toBeUndefined()
      expect(m.record('realm-b', SESSIONS, CID, AT + 100)).toBe(true)
      expect(m.markOf(SESSIONS, CID)).toBe(AT + 100)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 100)
      expect(box.writes).toBe(0)
      // Within the wait it is not read again, however often it is asked.
      const reads = box.reads
      for (let i = 0; i < 50; i++) m.cutoff(SESSIONS, CID)
      expect(box.reads).toBe(reads)
      // Once it can be read and the wait has passed, its marks are there, this run's beside them, and both are written.
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff(C_DIR, OTHER)).toBe(AT + 9)
      expect(m.markOf(SESSIONS, CID)).toBe(AT + 100)
      expect(box.writes).toBe(1)
      const written = (JSON.parse(box.text!) as { marks: Array<{ realm: string; id: string; at: number }> }).marks
      expect(written.map((x) => [x.realm, x.id, x.at]).sort()).toEqual([['realm-b', CID, AT + 100], ['realm-c', OTHER, AT + 9]])
      const again = createCodexCarryMarks({ platform: 'win32', port })
      expect(again.cutoff(SESSIONS, CID)).toBe(AT + 100)
      expect(again.cutoff(C_DIR, OTHER)).toBe(AT + 9)
    })

    it('the first failed read is a floor for the folders carried into since: nothing dated at or before it counts there, every other folder reads whole', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'unavailable'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      // The first failed read, at AT. Nothing was carried into any folder in this run: no folder is held, no card is blanked.
      expect(m.cutoff(SESSIONS, CID)).toBeNull()
      expect(m.cutoff(C_DIR, OTHER)).toBeNull()
      t.set(AT + 5000)
      expect(m.record('realm-b', SESSIONS, CID, AT + 5000)).toBe(true)
      // Another conversation of the folder carried into is held to the first failed read; the carried one to its mark, the later.
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 5000)
      // Another folder reads whole.
      expect(m.cutoff(C_DIR, OTHER)).toBeNull()
      // A mark earlier than the floor does not lower it.
      expect(m.record('realm-b', SESSIONS, idN(9), AT - 1)).toBe(true)
      expect(m.cutoff(SESSIONS, idN(9))).toBe(AT)
      // Once the file reads, the floor is gone: the file's own marks rule.
      box.kind = null
      t.set(AT + 90_000)
      expect(m.cutoff(SESSIONS, OTHER)).toBeNull()
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 5000)
    })

    it('a mark taken back while the file cannot be read leaves its folder as it was: no longer held', () => {
      const { box, port } = memoryPort()
      const m = createCodexCarryMarks({ platform: 'win32', port, now: clock().now })
      box.kind = 'unavailable'
      m.record('realm-b', SESSIONS, CID, AT)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT)
      m.remove(SESSIONS, CID)
      expect(m.markOf(SESSIONS, CID)).toBeUndefined()
      expect(m.cutoff(SESSIONS, OTHER)).toBeNull()
    })

    it('a Sign in again\'s adoption goes on: the new folder is held, and the file\'s marks of the old realm follow once it reads', () => {
      const { box, port } = memoryPort()
      const t = clock(AT + 500)
      box.kind = 'unavailable'
      box.text = doc([good])
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(true)
      // Held to the first failed read: nothing dated at or before it counts in the new folder.
      expect(m.cutoff(C_DIR, CID)).toBe(AT + 500)
      expect(box.writes).toBe(0)
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff(C_DIR, CID)).toBe(AT)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      const written = (JSON.parse(box.text!) as { marks: Array<{ realm: string; dir: string }> }).marks
      expect(written.map((x) => x.realm).sort()).toEqual(['realm-b', 'realm-new'])
      expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(C_DIR, CID)).toBe(AT)
    })

    it('adoptions made while the file cannot be read are applied in the order they were made, and the queue is bounded', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'unavailable'
      box.text = doc([good, { ...good, realm: 'realm-q', dir: 'C:\\Users\\u\\qq\\sessions', id: OTHER }])
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      // A, then B, then C: the marks of realm-b go to realm-c's folder through realm-new's.
      m.adopt('realm-b', 'realm-new', C_DIR)
      m.adopt('realm-new', 'realm-c', 'C:\\Users\\u\\z\\sessions')
      for (let i = 0; i < 200; i++) m.adopt('realm-q', `realm-q${i}`, `C:\\Users\\u\\q${i}\\sessions`)
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff('C:\\Users\\u\\z\\sessions', CID)).toBe(AT)
      expect(m.cutoff(C_DIR, CID)).toBe(AT)
      // The queue holds 64: the two above and the first sixty-two of the rest; the next is not applied.
      expect(m.cutoff('C:\\Users\\u\\q61\\sessions', OTHER)).toBe(AT)
      expect(m.cutoff('C:\\Users\\u\\q62\\sessions', OTHER)).toBeNull()
    })

    it('the wait grows with each failed read, to a longest, and a throwing port counts as unreadable', () => {
      const { box, port } = memoryPort()
      const t = clock(0)
      box.kind = 'throws'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      m.cutoff(SESSIONS, CID)
      expect(box.reads).toBe(1)
      const gaps: number[] = []
      let last = 0
      for (let step = 0; step < 12; step++) {
        // Find when it is next read: just before the wait it is not, at it, it is.
        let waited = 0
        for (waited = 1; waited < 40_000; waited++) {
          t.set(last + waited)
          const before = box.reads
          m.cutoff(SESSIONS, CID)
          if (box.reads > before) break
        }
        gaps.push(waited)
        last += waited
      }
      expect(gaps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
      expect(Math.max(...gaps)).toBe(30_000)
      expect(gaps[gaps.length - 1]).toBe(30_000)
    })

    it('a resources folder that is not known yet is not a failed read: no wait, and the first real read is at once (H5)', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'not-ready'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      for (let i = 0; i < 5; i++) {
        expect(m.cutoff(SESSIONS, CID)).toBeNull()
        t.set(AT + i + 1)
      }
      // Asked again every time, with no wait between.
      expect(box.reads).toBe(5)
      // The folder is known now: the very next ask reads the file.
      box.kind = null
      box.text = doc([good])
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      expect(box.reads).toBe(6)
      // A failed read after not-ready waits the first wait, not a longer one.
      const { box: b2, port: p2 } = memoryPort()
      const t2 = clock(AT)
      b2.kind = 'not-ready'
      const m2 = createCodexCarryMarks({ platform: 'win32', port: p2, now: t2.now })
      for (let i = 0; i < 40; i++) m2.cutoff(SESSIONS, CID)
      b2.kind = 'unavailable'
      m2.cutoff(SESSIONS, CID)
      b2.kind = null
      t2.set(AT + 1000)
      expect(m2.cutoff(SESSIONS, CID)).toBeNull()
      expect(b2.reads).toBe(42)
    })

    it('a carry made while the folder is not known yet is kept and written when it is', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'not-ready'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      expect(m.record('realm-b', SESSIONS, CID, AT)).toBe(true)
      // The folder not being known yet holds the folders carried into, from the first time it was asked.
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT)
      expect(box.writes).toBe(0)
      box.kind = null
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      expect(JSON.parse(box.text!)).toEqual({ schema: 1, marks: [{ realm: 'realm-b', dir: SESSIONS, id: CID, at: AT }] })
    })

    it('a realm dropped while the file cannot be read is not brought back by it, and the file is written without it', () => {
      const { box, port } = memoryPort()
      const t = clock()
      box.kind = 'unavailable'
      box.text = doc([good, { ...good, realm: 'realm-c', dir: C_DIR, id: OTHER, at: AT + 9 }])
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      m.dropRealm('realm-b')
      expect(box.writes).toBe(0)
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff(SESSIONS, CID)).toBeNull()
      expect(m.cutoff(C_DIR, OTHER)).toBe(AT + 9)
      expect((JSON.parse(box.text!) as { marks: Array<{ realm: string }> }).marks.map((x) => x.realm)).toEqual(['realm-c'])
      // And a new store finds the same.
      expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, CID)).toBeNull()
    })

    it('a mark made while the file cannot be read, for a realm dropped before it can, is gone with it', () => {
      const { box, port } = memoryPort()
      const t = clock()
      box.kind = 'unavailable'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      m.record('realm-b', SESSIONS, CID, AT)
      m.dropRealm('realm-b')
      expect(m.markOf(SESSIONS, CID)).toBeUndefined()
      box.kind = null
      box.text = doc([good])
      t.set(AT + 60_000)
      expect(m.cutoff(SESSIONS, CID)).toBeNull()
      expect((JSON.parse(box.text!) as { marks: unknown[] }).marks).toEqual([])
    })

    it('a mark that cannot be written is kept in memory and written once the disk works again (carries never fail for it)', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      expect(m.record('realm-b', SESSIONS, CID, AT)).toBe(true)
      box.failWrite = true
      expect(m.record('realm-b', SESSIONS, OTHER, AT + 1)).toBe(true)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 1)
      expect(m.record('realm-b', SESSIONS, CID, AT + 99)).toBe(true)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 99)
      expect(() => m.dropRealm('realm-c')).not.toThrow()
      expect(() => m.remove(SESSIONS, idN(3))).not.toThrow()
      // Only the first is in the file so far.
      expect((JSON.parse(box.text!) as { marks: Array<{ at: number }> }).marks.map((x) => x.at)).toEqual([AT])
      // The disk works again: the next ask after the wait writes what is held.
      box.failWrite = false
      t.set(AT + 60_000)
      m.cutoff(SESSIONS, CID)
      expect((JSON.parse(box.text!) as { marks: Array<{ id: string; at: number }> }).marks.map((x) => [x.id, x.at]).sort()).toEqual([[CID, AT + 99], [OTHER, AT + 1]])
    })

    it('a write that keeps failing is tried again after a wait, not at every ask', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      m.record('realm-b', SESSIONS, CID, AT)
      box.failWrite = true
      let attempts = 0
      const real = port.write
      port.write = (text) => { attempts++; real(text) }
      m.record('realm-b', SESSIONS, OTHER, AT + 1)
      expect(attempts).toBe(1)
      for (let i = 0; i < 50; i++) m.cutoff(SESSIONS, CID)
      expect(attempts).toBe(1)
      t.set(AT + 2000)
      m.cutoff(SESSIONS, CID)
      expect(attempts).toBe(2)
    })
  })

  // Round 4 (the round 3 quality nit): a copy the carry found already in the
  // folder keeps the mark the file has for it. While the file cannot be read
  // that mark is not known, so the mark made for the carry is taken back and
  // a "mark it if the file has none" is kept instead, applied once the file
  // reads: a copy the file has no mark for is marked then, as it would have
  // been with the file readable, instead of reading whole for good.
  describe('a copy found already there while the file cannot be read: the file\'s mark stands, and it is marked only when the file has none (round 4)', () => {
    // What the folder work does for such a copy: the mark made before the copy, then this.
    const present = (m: CodexCarryMarks, realm: string, dir: string, id: string, at: number) => { m.record(realm, dir, id, at); m.markIfNone(realm, dir, id, at) }

    it('is marked once the file reads when the file has none, keeps the file\'s own when it has one, and both are written', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'unavailable'
      box.text = doc([{ ...good, id: OTHER, at: AT - 50 }])
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      present(m, 'realm-b', SESSIONS, CID, AT + 100)
      present(m, 'realm-b', SESSIONS, OTHER, AT + 100)
      // Not known yet, and the folder carried into stays held to the first failed read meanwhile.
      expect(m.markOf(SESSIONS, CID)).toBeUndefined()
      expect(m.markOf(SESSIONS, OTHER)).toBeUndefined()
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      expect(m.cutoff(C_DIR, CID)).toBeNull()
      expect(box.writes).toBe(0)
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 100)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT - 50)
      const again = createCodexCarryMarks({ platform: 'win32', port })
      expect(again.cutoff(SESSIONS, CID)).toBe(AT + 100)
      expect(again.cutoff(SESSIONS, OTHER)).toBe(AT - 50)
    })

    it('found there again before the file reads, the first time is kept; a carry that copies it after wins', () => {
      for (const copiedAfter of [false, true]) {
        const { box, port } = memoryPort()
        const t = clock(AT)
        box.kind = 'unavailable'
        const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
        present(m, 'realm-b', SESSIONS, CID, AT + 100)
        present(m, 'realm-b', SESSIONS, CID, AT + 200)
        if (copiedAfter) m.record('realm-b', SESSIONS, CID, AT + 300)
        box.kind = null
        t.set(AT + 60_000)
        expect(m.cutoff(SESSIONS, CID), String(copiedAfter)).toBe(copiedAfter ? AT + 300 : AT + 100)
      }
    })

    it('a realm dropped before the file reads takes them with it; an adoption takes them to the new folder', () => {
      // Dropped: nothing is marked once the file reads.
      const d = memoryPort()
      const td = clock(AT)
      d.box.kind = 'unavailable'
      const dropped = createCodexCarryMarks({ platform: 'win32', port: d.port, now: td.now })
      present(dropped, 'realm-b', SESSIONS, CID, AT + 100)
      present(dropped, 'realm-c', C_DIR, CID, AT + 100)
      dropped.dropRealm('realm-b')
      d.box.kind = null
      td.set(AT + 60_000)
      expect(dropped.cutoff(SESSIONS, CID)).toBeNull()
      expect(dropped.cutoff(C_DIR, CID)).toBe(AT + 100)
      // Adopted (a Sign in again after the carry): the new folder is marked as the old one is, from the file's mark when it has one.
      const NEW_DIR = 'C:\\Users\\u\\new\\sessions'
      for (const fileMark of [null, AT - 50]) {
        const a = memoryPort()
        const ta = clock(AT)
        a.box.kind = 'unavailable'
        a.box.text = fileMark === null ? null : doc([{ ...good, at: fileMark }])
        const m = createCodexCarryMarks({ platform: 'win32', port: a.port, now: ta.now })
        present(m, 'realm-b', SESSIONS, CID, AT + 100)
        m.adopt('realm-b', 'realm-new', NEW_DIR)
        a.box.kind = null
        ta.set(AT + 60_000)
        expect(m.cutoff(SESSIONS, CID), String(fileMark)).toBe(fileMark ?? AT + 100)
        expect(m.cutoff(NEW_DIR, CID), String(fileMark)).toBe(fileMark ?? AT + 100)
      }
      // The new folder already had one for that copy: the later time is kept, as an adoption keeps a mark's.
      const l = memoryPort()
      const tl = clock(AT)
      l.box.kind = 'unavailable'
      const later = createCodexCarryMarks({ platform: 'win32', port: l.port, now: tl.now })
      present(later, 'realm-new', NEW_DIR, CID, AT + 100)
      present(later, 'realm-b', SESSIONS, CID, AT + 200)
      later.adopt('realm-b', 'realm-new', NEW_DIR)
      l.box.kind = null
      tl.set(AT + 60_000)
      expect(later.cutoff(NEW_DIR, CID)).toBe(AT + 200)
    })

    it('past its bound, the mark made for the carry stays (it only hides more)', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'unavailable'
      box.text = doc(Array.from({ length: 65 }, (_, i) => ({ ...good, id: idN(i), at: AT - 50 })))
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      for (let i = 0; i < 65; i++) present(m, 'realm-b', SESSIONS, idN(i), AT + 100)
      expect(m.markOf(SESSIONS, idN(63))).toBeUndefined()
      expect(m.markOf(SESSIONS, idN(64))).toBe(AT + 100)
      // An adoption with the bound reached: the new folder's are marked now too.
      const NEW_DIR = 'C:\\Users\\u\\new\\sessions'
      m.adopt('realm-b', 'realm-new', NEW_DIR)
      box.kind = null
      t.set(AT + 60_000)
      expect(m.cutoff(SESSIONS, idN(0))).toBe(AT - 50)
      expect(m.cutoff(SESSIONS, idN(63))).toBe(AT - 50)
      expect(m.cutoff(SESSIONS, idN(64))).toBe(AT + 100)
      expect(m.cutoff(NEW_DIR, idN(0))).toBe(AT + 100)
      expect(m.cutoff(NEW_DIR, idN(64))).toBe(AT + 100)
    })

    it('with the file read, it keeps the mark a copy has and marks one that has none (written); it refuses what is not a mark', () => {
      const m = createCodexCarryMarks({ platform: 'win32' })
      m.record('realm-b', SESSIONS, CID, AT)
      m.markIfNone('realm-b', SESSIONS, CID, AT + 100)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      m.markIfNone('realm-b', SESSIONS, OTHER, AT + 100)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 100)
      const notMarks: Array<[string, string, string, number]> = [['', SESSIONS, idN(5), AT], ['realm-b', '', idN(5), AT], ['realm-b', SESSIONS, 'x', AT], ['realm-b', SESSIONS, idN(5), Number.NaN]]
      for (const [realm, dir, id, at] of notMarks) expect(() => m.markIfNone(realm, dir, id, at)).not.toThrow()
      expect(m.cutoff(SESSIONS, idN(5))).toBeNull()
      const { port } = memoryPort()
      createCodexCarryMarks({ platform: 'win32', port }).markIfNone('realm-b', SESSIONS, CID, AT)
      expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, CID)).toBe(AT)
    })
  })

  describe('a file that is not what was written fails closed, and is set aside and replaced in one step (rounds 2 and 3)', () => {
    const bad: Array<[string, string]> = [
      ['empty', ''], ['junk', 'not json'], ['an array', '[]'], ['null', 'null'],
      ['another schema', doc([good]).replace('"schema":1', '"schema":2')], ['no schema', JSON.stringify({ marks: [good] })],
      ['no marks', JSON.stringify({ schema: 1 })], ['marks not a list', JSON.stringify({ schema: 1, marks: { good } })],
      ['too long', 'x'.repeat(CODEX_CARRY_MARKS_FILE_MAX_CHARS + 1)],
      ['more marks than are ever kept', doc(Array.from({ length: CODEX_CARRY_MARKS_MAX + 1 }, (_, i) => ({ ...good, id: idN(i) })))],
      ['a bad floor', doc([good], { floor: 'now' })], ['a floor out of range', doc([good], { floor: 9e15 })],
      ['a null entry', doc([good, null])], ['a number entry', doc([good, 7])], ['a text entry', doc([good, 'x'])], ['a list entry', doc([good, []])],
      ['a bad id', doc([good, { ...good, id: 'x' }])], ['a time that is text', doc([good, { ...good, at: 'now' }])], ['a time out of range', doc([good, { ...good, at: 9e15 }])],
      ['an empty realm', doc([good, { ...good, realm: '' }])], ['a realm with a space', doc([good, { ...good, realm: 'a b' }])],
      ['an empty folder', doc([good, { ...good, dir: '' }])], ['a folder too long', doc([good, { ...good, dir: 'x'.repeat(5000) }])],
      ['a missing field', doc([good, { realm: 'realm-b', dir: SESSIONS, id: CID }])],
    ]
    for (const [name, text] of bad) {
      it(`${name}: set aside once, never read, no floor lost, and the store works from empty`, () => {
        const { box, port } = memoryPort()
        const t = clock(AT + 500)
        box.text = text
        const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
        // Nothing of the file is taken, and the rollouts are closed to everything before now.
        expect(m.markOf(SESSIONS, CID)).toBeNull()
        expect(m.cutoff(SESSIONS, CID)).toBe(AT + 500)
        expect(m.cutoff(C_DIR, OTHER)).toBe(AT + 500)
        expect(box.asides).toBe(1)
        // The floor is kept in the file that replaced it.
        expect(JSON.parse(box.text!)).toEqual({ schema: 1, floor: AT + 500, marks: [] })
        // And a mark after it still counts, later than the floor.
        expect(m.record('realm-b', SESSIONS, CID, AT + 900)).toBe(true)
        expect(m.cutoff(SESSIONS, CID)).toBe(AT + 900)
        expect(m.cutoff(C_DIR, OTHER)).toBe(AT + 500)
        expect(JSON.parse(box.text!)).toMatchObject({ floor: AT + 500 })
      })
    }

    it('a file that is not a plain file within its cap (the port says corrupt) is treated the same', () => {
      const { box, port } = memoryPort()
      box.kind = 'corrupt'
      const m = createCodexCarryMarks({ platform: 'win32', port, now: clock(AT + 500).now })
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 500)
      expect(box.asides).toBe(1)
    })

    it('a file that cannot be set aside and replaced is not overwritten: carries go on, readers are held by time, and it is asked again after a wait (H2)', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.text = 'junk'
      box.asideFails = true
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      // Nothing carried into any folder yet in this run: nothing is held.
      expect(m.cutoff(SESSIONS, OTHER)).toBeNull()
      expect(m.record('realm-b', SESSIONS, CID, AT + 10)).toBe(true)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 10)
      expect(box.writes).toBe(0)
      expect(box.text).toBe('junk')
      const asides = box.asides
      expect(asides).toBe(1)
      for (let i = 0; i < 20; i++) m.cutoff(SESSIONS, CID)
      expect(box.asides).toBe(asides)
      box.asideFails = false
      t.set(AT + 60_000)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 60_000)
      expect(box.asides).toBe(asides + 1)
      // The replacement holds the floor and what was made meanwhile, in the one step; the file is not written again.
      expect(JSON.parse(box.asideTexts[0])).toEqual({ schema: 1, floor: AT + 60_000, marks: [{ realm: 'realm-b', dir: SESSIONS, id: CID, at: AT + 10 }] })
      expect(box.writes).toBe(0)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 60_000)
    })

    it('a set-aside whose replacement cannot be written stays closed, however often it is asked, and never reads as a file that is missing', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'corrupt'
      box.asideFails = true
      const log = vi.fn()
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now, log })
      m.record('realm-b', SESSIONS, CID, AT)
      for (let i = 0; i < 5; i++) { t.set(AT + (i + 1) * 40_000); expect(m.cutoff(SESSIONS, OTHER), String(i)).toBe(AT) }
      // Round 4 (the round 3 quality nit): three tries in a run, then it is left
      // where it is (one log line), not renamed aside and back every 30 seconds.
      expect(box.asides).toBe(3)
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0][0])).toMatch(/carry marks/)
      expect(box.reads).toBe(6)
      expect(box.writes).toBe(0)
      expect(box.kind).toBe('corrupt')
      // It is still read after each wait, so a file put right meanwhile is taken.
      box.kind = null
      box.text = doc([{ ...good, id: OTHER, at: AT - 50 }])
      t.set(AT + 300_000)
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT - 50)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      expect(box.asides).toBe(3)
      expect(log).toHaveBeenCalledTimes(1)
    })

    it('fewer than three failed set-asides in a run: it is tried again after the wait, and nothing is logged', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      box.kind = 'corrupt'
      box.asideFails = true
      const log = vi.fn()
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now, log })
      m.cutoff(SESSIONS, CID)
      t.set(AT + 40_000)
      m.cutoff(SESSIONS, CID)
      expect(box.asides).toBe(2)
      box.asideFails = false
      t.set(AT + 80_000)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT + 80_000)
      expect(box.asides).toBe(3)
      expect(log).not.toHaveBeenCalled()
    })

    it('reads own properties only: a polluted Object.prototype makes no entry or file valid', () => {
      const proto = Object.prototype as Record<string, unknown>
      const keys = ['schema', 'marks', 'realm', 'dir', 'id', 'at', 'floor']
      for (const k of keys) expect(Object.prototype.hasOwnProperty.call(proto, k), k).toBe(false)
      try {
        proto.realm = 'realm-b'
        proto.dir = SESSIONS
        proto.id = CID
        proto.at = AT
        // An entry that names none of its own would inherit a complete mark.
        const { box, port } = memoryPort()
        box.text = JSON.stringify({ schema: 1, marks: [{}] })
        const m = createCodexCarryMarks({ platform: 'win32', port, now: clock(AT + 7).now })
        expect(m.markOf(SESSIONS, CID)).toBeNull()
        expect(box.asides).toBe(1)
        // A file that names neither schema nor marks would inherit them.
        proto.schema = 1
        proto.marks = [good]
        const { box: box2, port: port2 } = memoryPort()
        box2.text = '{}'
        const m2 = createCodexCarryMarks({ platform: 'win32', port: port2, now: clock(AT + 7).now })
        expect(m2.markOf(SESSIONS, CID)).toBeNull()
        expect(box2.asides).toBe(1)
      } finally {
        for (const k of keys) delete proto[k]
      }
      for (const k of keys) expect(Object.prototype.hasOwnProperty.call(proto, k), k).toBe(false)
    })
  })

  it('a floor in the file holds for every rollout, and for a marked one the later of the two; it stays in what is written', () => {
    const { box, port } = memoryPort()
    box.text = doc([good], { floor: AT + 100 })
    const m = createCodexCarryMarks({ platform: 'win32', port })
    expect(m.cutoff(SESSIONS, CID)).toBe(AT + 100)
    expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 100)
    expect(m.markOf(SESSIONS, CID)).toBe(AT)
    m.record('realm-b', SESSIONS, OTHER, AT + 500)
    expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 500)
    expect(JSON.parse(box.text!)).toMatchObject({ floor: AT + 100 })
    expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, idN(77))).toBe(AT + 100)
  })

  it('the file is trimmed when it is written, oldest first, so it always fits what a read accepts', () => {
    const { box, port } = memoryPort()
    const m = createCodexCarryMarks({ platform: 'linux', port })
    const longDir = (n: number) => `/r/${'d'.repeat(4080)}${n}`
    for (let i = 0; i < CODEX_CARRY_MARKS_MAX; i++) expect(m.record('realm-b', longDir(i), idN(i), AT + i), String(i)).toBe(true)
    expect(box.text!.length).toBeLessThanOrEqual(CODEX_CARRY_MARKS_FILE_MAX_CHARS)
    // The oldest went, in the file and in memory; the newest stays; and a restart reads what was written.
    expect(m.cutoff(longDir(0), idN(0))).toBeNull()
    expect(m.cutoff(longDir(CODEX_CARRY_MARKS_MAX - 1), idN(CODEX_CARRY_MARKS_MAX - 1))).toBe(AT + CODEX_CARRY_MARKS_MAX - 1)
    const again = createCodexCarryMarks({ platform: 'linux', port })
    expect(again.cutoff(longDir(CODEX_CARRY_MARKS_MAX - 1), idN(CODEX_CARRY_MARKS_MAX - 1))).toBe(AT + CODEX_CARRY_MARKS_MAX - 1)
    expect(box.asides).toBe(0)
  })

  it('a mark taken back is taken out of the file too', () => {
    const { box, port } = memoryPort()
    const m = createCodexCarryMarks({ platform: 'win32', port })
    m.record('realm-b', SESSIONS, CID, AT)
    m.record('realm-b', SESSIONS, OTHER, AT + 1)
    m.remove(SESSIONS, CID)
    expect((JSON.parse(box.text!) as { marks: Array<{ id: string }> }).marks.map((x) => x.id)).toEqual([OTHER])
    expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, CID)).toBeNull()
  })

  it('nothing it does throws; a reading of its file that blows up closes the rollout, never opens it', () => {
    const exploding = { read: () => ({ get kind(): never { throw new Error('read') } }) as never, write: () => {}, setAside: () => false }
    const m = createCodexCarryMarks({ platform: 'win32', port: exploding })
    expect(m.cutoff(SESSIONS, CID)).toBe(Number.MAX_SAFE_INTEGER)
    expect(m.record('realm-b', SESSIONS, CID, AT)).toBe(false)
    expect(m.markOf(SESSIONS, CID)).toBeNull()
    expect(() => { m.remove(SESSIONS, CID); m.dropRealm('realm-b'); m.markIfNone('realm-b', SESSIONS, CID, AT) }).not.toThrow()
    expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(false)
  })

  it('a deleted marks file reads as no marks: a conversation marked before reads whole again (a recorded limit)', () => {
    const { box, port } = memoryPort()
    const m = createCodexCarryMarks({ platform: 'win32', port })
    m.record('realm-b', SESSIONS, CID, AT)
    expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, CID)).toBe(AT)
    box.text = null
    expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(SESSIONS, CID)).toBeNull()
  })

  describe('adopting a realm\'s marks for its replacement folder (a sign in again\'s history copy)', () => {
    it('records each mark of the old realm for the new folder, the later time kept, and leaves the old ones', () => {
      const m = createCodexCarryMarks({ platform: 'win32' })
      m.record('realm-b', SESSIONS, CID, AT)
      m.record('realm-b', SESSIONS, OTHER, AT + 5)
      m.record('realm-c', 'C:\\Users\\u\\x\\sessions', idN(5), AT + 6)
      m.record('realm-new', C_DIR, CID, AT + 50)
      expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(true)
      expect(m.cutoff(C_DIR, CID)).toBe(AT + 50)
      expect(m.cutoff(C_DIR, OTHER)).toBe(AT + 5)
      expect(m.cutoff(C_DIR, idN(5))).toBeNull()
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      // Dropping the new realm leaves the old one's.
      m.dropRealm('realm-new')
      expect(m.cutoff(C_DIR, OTHER)).toBeNull()
      expect(m.cutoff(SESSIONS, OTHER)).toBe(AT + 5)
    })

    it('is true with nothing to adopt, writes nothing then, and refuses what is not a realm or a folder', () => {
      const { box, port } = memoryPort()
      const m = createCodexCarryMarks({ platform: 'win32', port })
      expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(true)
      expect(box.writes).toBe(0)
      expect(m.adopt('realm-b', '', C_DIR)).toBe(false)
      expect(m.adopt('realm-b', 'realm-new', '')).toBe(false)
      expect(m.adopt(7 as never, 'realm-new', C_DIR)).toBe(false)
    })

    it('what it adopted is written, so a new store over the file finds it', () => {
      const { box, port } = memoryPort()
      const m = createCodexCarryMarks({ platform: 'win32', port })
      m.record('realm-b', SESSIONS, CID, AT)
      const writes = box.writes
      expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(true)
      expect(box.writes).toBe(writes + 1)
      expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(C_DIR, CID)).toBe(AT)
    })

    it('an adoption that cannot be written still stands for this run, and is written once the disk works again; it never fails', () => {
      const { box, port } = memoryPort()
      const t = clock(AT)
      const m = createCodexCarryMarks({ platform: 'win32', port, now: t.now })
      m.record('realm-b', SESSIONS, CID, AT)
      box.failWrite = true
      expect(m.adopt('realm-b', 'realm-new', C_DIR)).toBe(true)
      expect(m.cutoff(C_DIR, CID)).toBe(AT)
      expect(m.cutoff(SESSIONS, CID)).toBe(AT)
      box.failWrite = false
      t.set(AT + 60_000)
      m.cutoff(C_DIR, CID)
      expect(createCodexCarryMarks({ platform: 'win32', port }).cutoff(C_DIR, CID)).toBe(AT)
    })
  })

  describe('the newest time in a copy', () => {
    const NOW = Date.parse('2026-09-27T12:00:00Z')
    const line = (ts: unknown) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: {} })

    it('is the newest zoned time of any line of a tail; the first line may be cut', () => {
      const text = ['cut off half a line", "timestamp":"2026-09-27T11:59:00Z"}', line('2026-09-27T10:00:00Z'), line('2026-09-27T10:45:30.5Z'), line('2026-09-27T10:20:00+01:00'), 'not json "timestamp"'].join('\n')
      expect(newestStampInTail(text, NOW)).toBe(Date.parse('2026-09-27T10:45:30.5Z'))
    })

    it('ignores a time with no zone, a stamp that is not a time, one more than a week ahead, and non-text', () => {
      const text = [line('2026-09-27T11:00:00'), line('later'), line(7), line(null), line('2099-01-01T00:00:00Z'), line('2026-09-27T09:00:00Z')].join('\n')
      expect(newestStampInTail(text, NOW)).toBe(Date.parse('2026-09-27T09:00:00Z'))
      expect(newestStampInTail([line('2026-09-27T11:00:00'), line('later')].join('\n'), NOW)).toBeNull()
      expect(newestStampInTail('', NOW)).toBeNull()
      expect(newestStampInTail(7 as never, NOW)).toBeNull()
      // A stamp up to a week past now is still a time (a clock that was ahead).
      expect(newestStampInTail(line('2026-10-02T12:00:00Z'), NOW)).toBe(Date.parse('2026-10-02T12:00:00Z'))
    })

    it('the package hands the realm folders the real read of a copy, unless a test gives its own', () => {
      const src = readFileSync(join(__dirname, '../../../../src/main/providers/codex/index.ts'), 'utf-8')
      expect(src).toMatch(/newestStamp: deps\.newestCopiedStamp \?\? \(\(dir, id\) => newestCarriedStamp\(dir, id,/)
    })

    // Round 3, H3: the last-seen reader reads a 256 KiB tail, then once a 2 MiB one;
    // the scan does the same, so a final line past 256 KiB still raises the mark.
    it('a final line over 256 KiB still raises the mark: the scan grows once to 2 MiB, as the reader does, and never past it', () => {
      const parent = mkdtempSync(join(tmpdir(), 'ccc-test-codex-p314r3-'))
      try {
        const day = join(parent, 'sessions', '2026', '09', '27')
        mkdirSync(day, { recursive: true })
        const meta = JSON.stringify({ timestamp: '2026-09-27T08:00:00Z', type: 'session_meta', payload: { id: CID, cwd: '/p', timestamp: '2026-09-27T08:00:00Z' } })
        const fat = (ts: string, bytes: number) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(bytes) } })
        const rollout = (...lines: string[]) => lines.join('\n') + '\n'
        const name = join(day, `rollout-2026-09-27T08-00-00-${CID}.jsonl`)
        // A last line of 300 KiB, newer than the line before it: past the first tail, inside the second.
        writeFileSync(name, rollout(meta, line('2026-09-27T10:00:00Z'), fat('2026-09-27T11:15:00Z', 300 * 1024)))
        expect(newestCarriedStamp(join(parent, 'sessions'), CID, NOW)).toBe(Date.parse('2026-09-27T11:15:00Z'))
        // A last line past the second tail as well: no complete line in it, so no time (the carry's own time is the mark).
        writeFileSync(name, rollout(meta, line('2026-09-27T10:00:00Z'), fat('2026-09-27T11:15:00Z', CODEX_USAGE_TAIL_MAX_BYTES + 1024)))
        expect(newestCarriedStamp(join(parent, 'sessions'), CID, NOW)).toBeNull()
        // A file that is all within the first tail is read once and whole.
        writeFileSync(name, rollout(meta, line('2026-09-27T10:00:00Z'), line('2026-09-27T11:15:00Z')))
        expect(newestCarriedStamp(join(parent, 'sessions'), CID, NOW)).toBe(Date.parse('2026-09-27T11:15:00Z'))
        // A last line within the first tail keeps being the newest, whatever came before it.
        writeFileSync(name, rollout(meta, fat('2026-09-27T09:00:00Z', 200 * 1024), line('2026-09-27T10:00:00Z')))
        expect(newestCarriedStamp(join(parent, 'sessions'), CID, NOW)).toBe(Date.parse('2026-09-27T10:00:00Z'))
      } finally {
        if (dirname(parent) === tmpdir() && basename(parent).startsWith('ccc-test-codex-p314r3-')) rmSync(parent, { recursive: true, force: true })
      }
    })

    it('is read from the copy of the conversation under a sessions folder, and from nothing else', () => {
      const parent = mkdtempSync(join(tmpdir(), 'ccc-test-codex-p314r2-'))
      try {
        const day = join(parent, 'sessions', '2026', '09', '27')
        mkdirSync(day, { recursive: true })
        writeFileSync(join(day, `rollout-2026-09-27T08-00-00-${CID}.jsonl`), [
          JSON.stringify({ timestamp: '2026-09-27T08:00:00Z', type: 'session_meta', payload: { id: CID, cwd: '/p', timestamp: '2026-09-27T08:00:00Z' } }),
          line('2026-09-27T10:00:00Z'), line('2026-09-27T11:15:00Z'),
        ].join('\n') + '\n')
        expect(newestCarriedStamp(join(parent, 'sessions'), CID, NOW)).toBe(Date.parse('2026-09-27T11:15:00Z'))
        expect(newestCarriedStamp(join(parent, 'sessions'), OTHER, NOW)).toBeNull()
        expect(newestCarriedStamp(join(parent, 'nope'), CID, NOW)).toBeNull()
        expect(newestCarriedStamp('', CID, NOW)).toBeNull()
      } finally {
        if (dirname(parent) === tmpdir() && basename(parent).startsWith('ccc-test-codex-p314r2-')) rmSync(parent, { recursive: true, force: true })
      }
    })
  })
})

describe('the last-seen reading of a carried conversation (ADR-023)', () => {
  const CID = '0198a0b0-1c2d-7e3f-8a4b-5c6d7e8f9a0b'
  const OTHER = '0198a0b0-1c2d-7e3f-8a4b-5c6d7e8f9a0c'
  const CARRIED_AT = Date.parse('2026-09-27T10:30:00Z')
  const file = (id = CID) => `${day('2026', '09', '27')}\\rollout-2026-09-27T08-00-00-${id}.jsonl`
  const A_PRO = { has_credits: true, unlimited: false, balance: '1250.0000000000' }
  // The earlier account's events (A: Pro, 1250 credits, 40%), then this one's (B: Plus, no credits, 5%).
  const aEvent = tokenCount('2026-09-27T10:00:00Z', limits(40, { plan_type: 'pro', credits: A_PRO }))
  const bEvent = tokenCount('2026-09-27T11:00:00Z', limits(5, { plan_type: 'plus', credits: null }))
  const marksAt = (at = CARRIED_AT, dir = SESSIONS, id = CID) => { const m = createCodexCarryMarks({ platform: 'win32' }); m.record('realm-b', dir, id, at); return m }
  const reading = (f: ReturnType<typeof fakeFs>, marks?: CodexCarryMarks) => readLastSeenAllowance(SESSIONS, f.port, NOW, undefined, marks)

  it('shows nothing of the earlier account until this one reports its own: no bars, no plan, no credits', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    // Without the mark the copy reads as the account's own (the control).
    const unmarked = (await reading(f))!
    expect([pct(unmarked), unmarked.planType, unmarked.credits]).toEqual([40, 'pro', { hasCredits: true, unlimited: false, balance: 1250 }])
    expect(await reading(f, marksAt())).toBeNull()
  })

  it('then shows this account\'s own event, with its own plan, bars and no credits', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent, bEvent))
    const r = (await reading(f, marksAt()))!
    expect([pct(r), r.planType, r.readingAt]).toEqual([5, 'plus', Date.parse('2026-09-27T11:00:00Z')])
    expect(Object.prototype.hasOwnProperty.call(r, 'credits')).toBe(false)
  })

  it('an event at the carry\'s own moment is the earlier account\'s; one a millisecond later is this one\'s', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T10:30:00.000Z', limits(11, { plan_type: 'pro' }))))
    expect(await reading(f, marksAt())).toBeNull()
    const g = fakeFs()
    g.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T10:30:00.001Z', limits(12, { plan_type: 'plus' }))))
    expect(pct((await reading(g, marksAt()))!)).toBe(12)
  })

  it('an event with no zoned time is no event in a carried conversation; a time with an offset is read as the instant it names', async () => {
    const f = fakeFs()
    // A zoneless stamp a day and more after the carry: after it in every time zone, so that ignoring it is the rule's doing and not the host's zone.
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-28T12:00:00', limits(21, { plan_type: 'plus' })), tokenCount('not a time', limits(22, { plan_type: 'plus' })), tokenCount('', limits(23, { plan_type: 'plus' }))))
    expect(await reading(f, marksAt())).toBeNull()
    const g = fakeFs()
    // 12:00 at +01:00 is 11:00 UTC: after the carry.
    g.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T12:00:00+01:00', limits(24, { plan_type: 'plus' }))))
    expect(pct((await reading(g, marksAt()))!)).toBe(24)
    // 11:00 at +01:00 is 10:00 UTC: before it.
    const h = fakeFs()
    h.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-27T11:00:00+01:00', limits(25, { plan_type: 'plus' }))))
    expect(await reading(h, marksAt())).toBeNull()
    // An unmarked rollout keeps reading a zoneless time as it always did.
    const k = fakeFs()
    k.file(file(), rollout(meta('2026-09-27T08:00:00Z'), tokenCount('2026-09-28T12:00:00', limits(26, { plan_type: 'plus' }))))
    expect(pct((await reading(k))!)).toBe(26)
  })

  it('while the marks cannot be read the history is still read: no card is an error, a folder nothing was carried into reads whole, one carried into is held (round 3)', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    // The first failed read happens between A's event (10:00) and the carry (10:30).
    const FAILED_AT = Date.parse('2026-09-27T10:15:00Z')
    const unreadable = () => createCodexCarryMarks({ platform: 'win32', port: { read: () => ({ kind: 'unavailable' }), write: () => {}, setAside: () => false }, now: () => FAILED_AT })
    // Never carried into in this run: the figure shows, not an error.
    const open = unreadable()
    expect(await lookupLastSeenAllowance(SESSIONS, f.port, NOW, undefined, open)).toMatchObject({ ok: true })
    expect(pct((await reading(f, open))!)).toBe(40)
    const live = createCodexLiveUsage('win32')
    const ops = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW, marks: open })
    expect(await ops.lastSeen({ authRealmId: 'realm-' + '1'.repeat(32) })).toMatchObject({ ok: true })
    // Carried into (a carry goes on while the file cannot be read): held to the carry, an event after it counts, and it is never an error.
    const held = unreadable()
    expect(held.record('realm-b', SESSIONS, CID, CARRIED_AT)).toBe(true)
    expect(await lookupLastSeenAllowance(SESSIONS, f.port, NOW, undefined, held)).toEqual({ ok: true, reading: null })
    const g = fakeFs()
    g.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent, bEvent))
    expect(pct((await reading(g, held))!)).toBe(5)
    // Another conversation of the same folder is held to the first failed read (10:15): A's old events do not count there either.
    const h2 = fakeFs()
    h2.file(file(OTHER), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    expect(await reading(h2, held)).toBeNull()
    // And it is not cached as an answer: once the marks read, the held mark is written and still rules.
    const box: { text: string | null } = { text: null }
    let readable = false
    const flaky = createCodexCarryMarks({ platform: 'win32', port: { read: () => (readable ? { kind: 'missing' } : { kind: 'unavailable' }), write: (t) => { box.text = t }, setAside: () => false }, now: () => FAILED_AT + (readable ? 120_000 : 0) })
    const heldCache = new Map<string, { fingerprint: string; reading: AllowanceReading | null }>()
    const cache = { get: (dir: string) => heldCache.get(dir), set: (dir: string, v: { fingerprint: string; reading: AllowanceReading | null }) => { heldCache.set(dir, v) } }
    flaky.record('realm-b', SESSIONS, CID, CARRIED_AT)
    expect(await readLastSeenAllowance(SESSIONS, f.port, NOW, cache, flaky)).toBeNull()
    readable = true
    expect(await readLastSeenAllowance(SESSIONS, f.port, NOW, cache, flaky)).toBeNull()
    expect(JSON.parse(box.text!)).toMatchObject({ marks: [{ id: CID, at: CARRIED_AT }] })
  })

  it('a floor holds for every rollout of the folder: nothing dated before it counts, a later event does', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent, bEvent))
    const withFloor = (floor: number) => createCodexCarryMarks({ platform: 'win32', port: { read: () => ({ kind: 'ok', text: JSON.stringify({ schema: 1, floor, marks: [] }) }), write: () => {}, setAside: () => false } })
    // A floor between A's event (10:00) and B's (11:00).
    const r = (await reading(f, withFloor(CARRIED_AT)))!
    expect([pct(r), r.planType]).toEqual([5, 'plus'])
    // A floor after both: nothing of the rollout counts.
    expect(await reading(f, withFloor(Date.parse('2026-09-27T11:30:00Z')))).toBeNull()
  })

  it('a mark applies to its own conversation in its own folder only', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    // Another conversation's mark, another folder's mark, a mark with no conversation: the copy reads as it is.
    for (const marks of [marksAt(CARRIED_AT, SESSIONS, OTHER), marksAt(CARRIED_AT, 'C:\\Users\\u\\other\\sessions'), createCodexCarryMarks({ platform: 'win32' })]) {
      expect(pct((await reading(f, marks))!)).toBe(40)
    }
    // Another conversation's rollout in the same folder is read whole.
    const g = fakeFs()
    g.file(file(OTHER), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    expect(pct((await reading(g, marksAt()))!)).toBe(40)
  })

  it('A, then B, then A again: the copy brought back to A shows A\'s own events after that, not B\'s', async () => {
    // A's folder holds the whole conversation: A's earlier events, B's, then A's own after coming back at 12:30.
    const f = fakeFs()
    f.file(file(), rollout(
      meta('2026-09-27T08:00:00Z'),
      tokenCount('2026-09-27T09:00:00Z', limits(10, { plan_type: 'pro', credits: A_PRO })),
      bEvent,
    ))
    const back = Date.parse('2026-09-27T12:30:00Z')
    expect(await reading(f, marksAt(back))).toBeNull()
    f.grow(file(), '\n' + tokenCount('2026-09-27T12:45:00Z', limits(14, { plan_type: 'pro', credits: A_PRO })) + '\n')
    const r = (await reading(f, marksAt(back)))!
    expect([pct(r), r.planType, r.credits]).toEqual([14, 'pro', { hasCredits: true, unlimited: false, balance: 1250 }])
  })

  it('a reading cached before the carry is not reused after it', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    const held = new Map<string, { fingerprint: string; reading: AllowanceReading | null }>()
    const cache = { get: (dir: string) => held.get(dir), set: (dir: string, v: { fingerprint: string; reading: AllowanceReading | null }) => { held.set(dir, v) } }
    const marks = createCodexCarryMarks({ platform: 'win32' })
    expect(pct((await readLastSeenAllowance(SESSIONS, f.port, NOW, cache, marks))!)).toBe(40)
    marks.record('realm-b', SESSIONS, CID, CARRIED_AT)
    expect(await readLastSeenAllowance(SESSIONS, f.port, NOW, cache, marks)).toBeNull()
    // And the same again, from the cache now.
    expect(await readLastSeenAllowance(SESSIONS, f.port, NOW, cache, marks)).toBeNull()
  })

  it('the usage port honours the marks: last-seen shows none of the earlier account\'s figures', async () => {
    const f = fakeFs()
    f.file(file(), rollout(meta('2026-09-27T08:00:00Z'), aEvent))
    const live = createCodexLiveUsage('win32')
    const realm = { authRealmId: 'realm-' + '1'.repeat(32) }
    const marked = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW, marks: marksAt() })
    expect(await marked.lastSeen(realm)).toEqual({ ok: true, reading: null })
    const plain = createCodexUsageOperations({ sessionsDir: async () => SESSIONS, fs: f.port, live, now: () => NOW })
    const seen = await plain.lastSeen(realm)
    expect(seen.ok && seen.reading?.planLabel).toBe('Pro')
  })
})
