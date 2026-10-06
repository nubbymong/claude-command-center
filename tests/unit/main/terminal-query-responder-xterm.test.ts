/**
 * [host] Main's answer to a Codex session's colour query, held against xterm.js
 * itself: @xterm/headless 6.0.0, the parser the renderer's xterm.js runs. For an
 * output stream fed to the responder in chunks, xterm.js reading the bytes main
 * forwards, together with main's own answers, does what xterm.js reading the
 * original bytes did: the same screen, its other answers (cursor position,
 * device attributes) the same and in the same order, every colour query
 * answered exactly once, and none answered by main after a colour SET.
 * Deterministic: fixed seeds and a bounded number of streams.
 */
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { createColorQueryResponder, type ReplyColors } from '../../../src/main/terminal-query-responder'

const ESC = '\x1b'
const ST = `${ESC}\\`
const BEL = '\x07'
const DARK: ReplyColors = { foreground: [0xee, 0xf2, 0xf7], background: [0x17, 0x1e, 0x27] }

let seed = 1
const rnd = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000 }
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]

const QUERIES = [`${ESC}]10;?${ST}`, `${ESC}]11;?${ST}`, `${ESC}]10;?${BEL}`, `${ESC}]11;?${BEL}`]
const COMPLETE = ['a', 'hello ', '\r\n', '\u{1F600}', 'Z', `${ESC}[31m`, `${ESC}[0m`, `${ESC}[?25l`, `${ESC}[?2026h`, `${ESC}[?2026l`,
  `${ESC}]0;title${BEL}`, `${ESC}]12;?${ST}`, `${ESC}]4;1;?${BEL}`, `${ESC}P$qm${ST}`, `${ESC}_Gx${ST}`, `${ESC}]8;;http://x${ST}`,
  `${ESC}[6n`, `${ESC}[c`, `${ESC}]110${BEL}`, `${ESC}]1x0;#ffffff${BEL}`]
const UNFINISHED = [ESC, `${ESC}[`, `${ESC}[3`, `${ESC}]2;t`, `${ESC}P`, `${ESC}_`, `${ESC}]1`, `${ESC}]10;`, `${ESC}]11;?`, '\u009d']
const SETS = [`${ESC}]10;rgb:ff/00/00${BEL}`, `${ESC}]11;#000000${ST}`, `${ESC}]010;rgb:ff/00/00${BEL}`, `${ESC}]00011;#123456${BEL}`,
  `\u009d11;#123456${BEL}`, `\u009d10;#654321\u009c`, `${ESC}]1\x1c0;#abcdef${ST}`, `${ESC}]10;?;?${BEL}`]

function stream(opts: { unfinished: boolean; sets: boolean }): string {
  let s = ''
  for (let j = 0, n = 1 + Math.floor(rnd() * 16); j < n; j++) {
    const x = rnd()
    if (x < 0.3) s += pick(QUERIES)
    else if (x < 0.45 && opts.unfinished) s += pick(UNFINISHED)
    else if (x < 0.55 && opts.sets) s += pick(SETS)
    else s += pick(COMPLETE)
  }
  return s + 'Z'
}

/** `s` in 1 to 5 chunks, cut at random places. */
function chunks(s: string): string[] {
  const cuts = [...new Set(Array.from({ length: Math.floor(rnd() * 5) }, () => Math.floor(rnd() * (s.length + 1))))].sort((a, b) => a - b)
  const out: string[] = []
  let prev = 0
  for (const c of cuts) { out.push(s.slice(prev, c)); prev = c }
  out.push(s.slice(prev))
  return out
}

