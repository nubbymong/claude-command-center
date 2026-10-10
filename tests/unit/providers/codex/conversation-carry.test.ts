// HOST QUARANTINE: plants junctions, symbolic links and hard links. [CI] [VM] only -- never run on the owner's machine.
// P3.6 (row 22): a Codex conversation's rollout carried into another
// account's folder for a switched session. Real folders under the system temp
// folder (no Codex, no process): the source is P3.5's lookup in its own realm
// only, the copy lands at the same place in the destination, whole or not at
// all, never over anything, never through a link, bounded, and the carried
// copy resumes by id there (P3.5's resolveCodexResume).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, existsSync, statSync, lstatSync, linkSync, renameSync, unlinkSync, utimesSync, appendFileSync, rmdirSync, realpathSync, promises as fsp, type BigIntStats } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { tmpdir } from 'os'
import { carryCodexRollout, CODEX_CARRY_MAX_BYTES, CODEX_CARRY_STALE_TEMP_MS } from '../../../../src/main/providers/codex/conversation-carry'
import { resolveCodexResume } from '../../../../src/main/providers/codex/rollout-lookup'
import { createCodexRealmFolders, createCodexRealmLocks, resolveCodexRealmRoots, type CodexRealmFsPort, type CodexFsEntry } from '../../../../src/main/providers/codex/realm-folders'

const ID = '019dd000-0006-7000-8000-0000000000c1'
const PREFIX = 'ccc-p36-carry-'
const temps: string[] = []
// The system temp folder at its real path, as the app takes its own roots
// before any account folder is derived from them (realm-folders
// resolveCodexRealmRoots, the same realpathSync.native): the carry is handed
// canonical roots and refuses any other (below, "the input contract"). A CI
// runner's is not canonical (an 8.3 alias on Windows, /var -> /private/var on
// macOS).
const TMP = realpathSync.native(tmpdir())
const temp = (tag: string) => { const d = mkdtempSync(join(TMP, `${PREFIX}${tag}-`)); temps.push(d); return d }
// TEST CLEANUP GUARD: only a folder this file made (its own prefix, directly
// in the system temp folder) is removed, never a path the code under test
// computed.
afterEach(() => { for (const d of temps.splice(0)) if (dirname(d) === TMP && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true }) })

const meta = (id: string, cwd: string) => JSON.stringify({ timestamp: '2026-09-20T10:00:00.000Z', type: 'session_meta', payload: { id, cwd } }) + '\n'
const turn = (n: number) => JSON.stringify({ type: 'response_item', payload: { n } }) + '\n'
const NAME = `rollout-2026-09-20T03-00-00-${ID}.jsonl`

/** Two realm homes, the source holding the conversation in an older date folder. */
function realms(body = meta(ID, 'C:\\p\\demo') + turn(1) + turn(2)) {
  const from = temp('from')
  const to = temp('to')
  const day = join(from, 'sessions', '2026', '09', '20')
  mkdirSync(day, { recursive: true })
  const file = join(day, NAME)
  writeFileSync(file, body)
  return { from, to, file, body, dest: join(to, 'sessions', '2026', '09', '20', NAME) }
}
const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('.ccc-carry-')) : [])
/** A carry's temporary files, where it makes them (the sessions folder) and where the copy lands. */
const leftoversOf = (r: { to: string; dest: string }) => [...leftovers(join(r.to, 'sessions')), ...leftovers(dirname(r.dest))]
/** Removes the link at `p` (a junction on Windows; a symlink on POSIX, where
 *  rmdir refuses one with ENOTDIR), never what it leads to, and nothing else. */
const dropLink = (p: string) => {
  if (!lstatSync(p).isSymbolicLink()) throw new Error('not a link: ' + p)
  try { unlinkSync(p) } catch { rmdirSync(p) }
}

