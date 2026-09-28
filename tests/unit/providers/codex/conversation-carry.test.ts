// P3.6 (row 22): a Codex conversation's rollout carried into another
// account's folder for a switched session. Real folders under the system temp
// folder (no Codex, no process): the source is P3.5's lookup in its own realm
// only, the copy lands at the same place in the destination, whole or not at
// all, never over anything, never through a link, bounded, and the carried
// copy resumes by id there (P3.5's resolveCodexResume).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, existsSync, statSync, lstatSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { carryCodexRollout, CODEX_CARRY_MAX_BYTES } from '../../../../src/main/providers/codex/conversation-carry'
import { resolveCodexResume } from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0006-7000-8000-0000000000c1'
const PREFIX = 'ccc-p36-carry-'
const temps: string[] = []
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `${PREFIX}${tag}-`)); temps.push(d); return d }
// TEST CLEANUP GUARD: only a folder this file made (its own prefix, directly
// in the system temp folder) is removed, never a path the code under test
// computed.
afterEach(() => { for (const d of temps.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true }) })

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

describe('carryCodexRollout', () => {
  it('copies the rollout byte for byte to the same place in the other account\'s folder, which resumes it by id', async () => {
    const r = realms()
    const out = await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })
    expect(out).toEqual({ ok: true, carried: 'copied', bytes: Buffer.byteLength(r.body) })
    expect(readFileSync(r.dest, 'utf8')).toBe(r.body)
    // A copy, never a second name of the source: the source is untouched.
    expect(statSync(r.dest).ino === statSync(r.file).ino && statSync(r.file).ino !== 0).toBe(false)
    expect(readFileSync(r.file, 'utf8')).toBe(r.body)
    expect(leftovers(dirname(r.dest))).toEqual([])
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

  it('the same conversation already there is left as it is (present); a different one is refused and left too', async () => {
    const r = realms()
    mkdirSync(dirname(r.dest), { recursive: true })
    writeFileSync(r.dest, r.body)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: true, carried: 'present', bytes: Buffer.byteLength(r.body) })
    const older = meta(ID, 'C:\\p\\demo') + turn(1)
    writeFileSync(r.dest, older)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'exists-different' })
    expect(readFileSync(r.dest, 'utf8')).toBe(older)
    const same = meta(ID, 'C:\\p\\demo') + turn(1) + turn(3)
    writeFileSync(r.dest, same)
    expect(await carryCodexRollout({ fromSessionsDir: join(r.from, 'sessions'), toHome: r.to, id: ID })).toEqual({ ok: false, code: 'exists-different' })
    expect(readFileSync(r.dest, 'utf8')).toBe(same)
    expect(leftovers(dirname(r.dest))).toEqual([])
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
    expect(leftovers(dirname(r.dest))).toEqual([])
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