/** What xterm.js does with `s`: its screen, its answers, and the OSC 10/11 it dispatches, in order. */
async function xterm(s: string) {
  const t = new Terminal({ cols: 60, rows: 6, scrollback: 50, allowProposedApi: true })
  const answers: string[] = []
  t.onData((d) => answers.push(d))
  const osc: Array<{ id: number; data: string }> = []
  for (const id of [10, 11]) t.parser.registerOscHandler(id, (data) => { osc.push({ id, data }); return false })
  await new Promise<void>((done) => t.write(s, done))
  const b = t.buffer.active
  const lines: string[] = []
  for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '')
  t.dispose()
  return { screen: lines.join('\n').replace(/\n+$/, ''), answers: answers.filter((a) => !/^\x1b\]1[01];rgb:/.test(a)), osc }
}

/** The colour queries (OSC 10/11 slots that are `?`) among `osc`, and how many come before the first slot that is anything else. */
function colourQueries(osc: Array<{ id: number; data: string }>) {
  let total = 0
  let beforeOther = -1
  for (const { id, data } of osc) {
    data.split(';').forEach((slot, k) => {
      if (id + k > 11) return
      if (slot === '?') total++
      else if (beforeOther < 0) beforeOther = total
    })
  }
  return { total, beforeOther: beforeOther < 0 ? total : beforeOther }
}

async function check(s: string) {
  const replies: string[] = []
  const r = createColorQueryResponder({ colors: () => DARK, reply: (b) => replies.push(b) })
  const fwd = chunks(s).map((c) => r.filter(c)).join('')
  const [orig, after] = await Promise.all([xterm(s), xterm(fwd)])
  const want = colourQueries(orig.osc)
  return {
    screen: orig.screen === after.screen,
    otherAnswers: JSON.stringify(orig.answers) === JSON.stringify(after.answers),
    eachQueryOnce: replies.length + colourQueries(after.osc).total === want.total,
    noAnswerAfterASet: replies.length <= want.beforeOther,
  }
}

async function fuzz(n: number, startSeed: number, opts: { unfinished: boolean; sets: boolean }) {
  seed = startSeed
  const failed: Record<string, string[]> = { screen: [], otherAnswers: [], eachQueryOnce: [], noAnswerAfterASet: [] }
  for (let k = 0; k < n; k++) {
    const s = stream(opts)
    const res = await check(s)
    for (const key of Object.keys(failed) as Array<keyof typeof res>) if (!res[key] && failed[key].length < 3) failed[key].push(JSON.stringify(s))
  }
  return failed
}

const NONE = { screen: [], otherAnswers: [], eachQueryOnce: [], noAnswerAfterASet: [] }

describe('xterm.js reading what main forwards does what it did with the original bytes', () => {
  it('an unfinished sequence before a query: the same screen and the same answers (W demos)', async () => {
    for (const s of [`${ESC}[${ESC}]10;?${ST}6n`, `${ESC}[3${ESC}]11;?${BEL}1mX`, `${ESC}]2;t${ESC}]10;?${ST}visible text`, `abc${ESC}${ESC}]10;?${BEL}c`]) {
      const res = await check(s + 'Z')
      expect(res, JSON.stringify(s)).toEqual({ screen: true, otherAnswers: true, eachQueryOnce: true, noAnswerAfterASet: true })
    }
  })

  it('a colour SET in a form xterm.js reads (leading zeros, the 8-bit introducer, a dropped control): no later query answered by main', async () => {
    for (const set of SETS) {
      const res = await check(`a${set}b${ESC}]10;?${ST}${ESC}]11;?${BEL}Z`)
      expect(res, JSON.stringify(set)).toEqual({ screen: true, otherAnswers: true, eachQueryOnce: true, noAnswerAfterASet: true })
    }
  })

  it('fuzz, complete sequences and colour SETs, in random chunks: no difference (seed 0x5eed1234, 80 streams)', async () => {
    expect(await fuzz(80, 0x5eed1234, { unfinished: false, sets: true })).toEqual(NONE)
  }, 120_000)

  it('fuzz, unfinished sequences and colour SETs too, in random chunks: no difference (seed 0x7a7a7a7a, 160 streams)', async () => {
    expect(await fuzz(160, 0x7a7a7a7a, { unfinished: true, sets: true })).toEqual(NONE)
  }, 120_000)
})