describe('carryCodexRollout', () => {
  it('copies the rollout byte for byte to the same place in the other account\'s folder, which resumes it by id', async () => {
    const r = realms()
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    expect(out).toEqual({ ok: true, carried: 'copied', bytes: Buffer.byteLength(r.body) })
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body)
    // A copy, never a second name of the source: the source is untouched.
    expect(statSync(r.dest).ino === statSync(r.file).ino && statSync(r.file).ino !== 0).toBe(false)
    expect(readFileSync(r.file, 'utf8')).toBe(r.body)
    expect(leftoversOf(r)).toEqual([])
    // P3.5's resume finds it by id in the destination realm.
    const resumed = resolveCodexResume({ uuid: ID, cwd: 'C:\\p\\demo' }, { sessionsDir: join(r.to, 'sessions'), configuredCwd: r.to, dirExists: () => false })
    expect(resumed).toMatchObject({ resumeId: ID, path: r.dest })
  })

  it('makes the destination\'s sessions folders when absent, owner-only where the platform keeps modes', async () => {
    const r = realms()
    await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    if (process.platform !== 'win32') {
      for (const d of [join(r.to, 'sessions'), dirname(r.dest)]) expect(statSync(d).mode & 0o077).toBe(0)
      expect(statSync(r.dest).mode & 0o077).toBe(0)
    }
    expect(lstatSync(dirname(r.dest)).isDirectory()).toBe(true)
  })

  it('carries whole lines only: a last line still being written is left out', async () => {
    const r = realms(meta(ID, '/p') + turn(1) + '{"type":"response_item","pay')
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    expect(out).toMatchObject({ ok: true, carried: 'copied' })
    expect(readFileSync(r.dest, 'utf8')).toBe(meta(ID, '/p') + turn(1))
  })

  it('the same conversation already there is left as it is (present); a copy that went its own way is refused and left too', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, r.body)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'present', bytes: Buffer.byteLength(r.body) })
    // The same length, other lines: it grew on its own there.
    const same = meta(ID, 'C:\\p\\demo') + turn(1) + turn(3)
    writeFileSync(r.dest, same)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'exists-different' })
    expect(readFileSync(r.dest, 'utf8')).toBe(same)
    // Longer than the conversation here: it went on without this account.
    const longer = r.body + turn(9)
    writeFileSync(r.dest, longer)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'exists-different' })
    expect(readFileSync(r.dest, 'utf8')).toBe(longer)
    // Shorter, but not the start of this conversation.
    const other = meta(ID, 'C:\\p\\demo') + turn(7)
    writeFileSync(r.dest, other)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'exists-different' })
    expect(readFileSync(r.dest, 'utf8')).toBe(other)
    expect(leftoversOf(r)).toEqual([])
  })

  it('A -> B -> A: an earlier copy that is exactly the start of this conversation is brought up to date with the lines said since', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    // The account held the conversation up to the switch away from it.
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    writeFileSync(r.dest, older)
    const ino = statSync(r.dest).ino
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'extended', bytes: Buffer.byteLength(r.body) })
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body)
    // The whole copy under that name (ADR-009 round 1, A3: nothing is ever
    // written through the earlier copy); the source untouched.
    expect(statSync(r.dest).ino === ino && ino !== 0).toBe(false)
    expect(readFileSync(r.file, 'utf8')).toBe(r.body)
    expect(leftoversOf(r)).toEqual([])
    // Asked again: now the same conversation, present.
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'present', bytes: Buffer.byteLength(r.body) })
    // Only whole lines are added: a last line still being written stays out.
    const r2 = realms(meta(ID, '/p') + turn(1) + turn(2) + '{"type":"resp')
    mkdirSync(dirname(r2.dest), { recursive: true })
    writeFileSync(r2.dest, meta(ID, '/p'))
    expect(await carryCodexRollout({ fromSessionsDir: join(r2.from, 'sessions'), toHome: r2.to, id: ID })).toMatchObject({ ok: true, carried: 'extended' })
    expect(readFileSync(r2.dest, 'utf8')).toBe(meta(ID, '/p') + turn(1) + turn(2))
  })

  it('A (signed in again) -> B -> A: an earlier copy that shares its file with the account\'s kept earlier folder is brought up to date under this name alone; the earlier folder keeps what it had', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    // A staged sign in again carried the history over as second names of
    // the files in the account's kept earlier (retired) folder.
    const retiredDay = join(temp('retired'), 'sessions', '2026', '09', '20')
    mkdirSync(retiredDay, { recursive: true })
    const twin = join(retiredDay, NAME)
    writeFileSync(twin, older)
    linkSync(twin, r.dest)
    expect(statSync(r.dest).nlink).toBe(2)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'extended', bytes: Buffer.byteLength(r.body) })
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body)
    // Nothing written through the other name: the retired copy is as it was.
    expect(readFileSync(twin, 'utf8')).toBe(older)
    expect(statSync(twin).nlink).toBe(1)
    expect(statSync(r.dest).nlink).toBe(1)
    expect(leftoversOf(r)).toEqual([])
  })

  it('never writes through a link: one at the final name, or a destination folder that is a link or junction', async () => {
    const r = realms()
    const elsewhere = temp('elsewhere')
    mkdirSync(dirname(r.dest), { recursive: true })
    symlinkSync(elsewhere, r.dest, 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(readdirSync(elsewhere)).toEqual([])
    const r2 = realms()
    mkdirSync(join(r2.to, 'sessions', '2026', '09'), { recursive: true })
    symlinkSync(elsewhere, join(r2.to, 'sessions', '2026', '09', '20'), 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r2.from, 'sessions'), toHome: r2.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(readdirSync(elsewhere)).toEqual([])
    const r3 = realms()
    symlinkSync(elsewhere, join(r3.to, 'sessions'), 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r3.from, 'sessions'), toHome: r3.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('a destination home that is a link, or the source realm itself, is refused', async () => {
    const r = realms()
    const link = join(temp('link'), 'home')
    symlinkSync(r.to, link, 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: link, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(existsSync(join(r.to, 'sessions'))).toBe(false)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.from, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: 'relative\\home', id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
  })

  it('bounded: a rollout larger than the bound is refused and nothing is left behind', async () => {
    const r = realms(meta(ID, '/p') + turn(1).repeat(50))
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID, maxBytes: 200 })
    expect(out).toEqual({ ok: false, code: 'too-large' })
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
    // The bound can only be narrowed, never widened past the constant.
    expect(CODEX_CARRY_MAX_BYTES).toBe(256 * 1024 * 1024)
  })

  it('only the source realm\'s own conversation: an id it does not hold, a link inside it, a name and session_meta that disagree, or not an id at all', async () => {
    const r = realms()
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: '019dd000-0006-7000-8000-0000000000c2' })).toEqual({ ok: false, code: 'not-found' })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: `..\\..\\${ID}` })).toEqual({ ok: false, code: 'not-found' })
    // A day folder that is a junction to another realm's conversation.
    const other = temp('other')
    const otherDay = join(other, 'sessions', '2026', '09', '21')
    mkdirSync(otherDay, { recursive: true })
    const OTHER = '019dd000-0006-7000-8000-0000000000c3'
    writeFileSync(join(otherDay, `rollout-2026-09-21T03-00-00-${OTHER}.jsonl`), meta(OTHER, '/q'))
    symlinkSync(otherDay, join(r.from, 'sessions', '2026', '09', '21'), 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: OTHER })).toEqual({ ok: false, code: 'not-found' })
    // A file named for the id whose session_meta names another.
    const liar = realms(meta('019dd000-0006-7000-8000-0000000000c4', '/p') + turn(1))
    expect(await carryCodexRollout({ fromSessionsDir: join(liar.from, 'sessions'), toHome: liar.to, id: ID })).toEqual({ ok: false, code: 'not-found' })
    expect(existsSync(join(r.to, 'sessions'))).toBe(false)
  })

  it('a rollout with no complete line is not a conversation to carry', async () => {
    const r = realms('{"type":"session_meta"')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'not-found' })
    expect(existsSync(r.dest)).toBe(false)
  })
})

