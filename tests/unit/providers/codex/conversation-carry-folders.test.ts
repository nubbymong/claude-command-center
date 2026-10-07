// P3.6 (row 22; ADR-009 round 1, lens A T4 and T1): the carry makes and
// renames only where it means to. A folder it makes on the way to the copy's
// place, through a folder above it swapped for a junction just before, is not
// left outside the realm: the carry takes back that one folder (at the path
// it really is, only while it is the folder made and empty) and refuses; a
// folder it did not make is never taken back. And the second name it renames
// over an earlier copy is checked to be in the realm's own day folder as soon
// as it is made, so a day folder toggled to a junction and back around the
// later checks can never have a file of that name elsewhere replaced. Real
// folders under the system temp folder; only the module's mkdirSync and
// lstatSync are watched, to stage a swap at that moment.
import { describe, it, expect, afterEach, vi } from 'vitest'

const hook = vi.hoisted(() => ({
  onMkdir: null as null | ((p: string) => void),
  onLstat: null as null | ((p: string) => void),
}))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const mkdirSync = ((p: unknown, o?: unknown) => {
    const staged = hook.onMkdir
    if (staged) staged(String(p))
    return (real.mkdirSync as (p: unknown, o?: unknown) => unknown)(p, o)
  }) as typeof real.mkdirSync
  const lstatSync = ((p: unknown, o?: unknown) => {
    const staged = hook.onLstat
    if (staged) staged(String(p))
    return (real.lstatSync as (p: unknown, o?: unknown) => unknown)(p, o)
  }) as typeof real.lstatSync
  return { ...real, mkdirSync, lstatSync, default: { ...real, mkdirSync, lstatSync } }
})

const fsMod = await import('fs')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, renameSync, rmdirSync, existsSync, linkSync, realpathSync, lstatSync, unlinkSync, promises: fsp } = fsMod
const { join, dirname, basename } = await import('path')
const { tmpdir } = await import('os')
const { carryCodexRollout } = await import('../../../../src/main/providers/codex/conversation-carry')

const ID = '019dd000-0006-7000-8000-0000000000c1'
const PREFIX = 'ccc-p36-carryf-'
const NAME = `rollout-2026-09-20T03-00-00-${ID}.jsonl`
const temps: string[] = []
// The system temp folder at its real path, as the app takes its own roots
// before any account folder is derived from them (realm-folders
// resolveCodexRealmRoots, the same realpathSync.native): the carry is handed
// canonical roots and refuses any other. A CI runner's is not canonical (an
// 8.3 alias on Windows, /var -> /private/var on macOS).
const TMP = realpathSync.native(tmpdir())
const temp = (tag: string) => { const d = mkdtempSync(join(TMP, `${PREFIX}${tag}-`)); temps.push(d); return d }
// TEST CLEANUP GUARD: only a folder this file made (its own prefix, directly
// in the system temp folder) is removed, never a path the code under test
// computed.
afterEach(() => {
  hook.onMkdir = null
  hook.onLstat = null
  vi.restoreAllMocks()
  for (const d of temps.splice(0)) if (dirname(d) === TMP && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})

const line = (o: object) => JSON.stringify(o) + '\n'
const meta = line({ timestamp: '2026-09-20T10:00:00.000Z', type: 'session_meta', payload: { id: ID, cwd: '/p' } })
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** Removes the link at `p` (a junction on Windows; a symlink on POSIX, where
 *  rmdir refuses one with ENOTDIR), never what it leads to, and nothing else. */
const dropLink = (p: string) => {
  if (!lstatSync(p).isSymbolicLink()) throw new Error('not a link: ' + p)
  try { unlinkSync(p) } catch { rmdirSync(p) }
}

/** A source realm holding the conversation, and a destination home. */
function realms(body = meta + line({ n: 1 }) + line({ n: 2 })) {
  const from = temp('from')
  const to = temp('to')
  const day = join(from, 'sessions', '2026', '09', '20')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, NAME), body)
  return { from, to, dest: join(to, 'sessions', '2026', '09', '20', NAME) }
}

describe('carryCodexRollout makes folders only where it means to', () => {
  it('a year folder swapped for a junction just before the month folder is made: the month folder made outside is taken back, and nothing is carried', async () => {
    const r = realms()
    mkdirSync(join(r.to, 'sessions', '2026'), { recursive: true })
    const outside = temp('outside')
    const X = join(outside, 'X')
    mkdirSync(X)
    let staged = false
    hook.onMkdir = (p) => {
      if (staged || basename(p) !== '09') return
      staged = true
      renameSync(join(r.to, 'sessions', '2026'), join(outside, 'realm-2026'))
      symlinkSync(X, join(r.to, 'sessions', '2026'), 'junction')
    }
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(staged).toBe(true)
    expect(readdirSync(X)).toEqual([])
    expect(existsSync(join(outside, 'realm-2026', '09'))).toBe(false)
  })

  it('a folder that was already there is never taken back, even when it is not where it should be (and even when empty)', async () => {
    const r = realms()
    const X = join(temp('outside'), 'X')
    mkdirSync(X)
    mkdirSync(join(r.to, 'sessions'), { recursive: true })
    symlinkSync(X, join(r.to, 'sessions', '2026'), 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(existsSync(X)).toBe(true)
    expect(readdirSync(X)).toEqual([])
  })
})

describe('carryCodexRollout renames over an earlier copy only inside the realm', () => {
  it('the day folder toggled to a junction as the second name is made, back for the checks, and to the junction again for the rename: the file of that name outside is never replaced', async () => {
    const r = realms()
    const older = meta + line({ n: 1 })
    mkdirSync(dirname(r.dest), { recursive: true })
    const retiredDay = join(temp('retired'), 'day')
    mkdirSync(retiredDay)
    writeFileSync(join(retiredDay, NAME), older)
    linkSync(join(retiredDay, NAME), r.dest)
    const outside = temp('outside')
    const X = join(outside, 'X')
    mkdirSync(X)
    const victim = join(X, NAME)
    writeFileSync(victim, 'a file of that name outside the realm\n')
    const day = dirname(r.dest)
    const aside = join(outside, 'realm-day')
    const toJunction = () => { renameSync(day, aside); symlinkSync(X, day, 'junction') }
    const toReal = () => { dropLink(day); renameSync(aside, day) }
    let stage: 'idle' | 'linked' | 'checked' = 'idle'
    const realLink = fsp.link.bind(fsp)
    const realRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      if (stage === 'idle' && same(dirname(b), day)) { toJunction(); await realLink(a, b); stage = 'linked'; return }
      return realLink(a, b)
    }) as never)
    hook.onLstat = (p) => { if (stage === 'linked' && same(p, r.dest)) { toReal(); stage = 'checked' } }
    vi.spyOn(fsp, 'rename').mockImplementation((async (a: string, b: string) => {
      if (stage === 'checked') toJunction()
      return realRename(a, b)
    }) as never)
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    expect(stage).not.toBe('idle')
    expect(out).toEqual({ ok: false, code: 'changed' })
    expect(readFileSync(victim, 'utf8')).toBe('a file of that name outside the realm\n')
    expect(readFileSync(join(retiredDay, NAME), 'utf8')).toBe(older)
  })
})
