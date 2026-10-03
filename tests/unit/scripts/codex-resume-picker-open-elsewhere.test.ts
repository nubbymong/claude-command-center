// P3.10 round 1 (V2): Codex lets one tab at a time write a conversation (the VM
// run: 0.155.1 shows its own "This conversation is open in another app" screen;
// 0.153.4 refuses the resume, "already has an active writer"). The app's picker
// said "Conversation no longer available" when Codex refused one that another
// tab of this app had open, which was false. The app now names, for a picker
// launch, the conversations its other open tabs are on (ids only, from main's
// own record); the picker marks those rows "open in another tab", and when
// Codex's resume of one fails it says so in plain words. Codex itself never
// gets the list. Nothing is started: the picker's source is read as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  openElsewhereIds: (env: Record<string, string | undefined>) => Set<string>
  fallbackNotice: (resumeUuid: string | null, openElsewhere: Set<string>) => string
  buildPickerRows: (conversations: Array<Record<string, unknown>>, names: Map<string, string>, width: number, now?: number, openElsewhere?: Set<string>) => Array<{ num: string; title: string; meta: string }>
  childEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>
}

const ID1 = '019dd000-0001-7000-8000-000000000101'
const ID2 = '019dd000-0001-7000-8000-000000000102'
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)

describe('the picker and a conversation open in another tab (P3.10 round 1, V2)', () => {
  it('reads the ids the app named, in any spelling of the variable; ids only, at most 64; two spellings that disagree give none', () => {
    expect([...lib.openElsewhereIds({ CCC_CODEX_OPEN_ELSEWHERE: `${ID1},not-an-id,${ID2.toUpperCase()}` })]).toEqual([ID1, ID2])
    expect([...lib.openElsewhereIds({ ccc_codex_open_elsewhere: ID1 })]).toEqual([ID1])
    expect(lib.openElsewhereIds({}).size).toBe(0)
    expect(lib.openElsewhereIds({ CCC_CODEX_OPEN_ELSEWHERE: ID1, ccc_codex_open_elsewhere: ID2 }).size).toBe(0)
    const many = Array.from({ length: 70 }, (_, i) => `019dd000-0001-7000-8000-${String(i).padStart(12, '0')}`).join(',')
    expect(lib.openElsewhereIds({ CCC_CODEX_OPEN_ELSEWHERE: many }).size).toBe(64)
  })

  it('marks the row of a conversation another tab is on, and only that one', () => {
    const conv = (id: string) => ({ id, label: 'Fix the build', model: 'gpt-5.5', effort: 'medium', mtime: NOW - 120_000 })
    const rows = lib.buildPickerRows([conv(ID1), conv(ID2)], new Map(), 72, NOW, new Set([ID2]))
    expect(rows[0].meta).not.toContain('open in another tab')
    expect(rows[1].meta).toContain('open in another tab')
    // Without the list (an older app, or none open): unchanged.
    expect(lib.buildPickerRows([conv(ID2)], new Map(), 72, NOW)[0].meta).not.toContain('open in another tab')
  })

  it('says a refused resume of such a conversation is open in another tab; any other stays "no longer available"', () => {
    const open = new Set([ID1])
    expect(lib.fallbackNotice(ID1, open)).toBe('This conversation is open in another tab, and Codex lets one tab at a time write to it -- starting a new conversation...')
    expect(lib.fallbackNotice(ID1.toUpperCase(), open)).toMatch(/open in another tab/)
    expect(lib.fallbackNotice(ID2, open)).toBe('Conversation no longer available -- starting fresh session...')
    expect(lib.fallbackNotice(null, open)).toBe('Conversation no longer available -- starting fresh session...')
  })

  it('Codex itself never gets the list, in any spelling', () => {
    expect(lib.childEnv({ PATH: '/bin', CCC_CODEX_OPEN_ELSEWHERE: ID1, Ccc_Codex_Open_Elsewhere: ID2 })).toEqual({ PATH: '/bin' })
  })

  it('the picker shows the mark and says the notice (its source)', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/codex-resume-picker.js'), 'utf8')
    expect(script).toContain('lib.buildPickerRows(conversations, names, innerWidth - 6, undefined, lib.openElsewhereIds(process.env))')
    expect(script).toContain('lib.fallbackNotice(resumeUuid, lib.openElsewhereIds(process.env))')
    expect(script).not.toContain('Conversation no longer available')
  })
})