// ADR-009 thesis 4: nothing is read through a link. A sessions folder, a realm
// home or a rollout that is a link is not the realm's own conversation.
describe('carryCodexRollout reads only the source realm\'s own files', () => {
  it('a sessions folder, or a home above it, that is a junction to another realm\'s: not found, nothing written', async () => {
    const real = realms()
    const linkedSessions = join(temp('linked-sessions'), 'sessions')
    symlinkSync(join(real.from, 'sessions'), linkedSessions, 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: linkedSessions, toHome: real.to, id: ID })).toEqual({ ok: false, code: 'not-found' })
    const linkedHome = join(temp('linked-home'), 'home')
    symlinkSync(real.from, linkedHome, 'junction')
    expect(await carryCodexRollout({ fromSessionsDir: join(linkedHome, 'sessions'), toHome: real.to, id: ID })).toEqual({ ok: false, code: 'not-found' })
    expect(existsSync(join(real.to, 'sessions'))).toBe(false)
  })

  it('a rollout that is a symbolic link to a file elsewhere: not found (skipped where the host may not make file links; CI and VM run it)', async (ctx) => {
    const r = realms()
    const elsewhere = join(temp('elsewhere-file'), NAME)
    writeFileSync(elsewhere, r.body)
    rmSync(r.file)
    try { symlinkSync(elsewhere, r.file, 'file') } catch (e) {
      if ((e as { code?: string }).code === 'EPERM') { ctx.skip(); return }
      throw e
    }
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'not-found' })
    expect(existsSync(r.dest)).toBe(false)
  })
})

