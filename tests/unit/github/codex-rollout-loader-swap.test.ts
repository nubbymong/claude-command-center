/**
 * P3.12 round 1: the GitHub Session Context loader of a Codex session reads
 * only the rollout it checked. Two swaps, each made by the file-system call
 * the loader makes at that step (real files in a fresh temp folder that only
 * this test removes):
 *  - A2: the day folder is put back as a junction to another folder after the
 *    folder check and before the file is looked at: the path read is the one
 *    the check built, and the opened file must sit in the real folder the
 *    check found, so nothing is read (and so when the checked folder is put
 *    back before that look: the file there is not the one opened);
 *  - A3 (adopted from the ADR-009 pass): the rollout is replaced by another
 *    file between lstat and open: the opened file is not the one lstat saw,
 *    so nothing is read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

type Call = 'lstat' | 'open' | 'realpath'
const swap = vi.hoisted(() => ({ hooks: [] as Array<{ call: string; at: string; run: () => void }> }))
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>()
  // The first hook for this call on this path runs once, just before the call.
  const once = (call: string, p: unknown) => {
    const i = swap.hooks.findIndex((h) => h.call === call && (h.at === '*' || h.at === String(p)))
    if (i >= 0) swap.hooks.splice(i, 1)[0].run()
  }
  const promises = {
    ...m.promises,
    lstat: (async (p: realFs.PathLike, ...rest: unknown[]) => { once('lstat', p); return (m.promises.lstat as (...a: unknown[]) => unknown)(p, ...rest) }) as typeof m.promises.lstat,
    open: (async (p: realFs.PathLike, ...rest: unknown[]) => { once('open', p); return (m.promises.open as (...a: unknown[]) => unknown)(p, ...rest) }) as typeof m.promises.open,
    realpath: (async (p: realFs.PathLike, ...rest: unknown[]) => { once('realpath', p); return (m.promises.realpath as (...a: unknown[]) => unknown)(p, ...rest) }) as typeof m.promises.realpath,
  }
  return { ...m, default: { ...m, promises }, promises }
})

const { loadCodexRolloutEvents } = await import('../../../src/main/github/session/codex-rollout-loader')

const PREFIX = 'ccc-p312-ghswap-'
const ID = '019dd000-0001-7000-8000-0000000000d1'
const NAME = `rollout-2026-09-30T10-00-00-${ID}.jsonl`
const L = (o: object) => JSON.stringify(o)
const said = (text: string) => L({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: text } }) + '\n'
let root: string
let sessions: string
let day: string
let file: string

beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), PREFIX))
  sessions = join(root, 'sessions')
  day = join(sessions, '2026', '09', '30')
  realFs.mkdirSync(day, { recursive: true })
  file = join(day, NAME)
  realFs.writeFileSync(file, said('own #1'))
  swap.hooks = []
})
const hook = (call: Call, at: string, run: () => void) => { swap.hooks.push({ call, at, run }) }
const moved = () => join(sessions, '2026', '09', 'moved')
/** The day folder put back as a junction to another folder, which holds a file of the rollout's name. */
function junctionElsewhere(): void {
  const elsewhere = join(root, 'elsewhere')
  realFs.mkdirSync(elsewhere, { recursive: true })
  realFs.writeFileSync(join(elsewhere, NAME), said('FOREIGN #666'))
  realFs.renameSync(day, moved())
  realFs.symlinkSync(elsewhere, day, 'junction')
}
/** The checked day folder back in its place. */
function realDayBack(): void {
  try { realFs.unlinkSync(day) } catch { realFs.rmdirSync(day) }
  realFs.renameSync(moved(), day)
}
afterEach(() => {
  // A junction left at the day folder is removed as a link, never walked into.
  try { if (realFs.lstatSync(day).isSymbolicLink()) realFs.rmSync(day) } catch { /* gone */ }
  if (basename(root).startsWith(PREFIX) && dirname(root) === tmpdir()) realFs.rmSync(root, { recursive: true, force: true })
})

describe('the Codex GitHub loader reads only the rollout it checked (P3.12 round 1)', () => {
  it('the rollout, unswapped: its words are read (the swaps below are what changes)', async () => {
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(ev.messages.map((m) => m.text)).toEqual(['own #1'])
  })

  it('A2: a day folder put in place of the checked one before the file is looked at: nothing is read', async () => {
    hook('lstat', file, junctionElsewhere)
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(swap.hooks).toEqual([])
    expect(ev.messages).toEqual([])
    expect(ev.toolCalls).toEqual([])
  })

  it('A2: the same, with the checked folder put back before the loader looks where the opened file sits: nothing is read', async () => {
    hook('lstat', file, junctionElsewhere)
    hook('realpath', file, realDayBack)
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(swap.hooks).toEqual([])
    expect(ev.messages).toEqual([])
  })

  it.runIf(process.platform === 'win32')('A2 (Windows): an input spelled in another case: the path looked at and read is the checked spelling', async () => {
    let looked = false
    hook('lstat', file, () => { looked = true })
    const upper = join(sessions.toUpperCase(), '2026', '09', '30', NAME)
    const ev = await loadCodexRolloutEvents({ path: upper, sessionsDir: sessions })
    expect(looked).toBe(true)
    expect(ev.messages.map((m) => m.text)).toEqual(['own #1'])
  })

  it('round 2 (W2): the day folder put in place of the checked one at the first real-path look: nothing is read', async () => {
    hook('realpath', '*', junctionElsewhere)
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(swap.hooks).toEqual([])
    expect(ev.messages).toEqual([])
  })

  it('round 2 (W2): no look is taken at the day folder\'s own real path (a swap there changes nothing read)', async () => {
    hook('realpath', day, junctionElsewhere)
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(swap.hooks).toHaveLength(1)
    expect(ev.messages.map((m) => m.text)).toEqual(['own #1'])
  })

  it('A3: the rollout replaced by another file between lstat and open: nothing is read', async () => {
    const foreign = join(root, 'foreign.jsonl')
    realFs.writeFileSync(foreign, said('FOREIGN #666'))
    hook('open', file, () => {
      realFs.unlinkSync(file)
      realFs.linkSync(foreign, file)
    })
    const ev = await loadCodexRolloutEvents({ path: file, sessionsDir: sessions })
    expect(swap.hooks).toEqual([])
    expect(ev.messages).toEqual([])
  })
})
