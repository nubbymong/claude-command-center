// P3.12 (row 32): Codex's resume picker names a conversation by the name file
// next to its rollout (`rollout-....ccc-name.json`, written by the app on a
// rename and at an exact claim), in preference to the session-state names, as
// Claude's picker prefers `<uuid>.ccc-name.json`. So a renamed conversation
// keeps its name after its tab is closed. The file is read only when it is a
// plain file (never through a link), small, and valid; the name is shown as
// plain text like every other string in the picker.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  walkRollouts: (home: string, maxDays: number, where: string, platform?: string) => Array<{ id: string; name?: string }>
  buildPickerRows: (conversations: Array<Record<string, unknown>>, names: Map<string, string>, width: number, now?: number) => Array<{ title: string; named: boolean; sub: string | null }>
  readRolloutName: (rolloutPath: string) => string | null
}

const ID1 = '019dd000-0001-7000-8000-000000000201'
const ID2 = '019dd000-0001-7000-8000-000000000202'
const temps: string[] = []
afterEach(() => {
  // Only a folder this file made: its own prefix, directly in the temp folder.
  for (const d of temps.splice(0)) if (dirname(d) === tmpdir() && /^ccc-p312-picker-/.test(basename(d))) rmSync(d, { recursive: true, force: true })
})
function home(): { home: string; day: string } {
  const h = mkdtempSync(join(tmpdir(), 'ccc-p312-picker-'))
  temps.push(h)
  const d = new Date()
  const day = join(h, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  return { home: h, day }
}
function rollout(day: string, id: string, prompt: string): string {
  const f = join(day, `rollout-2026-09-29T10-00-00-${id}.jsonl`)
  writeFileSync(f, [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/srv/demo', cli_version: '0.155.1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  ].join('\n') + '\n')
  return f
}
const nameFileOf = (f: string) => f.slice(0, -'.jsonl'.length) + '.ccc-name.json'

describe('the Codex picker names a conversation by its name file (P3.12, row 32)', () => {
  it('reads the name file next to a listed rollout; none there: no name', () => {
    const { home: h, day } = home()
    const a = rollout(day, ID1, 'first prompt')
    rollout(day, ID2, 'second prompt')
    writeFileSync(nameFileOf(a), JSON.stringify({ name: '  Auth work  ', updatedAt: 1 }))
    const out = lib.walkRollouts(h, 30, '/srv/demo', 'linux')
    expect(out.find((c) => c.id === ID1)!.name).toBe('Auth work')
    expect(out.find((c) => c.id === ID2)!.name).toBeUndefined()
  })

  it('a name file that is not a plain file, too large, not JSON, or blank is not read', () => {
    const { day } = home()
    const a = rollout(day, ID1, 'p')
    mkdirSync(nameFileOf(a))
    expect(lib.readRolloutName(a)).toBeNull()
    rmSync(nameFileOf(a), { recursive: true })
    writeFileSync(nameFileOf(a), JSON.stringify({ name: 'x'.repeat(10_000) }))
    expect(lib.readRolloutName(a)).toBeNull()
    // Valid within its first 4 KB but larger than that: still not read.
    writeFileSync(nameFileOf(a), JSON.stringify({ name: 'ok' }) + ' '.repeat(5000))
    expect(lib.readRolloutName(a)).toBeNull()
    writeFileSync(nameFileOf(a), '{not json')
    expect(lib.readRolloutName(a)).toBeNull()
    writeFileSync(nameFileOf(a), JSON.stringify({ name: '   ' }))
    expect(lib.readRolloutName(a)).toBeNull()
    writeFileSync(nameFileOf(a), JSON.stringify({ name: 7 }))
    expect(lib.readRolloutName(a)).toBeNull()
    expect(lib.readRolloutName(join(day, 'notes.txt'))).toBeNull()
  })

  it('a name file that is a link is not followed', () => {
    const { day } = home()
    const a = rollout(day, ID1, 'p')
    const target = join(dirname(day), 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ name: 'LINKED' }))
    try {
      symlinkSync(target, nameFileOf(a), 'file')
    } catch {
      return // no right to make a file link on this machine: the plain-file rule above covers it
    }
    expect(lib.readRolloutName(a)).toBeNull()
  })

  it('the row leads with the name file\'s name, before the session-state name, and shows it as plain text', () => {
    const conv = (id: string, extra: Record<string, unknown> = {}) => ({ id, cwd: '/srv/demo', model: 'gpt-5.5', label: 'the first prompt', mtime: 0, sourceCwd: '/srv/demo', worktreeLabel: null, ...extra })
    const names = new Map([[ID1, 'State name'], [ID2, 'State name 2']])
    const rows = lib.buildPickerRows([conv(ID1, { name: 'File \u001b[31mname' }), conv(ID2)], names, 60, 0)
    expect(rows[0]).toMatchObject({ named: true, sub: 'the first prompt' })
    expect(rows[0].title).toContain('File')
    expect(rows[0].title).toContain('name')
    expect(rows[0].title).not.toContain('\u001b')
    expect(rows[0].title).not.toContain('State name')
    expect(rows[1].title).toBe('State name 2')
  })
})