// ADR-009 theses 6 and 8: a file or folder swapped after the checks. Each is
// staged at the moment the check guards, through the file system calls the
// carry makes (the real calls run; only the swap is added).
describe('carryCodexRollout when something is swapped after its checks', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const realOpen = fsp.open.bind(fsp)
  const realLink = fsp.link.bind(fsp)
  const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase()
  const isTemp = (p: unknown) => basename(String(p)).startsWith('.ccc-carry-')
  type Handle = Awaited<ReturnType<typeof fsp.open>>
  type Open = (p: unknown, flags?: unknown, mode?: unknown) => Promise<Handle>
  const onOpen = (fn: (p: unknown, flags: unknown, open: () => Promise<Handle>) => Promise<Handle>) =>
    vi.spyOn(fsp, 'open').mockImplementation(((p: unknown, flags?: unknown, mode?: unknown) => fn(p, flags, () => (realOpen as unknown as Open)(p, flags, mode))) as never)

  it('the source swapped for another file just as it is opened (and back after): refused, nothing kept', async () => {
    const r = realms()
    const aside = temp('aside')
    let staged = false
    onOpen(async (p, _flags, open) => {
      if (staged || !same(p, r.file)) return open()
      staged = true
      renameSync(r.file, join(aside, 'looked-up.jsonl'))
      writeFileSync(r.file, meta(ID, 'C:\\p\\demo') + turn(66))
      const h = await open()
      // The file looked up is back at its name before anything is compared.
      renameSync(r.file, join(aside, 'forged.jsonl'))
      renameSync(join(aside, 'looked-up.jsonl'), r.file)
      return h
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
  })

  it('the source replaced while it was being copied: refused, and the temporary file goes', async () => {
    const r = realms()
    const aside = temp('aside')
    let staged = false
    onOpen(async (p, flags, open) => {
      const h = await open()
      if (!isTemp(p) || flags !== 'wx') return h
      const close = h.close.bind(h)
      ;(h as { close: () => Promise<void> }).close = async () => {
        await close()
        if (staged) return
        staged = true
        renameSync(r.file, join(aside, 'was.jsonl'))
        writeFileSync(r.file, r.body)
      }
      return h
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
  })

  it('the day folder swapped for a junction to a folder outside the realm just before the copy takes its name: nothing is left outside', async () => {
    const r = realms()
    const outside = temp('outside')
    const moved = join(outside, 'day')
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      renameSync(dirname(r.dest), moved)
      symlinkSync(moved, dirname(r.dest), 'junction')
      return realLink(a, b)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(readdirSync(moved)).toEqual([])
    expect(leftovers(join(r.to, 'sessions'))).toEqual([])
  })

  it('something else at the final name the moment after the copy took it: refused, and that file is not removed', async () => {
    const r = realms()
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      await realLink(a, b)
      // The final name only (the copy takes it from its second name).
      if (!same(b, r.dest)) return
      unlinkSync(b)
      writeFileSync(b, 'someone else\n')
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(readFileSync(r.dest, 'utf8')).toBe('someone else\n')
    expect(leftoversOf(r)).toEqual([])
  })

  // ADR-009 round 2 (C5, lens A N5): a new copy takes its final name from a
  // second name inside the day folder, so a folder swapped for a link as it
  // does lands nothing elsewhere, even for a moment.
  it('a new copy, the day folder swapped for a junction to a folder outside the realm just as it takes its final name: nothing of it lands there, even for a moment', async () => {
    const r = realms()
    const outside = temp('outside')
    const X = join(outside, 'X')
    mkdirSync(X)
    const day = dirname(r.dest)
    let staged = false
    let landedOutside = false
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      if (staged || !same(b, r.dest)) return realLink(a, b)
      staged = true
      renameSync(day, join(outside, 'realm-day'))
      symlinkSync(X, day, 'junction')
      try { await realLink(a, b) } finally { landedOutside = existsSync(join(X, NAME)) }
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(landedOutside).toBe(false)
    expect(readdirSync(X)).toEqual([])
  })

  // C5: a copy that did land elsewhere (its second name given a name there
  // too) is taken back from where it landed, a path taken right after it
  // landed, so a link re-pointed as it is taken back never leaves it behind.
  it('a new copy that landed outside the realm, the junction re-pointed as it is taken back: it is taken back from where it landed, and no file elsewhere is removed', async () => {
    const r = realms()
    const outside = temp('outside')
    const X = join(outside, 'X')
    const Y = join(outside, 'Y')
    mkdirSync(X)
    mkdirSync(Y)
    const victim = join(Y, NAME)
    writeFileSync(victim, 'a file of that name elsewhere\n')
    const day = dirname(r.dest)
    const realmDay = join(outside, 'realm-day')
    let staged = false
    let armed = false
    let calls = 0
    // The re-point, when it runs, and anything that stopped it (a throw in
    // the spy is swallowed by the carry's canonical check).
    let repointed = false
    let repointError: unknown = null
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      if (staged || !same(b, r.dest)) return realLink(a, b)
      staged = true
      renameSync(day, realmDay)
      // The copy's second name, where the day folder went, given the same
      // name in X: the link through the junction then finds it.
      const moved = join(realmDay, basename(a))
      if (existsSync(moved)) linkSync(moved, join(X, basename(a)))
      symlinkSync(X, day, 'junction')
      await realLink(a, b)
      armed = true
    }) as never)
    const realNative = realpathSync.native
    vi.spyOn(realpathSync, 'native').mockImplementation(((p: string, o?: unknown) => {
      if (armed && same(p, r.dest) && ++calls === 2) {
        try { dropLink(day); symlinkSync(Y, day, 'junction'); repointed = true } catch (e) { repointError = e; throw e }
      }
      return (realNative as (p: string, o?: unknown) => string)(p, o)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(existsSync(join(X, NAME))).toBe(false)
    expect(readFileSync(victim, 'utf8')).toBe('a file of that name elsewhere\n')
    // The re-point bites only on a second resolve of the landing (the take-back
    // by its path resolved again; that mutant fails above). Here the landing
    // is resolved once, where it landed, and the re-point, had it run, ran
    // whole.
    expect(calls).toBe(1)
    expect(repointed).toBe(false)
    expect(repointError).toBeNull()
  })

  it('A -> B -> A with the day folder swapped for a junction to a copy outside the realm: that copy is never added to', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, older)
    const outside = temp('outside')
    mkdirSync(join(outside, 'day'))
    writeFileSync(join(outside, 'day', NAME), older)
    let staged = false
    onOpen(async (p, flags, open) => {
      if (!staged && isTemp(p) && flags === 'wx') {
        staged = true
        renameSync(dirname(r.dest), join(outside, 'realm-day'))
        symlinkSync(join(outside, 'day'), dirname(r.dest), 'junction')
      }
      return open()
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(join(outside, 'day', NAME), 'utf8')).toBe(older)
    expect(readFileSync(join(outside, 'realm-day', NAME), 'utf8')).toBe(older)
    expect(leftovers(join(r.to, 'sessions'))).toEqual([])
  })

  it('A -> B -> A where the earlier copy is swapped, as it is opened, for one that went its own way from the same start: that one is never written to', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, meta(ID, 'C:\\p\\demo') + turn(1))
    const aside = temp('aside')
    const diverged = meta(ID, 'C:\\p\\demo') + turn(1) + turn(8) + turn(8) + turn(8)
    let staged = false
    onOpen(async (p, flags, open) => {
      if (!staged && same(p, r.dest) && typeof flags === 'number') {
        staged = true
        renameSync(r.dest, join(aside, 'measured.jsonl'))
        writeFileSync(r.dest, diverged)
      }
      return open()
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(r.dest, 'utf8')).toBe(diverged)
    expect(leftoversOf(r)).toEqual([])
  })

  it('A -> B -> A where the CLI adds to that copy just before it is replaced: never replaced, and not said as carried', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, older)
    let staged = false
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      await realLink(a, b)
      if (!staged && dirname(b).toLowerCase() === dirname(r.dest).toLowerCase()) { staged = true; appendFileSync(r.dest, turn(5)) }
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(r.dest, 'utf8')).toBe(older + turn(5))
    expect(leftoversOf(r)).toEqual([])
  })

  it('A -> B -> A where the CLI adds to that copy just before it is opened: never written over, and not said as carried', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, older)
    let staged = false
    onOpen(async (p, flags, open) => {
      if (!staged && same(p, r.dest) && typeof flags === 'number') {
        staged = true
        appendFileSync(r.dest, turn(5))
      }
      return open()
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(r.dest, 'utf8')).toBe(older + turn(5))
    expect(leftoversOf(r)).toEqual([])
  })

  it('the same conversation there, but the CLI adds to it just before it is opened: not said as present (it has gone on there)', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, r.body)
    let staged = false
    onOpen(async (p, flags, open) => {
      if (!staged && same(p, r.dest) && typeof flags === 'number') {
        staged = true
        appendFileSync(r.dest, turn(5))
      }
      return open()
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body + turn(5))
    expect(leftoversOf(r)).toEqual([])
  })

  it('A -> B -> A where the CLI adds to that copy while it is compared: never written over, and not said as carried', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, older)
    let staged = false
    onOpen(async (p, flags, open) => {
      const h = await open()
      if (!same(p, r.dest) || typeof flags !== 'number') return h
      const read = h.read.bind(h) as (...a: unknown[]) => Promise<unknown>
      ;(h as unknown as { read: (...a: unknown[]) => Promise<unknown> }).read = async (...a: unknown[]) => {
        const got = await read(...a)
        if (!staged) { staged = true; appendFileSync(r.dest, turn(5)) }
        return got
      }
      return h
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    // turn(5) is as long as turn(2): an overwrite would leave the copy the
    // conversation's length and pass for carried.
    expect(readFileSync(r.dest, 'utf8')).toBe(older + turn(5))
    expect(leftoversOf(r)).toEqual([])
  })

  it('A (signed in again) -> B -> A with the day folder swapped for a junction to a copy outside the realm once the earlier copy is compared: nothing is renamed over that copy', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    const retiredDay = join(temp('retired'), 'sessions', '2026', '09', '20')
    mkdirSync(retiredDay, { recursive: true })
    writeFileSync(join(retiredDay, NAME), older)
    linkSync(join(retiredDay, NAME), r.dest)
    const outside = temp('outside')
    mkdirSync(join(outside, 'day'))
    writeFileSync(join(outside, 'day', NAME), older)
    let staged = false
    onOpen(async (p, flags, open) => {
      const h = await open()
      if (!same(p, r.dest) || typeof flags !== 'number') return h
      // Staged as the compared copy is let go (Windows renames no folder
      // while a file in it is open).
      const close = h.close.bind(h)
      ;(h as { close: () => Promise<void> }).close = async () => {
        await close()
        if (staged) return
        staged = true
        renameSync(dirname(r.dest), join(outside, 'realm-day'))
        symlinkSync(join(outside, 'day'), dirname(r.dest), 'junction')
      }
      return h
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readFileSync(join(outside, 'day', NAME), 'utf8')).toBe(older)
    expect(readFileSync(join(outside, 'realm-day', NAME), 'utf8')).toBe(older)
    expect(leftovers(join(r.to, 'sessions'))).toEqual([])
  })

  it('A (signed in again) -> B -> A with the day folder swapped for a junction outside the realm the moment the copy is renamed in: nothing is left outside', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    const retiredDay = join(temp('retired'), 'sessions', '2026', '09', '20')
    mkdirSync(retiredDay, { recursive: true })
    writeFileSync(join(retiredDay, NAME), older)
    linkSync(join(retiredDay, NAME), r.dest)
    const outside = temp('outside')
    mkdirSync(join(outside, 'day'))
    const realRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation((async (a: string, b: string) => {
      renameSync(dirname(r.dest), join(outside, 'realm-day'))
      symlinkSync(join(outside, 'day'), dirname(r.dest), 'junction')
      return realRename(a, b)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(readdirSync(join(outside, 'day'))).toEqual([])
    expect(readFileSync(join(outside, 'realm-day', NAME), 'utf8')).toBe(older)
    expect(readFileSync(join(retiredDay, NAME), 'utf8')).toBe(older)
    expect(leftovers(join(r.to, 'sessions'))).toEqual([])
  })

  // ADR-009 round 1, lens A (T1): the rename that brings an earlier copy up
  // to date runs inside the day folder, from a second name made and checked
  // there, so a folder swapped at that moment can replace no file elsewhere.
  it('A (signed in again) -> B -> A with the day folder swapped for a junction to a folder holding a file of that name the moment the copy is renamed in: that file is never replaced', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    const retiredDay = join(temp('retired'), 'sessions', '2026', '09', '20')
    mkdirSync(retiredDay, { recursive: true })
    writeFileSync(join(retiredDay, NAME), older)
    linkSync(join(retiredDay, NAME), r.dest)
    const outside = temp('outside')
    mkdirSync(join(outside, 'day'))
    const victim = join(outside, 'day', NAME)
    writeFileSync(victim, 'a file of this name outside the realm\n')
    const realRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation((async (a: string, b: string) => {
      renameSync(dirname(r.dest), join(outside, 'realm-day'))
      symlinkSync(join(outside, 'day'), dirname(r.dest), 'junction')
      return realRename(a, b)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(readFileSync(victim, 'utf8')).toBe('a file of this name outside the realm\n')
    expect(readdirSync(join(outside, 'day'))).toEqual([NAME])
    expect(readFileSync(join(outside, 'realm-day', NAME), 'utf8')).toBe(older)
    expect(readFileSync(join(retiredDay, NAME), 'utf8')).toBe(older)
  })

  // Lens A (T1b): a copy that did not land where it was meant to is taken
  // back only while the file at the path it really is now is the one written
  // here, so a link re-pointed meanwhile never turns the removal onto
  // another file.
  it('a copy that landed through a link, the link re-pointed as it is taken back: the file the link now leads to is never removed', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    const outside = temp('outside')
    const X = join(outside, 'X')
    const Y = join(outside, 'Y')
    mkdirSync(X)
    mkdirSync(Y)
    const victim = join(Y, NAME)
    writeFileSync(victim, 'a file of that name elsewhere\n')
    const day = dirname(r.dest)
    let armed = false
    let landed = false
    let repointError: unknown = null
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      renameSync(day, join(outside, 'realm-day'))
      symlinkSync(X, day, 'junction')
      await realLink(a, b)
      armed = true
      landed = true
    }) as never)
    const realNative = realpathSync.native
    vi.spyOn(realpathSync, 'native').mockImplementation(((p: string, o?: unknown) => {
      if (armed && same(p, r.dest)) {
        armed = false
        try { dropLink(day); symlinkSync(Y, day, 'junction') } catch (e) { repointError = e; throw e }
      }
      return (realNative as (p: string, o?: unknown) => string)(p, o)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(readFileSync(victim, 'utf8')).toBe('a file of that name elsewhere\n')
    // Staged: the copy's name landed through the swapped folder. The re-point
    // bites only if the landing is resolved again; had it run, it ran whole.
    expect(landed).toBe(true)
    expect(repointError).toBeNull()
    // Gate 3 (S3 NIT 1): on this code the landing is never resolved again (the
    // carry refuses before it), so the re-point never ran: still armed.
    expect(armed).toBe(true)
  })

  // ADR-009 round 2 (C5): the copy's second name, made through a day folder
  // swapped for a junction, is taken back from where it landed (a path taken
  // right after it landed), so a junction re-pointed meanwhile never leaves it
  // behind outside the realm.
  it('the second name landed outside the realm through a day folder swapped for a junction, re-pointed as it is taken back: it is taken back from where it landed', async () => {
    const r = realms()
    const outside = temp('outside')
    const X = join(outside, 'X')
    const Y = join(outside, 'Y')
    mkdirSync(X)
    mkdirSync(Y)
    const day = dirname(r.dest)
    const inDay = (p: unknown) => isTemp(p) && same(dirname(String(p)), day)
    let staged = false
    let seen = 0
    let repointed = false
    let repointError: unknown = null
    vi.spyOn(fsp, 'link').mockImplementation((async (a: string, b: string) => {
      if (staged || !inDay(b)) return realLink(a, b)
      staged = true
      renameSync(day, join(outside, 'realm-day'))
      symlinkSync(X, day, 'junction')
      return realLink(a, b)
    }) as never)
    const realNative = realpathSync.native
    vi.spyOn(realpathSync, 'native').mockImplementation(((p: string, o?: unknown) => {
      if (staged && inDay(p) && ++seen === 2) {
        try { dropLink(day); symlinkSync(Y, day, 'junction'); repointed = true } catch (e) { repointError = e; throw e }
      }
      return (realNative as (p: string, o?: unknown) => string)(p, o)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(staged).toBe(true)
    expect(readdirSync(X)).toEqual([])
    expect(readdirSync(Y)).toEqual([])
    // As above: the second name is resolved once, where it landed; the
    // re-point bites only on a second resolve (that mutant fails above).
    expect(seen).toBe(1)
    expect(repointed).toBe(false)
    expect(repointError).toBeNull()
  })

  // Lens A (T3): the earlier copy is compared through a handle, and the
  // folder toggled between the checks of where that handle's file is: the
  // copy outside is never written, and nothing is said as carried.
  it('A -> B -> A with the day folder toggled to a junction to a copy outside the realm and back around the checks: that copy is never written, and nothing is said as carried', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, older)
    const outside = temp('outside')
    const X = join(outside, 'X')
    mkdirSync(X)
    const victim = join(X, NAME)
    writeFileSync(victim, older)
    const day = dirname(r.dest)
    const aside = join(outside, 'realm-day')
    let srcCalls = 0
    let state: 'idle' | 'swapped' | 'done' = 'idle'
    const realNative = realpathSync.native
    vi.spyOn(realpathSync, 'native').mockImplementation(((p: string, o?: unknown) => {
      if (state === 'swapped' && same(p, r.dest)) { dropLink(day); renameSync(aside, day); state = 'done' }
      const v = (realNative as (p: string, o?: unknown) => string)(p, o)
      if (state === 'idle' && same(p, r.file) && ++srcCalls === 2) { renameSync(day, aside); symlinkSync(X, day, 'junction'); state = 'swapped' }
      return v
    }) as never)
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    // What it proves first: refused, and neither copy written.
    expect(out).toEqual({ ok: false, code: 'changed' })
    expect(readFileSync(victim, 'utf8')).toBe(older)
    expect(readFileSync(r.dest, 'utf8')).toBe(older)
    // And that it was staged: swapped around the checks, and toggled back.
    expect(state).toBe('done')
  })

  // Lens A (T2): the temporary file is checked to be in the realm's own
  // sessions folder before anything of the conversation is written to it.
  it('the sessions folder swapped for a junction just as the temporary file is made: nothing of the conversation is written there', async () => {
    const r = realms(meta(ID, 'C:\\p\\demo') + turn(1) + turn(2))
    mkdirSync(join(r.to, 'sessions'), { recursive: true })
    const outside = temp('outside')
    const X = join(outside, 'X')
    mkdirSync(X)
    let written = 0
    onOpen(async (p, flags, open) => {
      if (flags === 'wx' && isTemp(p)) {
        renameSync(join(r.to, 'sessions'), join(outside, 'realm-sessions'))
        symlinkSync(X, join(r.to, 'sessions'), 'junction')
        const h = await open()
        const write = h.write.bind(h) as (...a: unknown[]) => Promise<unknown>
        ;(h as unknown as { write: (...a: unknown[]) => Promise<unknown> }).write = async (...a: unknown[]) => { written++; return write(...a) }
        return h
      }
      return open()
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'changed' })
    expect(written).toBe(0)
    expect(readdirSync(X)).toEqual([])
  })

  // Quality: a rename a virus scanner or an indexer holds up is tried again, briefly.
  it('a rename held up for a moment (EPERM, EBUSY) is tried again; one held up for good is io-failed, and the earlier copy and its other name stay as they were', async () => {
    const r = realms()
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    mkdirSync(dirname(r.dest), { recursive: true })
    const retiredDay = join(temp('retired'), 'sessions', '2026', '09', '20')
    mkdirSync(retiredDay, { recursive: true })
    writeFileSync(join(retiredDay, NAME), older)
    linkSync(join(retiredDay, NAME), r.dest)
    const realRename = fsp.rename.bind(fsp)
    let refusals = 2
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (a: string, b: string) => {
      if (refusals-- > 0) throw Object.assign(new Error(refusals % 2 ? 'EPERM' : 'EBUSY'), { code: refusals % 2 ? 'EPERM' : 'EBUSY' })
      return realRename(a, b)
    }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'extended', bytes: Buffer.byteLength(r.body) })
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body)
    spy.mockRestore()
    const r2 = realms()
    mkdirSync(dirname(r2.dest), { recursive: true })
    const retired2 = join(temp('retired'), 'day')
    mkdirSync(retired2)
    writeFileSync(join(retired2, NAME), older)
    linkSync(join(retired2, NAME), r2.dest)
    let tries = 0
    vi.spyOn(fsp, 'rename').mockImplementation((async () => { tries++; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r2.from, 'sessions'), toHome: r2.to, id: ID })).toEqual({ ok: false, code: 'io-failed' })
    expect(tries).toBeGreaterThan(1)
    expect(tries).toBeLessThanOrEqual(5)
    expect(readFileSync(r2.dest, 'utf8')).toBe(older)
    expect(readFileSync(join(retired2, NAME), 'utf8')).toBe(older)
    expect(leftoversOf(r2)).toEqual([])
  })

  // ADR-009 round 1, B2 and A6: a carry the respawn no longer wants (it was
  // superseded, closed or ran out of time) stops at its next step.
  it('asked to stop part way (the respawn is no longer current): cancelled, nothing left behind', async () => {
    const r = realms(meta(ID, 'C:\\p\\demo') + turn(1).repeat(3000))
    let asked = 0
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID, shouldStop: () => ++asked > 2 })
    expect(out).toEqual({ ok: false, code: 'cancelled' })
    expect(asked).toBeGreaterThan(2)
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
    // A stop question that throws counts as stop.
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID, shouldStop: () => { throw new Error('x') } })).toEqual({ ok: false, code: 'cancelled' })
  })

  it('a copy that fails to take its name: io-failed, and the temporary file goes', async () => {
    const r = realms()
    vi.spyOn(fsp, 'link').mockImplementation((async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }) as never)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'io-failed' })
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
  })

  it('a volume that reports no file id: nothing is carried (what landed could not be told apart), and the temporary file still goes, by its own name', async () => {
    const r = realms()
    onOpen(async (p, flags, open) => {
      const h = await open()
      if (!isTemp(p) || flags !== 'wx') return h
      const stat = h.stat.bind(h)
      ;(h as unknown as { stat: (o?: unknown) => Promise<unknown> }).stat = async (o?: unknown) => {
        const s = await stat(o as never) as unknown as Record<string, unknown>
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: typeof s.ino === 'bigint' ? 0n : 0 })
      }
      return h
    })
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(existsSync(r.dest)).toBe(false)
    expect(leftoversOf(r)).toEqual([])
  })
})

// Quality 3: a carry that stopped part way (the app ended mid-copy) left its
// temporary file; the next carry into that realm removes it once it is stale.
describe('carryCodexRollout sweeps what a stopped carry left', () => {
  it('its own stale temporary files go; a fresh one, one not of its naming, and a folder stay', async () => {
    const r = realms()
    const sessions = join(r.to, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const old = new Date(Date.now() - CODEX_CARRY_STALE_TEMP_MS - 60_000)
    const stale = join(sessions, `.ccc-carry-${'a'.repeat(24)}.tmp`)
    writeFileSync(stale, 'x'.repeat(64))
    utimesSync(stale, old, old)
    const fresh = join(sessions, `.ccc-carry-${'b'.repeat(24)}.tmp`)
    writeFileSync(fresh, 'y')
    const notOurs = join(sessions, '.ccc-carry-notours.tmp')
    writeFileSync(notOurs, 'z')
    utimesSync(notOurs, old, old)
    const folder = join(sessions, `.ccc-carry-${'c'.repeat(24)}.tmp`)
    mkdirSync(folder)
    utimesSync(folder, old, old)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toMatchObject({ ok: true, carried: 'copied' })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(notOurs)).toBe(true)
    expect(existsSync(folder)).toBe(true)
    // Minutes, never a day: a carry in flight is never taken for a stale one.
    expect(CODEX_CARRY_STALE_TEMP_MS).toBeGreaterThanOrEqual(60_000)
    expect(CODEX_CARRY_STALE_TEMP_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  // ADR-009 round 2 (C3): a carry that stopped after its second name was made
  // left that name in the day folder; the next carry into that day removes it.
  it('a stale second name left in the day folder goes too; a fresh one stays', async () => {
    const r = realms()
    const day = dirname(r.dest)
    mkdirSync(day, { recursive: true })
    const old = new Date(Date.now() - CODEX_CARRY_STALE_TEMP_MS - 60_000)
    const stale = join(day, `.ccc-carry-${'d'.repeat(24)}.tmp`)
    writeFileSync(stale, 'x'.repeat(64))
    utimesSync(stale, old, old)
    const fresh = join(day, `.ccc-carry-${'e'.repeat(24)}.tmp`)
    writeFileSync(fresh, 'y')
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toMatchObject({ ok: true, carried: 'copied' })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('a stale one swapped for another file as it is removed: that file stays', async () => {
    const r = realms()
    const day = dirname(r.dest)
    mkdirSync(day, { recursive: true })
    const old = new Date(Date.now() - CODEX_CARRY_STALE_TEMP_MS - 60_000)
    const stale = join(day, `.ccc-carry-${'f'.repeat(24)}.tmp`)
    writeFileSync(stale, 'x'.repeat(64))
    utimesSync(stale, old, old)
    let swapped = false
    const ids: string[] = []
    const idOf = (p: string) => { const st = lstatSync(p, { bigint: true }); return `${st.dev}:${st.ino}` }
    const realNative = realpathSync.native
    const spy = vi.spyOn(realpathSync, 'native').mockImplementation(((p: string, o?: unknown) => {
      if (!swapped && String(p).toLowerCase() === stale.toLowerCase()) {
        swapped = true
        // Another file: made while the stale one still exists, then renamed
        // over it. Removing it and writing the name again is not another file
        // on Linux, where ext4 hands the freed inode number straight on.
        ids.push(idOf(stale))
        writeFileSync(`${stale}.next`, 'another file\n')
        renameSync(`${stale}.next`, stale)
        ids.push(idOf(stale))
      }
      return (realNative as (p: string, o?: unknown) => string)(p, o)
    }) as never)
    try {
      expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toMatchObject({ ok: true, carried: 'copied' })
    } finally {
      spy.mockRestore()
    }
    expect(swapped).toBe(true)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
    expect(readFileSync(stale, 'utf8')).toBe('another file\n')
  })
})

// P3.6 CI finding (1063e3d9): the roots the carry is handed. The carry takes
// no root through a link: it refuses one that is not at its own canonical
// path (the input contract), and the app hands it canonical ones, deriving
// every account folder from its roots taken at their real path first
// (realm-folders resolveCodexRealmRoots), with the same realpath flavour as
// the carry (realpathSync.native), so a resources folder reached through a
// link, a junction or an 8.3 short name above it still carries end to end.
describe('the roots the carry is handed', () => {
  const RA = `realm-${'a'.repeat(16)}`
  const RB = `realm-${'b'.repeat(16)}`
  /** The app's folder port on the real filesystem (as codex/index.ts builds it). */
  const realmFs = (): CodexRealmFsPort => {
    const entry = (s: BigIntStats): CodexFsEntry => ({
      kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
      dev: String(s.dev),
      ino: String(s.ino),
      mode: Number(s.mode & 0o7777n),
      nlink: Number(s.nlink),
    })
    return {
      platform: process.platform,
      realpath: (p) => realpathSync.native(p),
      lstat: (p) => entry(lstatSync(p, { bigint: true })),
      mkdirSecure: (d) => { mkdirSync(d, { recursive: true }) },
      mkdir: (d, mode) => { mkdirSync(d, { mode }) },
      chmod: () => {},
      readdir: (d) => readdirSync(d),
      unlink: (p) => unlinkSync(p),
      rmdir: (p) => rmdirSync(p),
    }
  }
  /** The switch's copy through the app's own path: roots resolved from the
   *  resources folder as typed, two managed accounts under them, the
   *  conversation carried from one to the other. */
  async function throughTheApp(typedResources: string, noHome: string) {
    const port = realmFs()
    const r = resolveCodexRealmRoots({ resourcesDir: typedResources, env: {}, homeDir: noHome }, port)
    if (!r.ok) return { result: r, resourcesDir: null as string | null, dest: null as string | null, body: '' }
    const root = join(r.roots.resourcesDir, 'codex-realms')
    const day = join(root, RA, 'sessions', '2026', '09', '20')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(root, RB))
    const body = meta(ID, 'C:\\p\\demo') + turn(1)
    writeFileSync(join(day, NAME), body)
    const record = (id: string) => ({ id, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${id}`, lifecycle: 'active' })
    const folders = createCodexRealmFolders({
      lookupRealm: async (ref) => ({ ok: true, realm: record(ref.authRealmId), roots: r.roots }) as never,
      fs: port,
      locks: createCodexRealmLocks(),
      carry: carryCodexRollout,
    })
    const result = await folders.copyConversation!({ authRealmId: RA }, { authRealmId: RB }, { id: ID })
    return { result, resourcesDir: r.roots.resourcesDir, dest: join(root, RB, 'sessions', '2026', '09', '20', NAME), body }
  }

  it('the input contract: a root reached through a link above it is not the realm\'s own (the source is not found, the destination refused, nothing written); the same roots at their real path carry', async () => {
    const base = temp('contract')
    const real = join(base, 'real')
    mkdirSync(real)
    const alias = join(base, 'alias')
    symlinkSync(real, alias, 'junction')
    const day = join(real, 'from', 'sessions', '2026', '09', '20')
    mkdirSync(day, { recursive: true })
    mkdirSync(join(real, 'to'))
    writeFileSync(join(day, NAME), meta(ID, '/p') + turn(1))
    expect(await carryCodexRollout({ fromSessionsDir: join(alias, 'from', 'sessions'), toHome: join(real, 'to'), id: ID })).toEqual({ ok: false, code: 'not-found' })
    expect(await carryCodexRollout({ fromSessionsDir: join(real, 'from', 'sessions'), toHome: join(alias, 'to'), id: ID })).toEqual({ ok: false, code: 'unsafe-path' })
    expect(readdirSync(join(real, 'to'))).toEqual([])
    expect(await carryCodexRollout({ fromSessionsDir: join(real, 'from', 'sessions'), toHome: join(real, 'to'), id: ID })).toMatchObject({ ok: true, carried: 'copied' })
  })

  it('the app\'s own path: a resources folder reached through a junction (a symlink on POSIX) above it resolves to its real path, and the conversation carries from one account to the other', async () => {
    const base = temp('roots')
    const real = join(base, 'real')
    mkdirSync(join(real, 'res'), { recursive: true })
    const alias = join(base, 'alias')
    symlinkSync(real, alias, 'junction')
    const out = await throughTheApp(join(alias, 'res'), join(base, 'no-home'))
    expect(out.resourcesDir).toBe(realpathSync.native(join(real, 'res')))
    expect(out.result).toEqual({ ok: true, carried: 'copied' })
    expect(readFileSync(out.dest!, 'utf8')).toBe(out.body)
  })

  // Skipped where the volume makes no 8.3 short names (they can be turned
  // off per volume); a CI Windows runner's temp folder is itself under one.
  it('the app\'s own path: a resources folder typed with an 8.3 short name resolves to the long name, and the conversation carries (Windows)', async (ctx) => {
    if (process.platform !== 'win32') { ctx.skip(); return }
    const base = temp('short')
    const longName = 'ccclongfoldernamefortest'
    mkdirSync(join(base, longName, 'res'), { recursive: true })
    const short = join(base, 'CCCLON~1')
    let hasShort = false
    try { hasShort = existsSync(short) && realpathSync.native(short).toLowerCase() === join(base, longName).toLowerCase() } catch { hasShort = false }
    if (!hasShort) { ctx.skip(); return }
    const out = await throughTheApp(join(short, 'res'), join(base, 'no-home'))
    expect(out.resourcesDir!.toLowerCase()).toBe(join(base, longName, 'res').toLowerCase())
    expect(out.result).toEqual({ ok: true, carried: 'copied' })
    expect(readFileSync(out.dest!, 'utf8')).toBe(out.body)
  })

  it('one realpath flavour on the whole path: the app\'s folder port, the carry and the lookup\'s folder identity take real paths with realpathSync.native (fs.promises.realpath has its semantics), never the JavaScript realpathSync, which keeps an 8.3 name', () => {
    const index = readFileSync(resolve(__dirname, '../../../../src/main/providers/codex/index.ts'), 'utf8')
    const port = index.slice(index.indexOf('function realRealmFsPort'), index.indexOf('function testAuthPorts'))
    expect(port).toContain('realpath: (p) => fs.realpathSync.native(p)')
    expect(port).toContain('realpath: (p) => fs.promises.realpath(p)')
    expect(port).not.toMatch(/realpathSync\(/)
    const carry = readFileSync(resolve(__dirname, '../../../../src/main/providers/codex/conversation-carry.ts'), 'utf8')
    expect(carry).toContain('realpathSync.native(')
    expect(carry).not.toMatch(/realpathSync\(/)
    // The folder identity a pick and a resume compare (codexFolderIdentity).
    const lookup = readFileSync(resolve(__dirname, '../../../../src/main/providers/codex/rollout-lookup.ts'), 'utf8')
    expect(lookup).toContain('real: fs.realpathSync.native(dir)')
    expect(lookup).not.toMatch(/realpathSync\(/)
  })
})
