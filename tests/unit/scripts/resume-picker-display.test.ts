// Everything the resume picker shows is plain text.
//
// The picker runs in the session's terminal and draws text it did not write:
// conversation titles and messages, a model name, a session id, a work name,
// a worktree's name and the folder it was started in. Each is shown with
// every character a reader cannot see replaced by a space -- the same rule
// as src/shared/safe-text.ts, which this plain Node script cannot import (a
// parity test holds the copies to one answer). Pure: nothing here starts a
// process or touches a real home.
import { describe, it, expect } from 'vitest'

type Conv = {
  sessionId: string
  aiTitle: string | null
  firstMessage: string | null
  lastPrompt: string | null
  lastMessages: string[]
  model: string | null
  mtime: number
  size: number
  filePath: string
  worktreeLabel: string | null
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  displayPath: (raw: string, max?: number) => string
  pickerLines: (
    cwd: string,
    conversations: Conv[],
    names: Map<string, string> | ((conv: Conv) => string | null | undefined),
    width: number,
    opts?: { hasWorktrees?: boolean; now?: number },
  ) => string[]
  computeLayoutWidth: (columns: number | undefined) => number
  colours: Record<string, string>
}

const cp = (n: number): string => String.fromCodePoint(n)
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const conv = (o: Partial<Conv>): Conv => ({
  sessionId: UUID, aiTitle: null, firstMessage: null, lastPrompt: null, lastMessages: [], model: null,
  mtime: NOW - 5 * 60000, size: 40960, filePath: '/p/x.jsonl', worktreeLabel: null, ...o,
})

describe('shown text drops every character a reader cannot see', () => {
  it('replaces each invisible, filler and annotation character with a space', () => {
    const hidden = [
      0x034f, // combining grapheme joiner
      0x115f, 0x1160, 0x3164, 0xffa0, // fillers drawn as nothing
      0x17b4, 0x17b5, // invisible vowels
      0x180b, 0x180c, 0x180d, 0x180f, // free variation selectors
      0x2065, // reserved in the bidi block, ignorable
      0x206a, 0x206f, // deprecated format characters
      0xfff0, // reserved among the specials, ignorable
      0xfe00, 0xfe0f, 0xe0100, 0xe01ef, // variation selectors, both blocks
      0x1bca0, 0x1bca3, // format controls
      0x1d173, 0x1d17a, // musical format controls
      0xe0080, 0xe0fff, // the rest of the ignorable tag plane
      0x2800, // braille blank
      0xfff9, 0xfffa, 0xfffb, // interlinear annotation marks
    ]
    for (const n of hidden) {
      expect(picker.displayPath('a' + cp(n) + 'b'), `U+${n.toString(16).toUpperCase()}`).toBe('a b')
    }
  })

  it('replaces a lone half of a surrogate pair and keeps a whole pair', () => {
    expect(picker.displayPath('a' + String.fromCharCode(0xd83d) + 'b')).toBe('a b')
    expect(picker.displayPath('a' + String.fromCharCode(0xde00) + 'b')).toBe('a b')
    expect(picker.displayPath('a' + cp(0x1f600) + 'b')).toBe('a' + cp(0x1f600) + 'b')
  })

  it('keeps ordinary text, accents and scripts as they are', () => {
    for (const s of ['plain words', 'caf' + cp(0xe9), cp(0x4e2d) + cp(0x6587), 'A' + cp(0x0301), cp(0x05d0) + cp(0x05d1)]) {
      expect(picker.displayPath(s)).toBe(s)
    }
  })
})

describe('the picker draws its lines in one place', () => {
  const k = picker.colours
  const bar = `  ${k.surface}│${k.reset}`

  it('draws a plain conversation list exactly as it always has', () => {
    const width = picker.computeLayoutWidth(84)
    expect(width).toBe(80)
    const list = [
      conv({ sessionId: UUID, aiTitle: 'Draft the notes', model: 'claude-opus-4-5', worktreeLabel: 'docs-wt', lastMessages: ['check the dates'] }),
      conv({ sessionId: 'abc', firstMessage: 'a'.repeat(100), mtime: NOW - 2 * 86400000, size: 2 * 1048576 }),
    ]
    const lines = picker.pickerLines('/home/jo/app', list, new Map([[UUID, 'Release notes']]), width, { hasWorktrees: true, now: NOW })
    expect(lines).toEqual([
      '',
      `  ${k.surface}╭─${k.blue} Resume Conversation ${k.surface}─ ${k.subtext}/home/jo/app ${k.surface}${'─'.repeat(42)}╮${k.reset}`,
      `${bar}  ${k.dim}${k.overlay}includes git worktrees — ⑂ tags the worktree${k.reset}`,
      bar,
      `${bar}  ${k.green} 1${k.reset}  ${k.bold}${k.peach}Release notes${k.reset}  ${k.mauve}⑂ docs-wt${k.reset}`,
      `${bar}      ${k.overlay}5m ago · 40 KB · claude-opus-4-5 · ${UUID}${k.reset}`,
      `${bar}      ${k.dim}${k.subtext}Draft the notes${k.reset}`,
      `${bar}      ${k.dim}${k.subtext}> check the dates${k.reset}`,
      `${bar}      ${k.surface}${'─'.repeat(68)}${k.reset}`,
      `${bar}  ${k.green} 2${k.reset}  ${k.text}${'a'.repeat(67)}…${k.reset}`,
      `${bar}      ${k.overlay}2d ago · 2.0 MB · abc${k.reset}`,
      bar,
      `${bar}  ${k.yellow} n${k.reset}  ${k.text}New conversation${k.reset}`,
      bar,
      `  ${k.surface}╰${'─'.repeat(76)}╯${k.reset}`,
      '',
    ])
  })

  it('takes a work name from a function of the conversation, and labels a conversation with no text', () => {
    const lines = picker.pickerLines('/x', [conv({ filePath: '/p/named.jsonl' }), conv({ filePath: '/p/other.jsonl' })], (c) => (c.filePath === '/p/named.jsonl' ? 'From the sidecar' : null), 80, { now: NOW })
    expect(lines.some((l) => l.includes(`${k.bold}${k.peach}From the sidecar${k.reset}`))).toBe(true)
    expect(lines.some((l) => l.includes(`${k.text}(continued session)${k.reset}`))).toBe(true)
    expect(lines.some((l) => l.includes('includes git worktrees'))).toBe(false)
  })

  it('a field with nothing a reader can see gives way to the next one', () => {
    const blank = cp(0x200b) + cp(0x2060) + ' ' + cp(0x202e)
    const lines = picker.pickerLines('/x', [
      conv({ sessionId: 'n', aiTitle: 'The real title', firstMessage: 'first words' }),
      conv({ sessionId: 'b', aiTitle: blank, firstMessage: 'First words' }),
      conv({ sessionId: 's', aiTitle: blank, firstMessage: blank, lastPrompt: 'Last prompt' }),
    ], new Map([['n', blank], ['s', 'Named']]), 80, { now: NOW })
    // A work name with nothing to see is no work name: the title leads, in plain colour, with nothing beneath.
    expect(lines).toContain(`${bar}  ${k.green} 1${k.reset}  ${k.text}The real title${k.reset}`)
    expect(lines.some((l) => l.includes('first words'))).toBe(false)
    // A title with nothing to see gives way to the first message.
    expect(lines).toContain(`${bar}  ${k.green} 2${k.reset}  ${k.text}First words${k.reset}`)
    // Beneath a work name, a title and a first message with nothing to see give way to the last prompt.
    expect(lines).toContain(`${bar}  ${k.green} 3${k.reset}  ${k.bold}${k.peach}Named${k.reset}`)
    expect(lines).toContain(`${bar}      ${k.dim}${k.subtext}Last prompt${k.reset}`)
  })

  it('draws at any width without failing', () => {
    for (const width of [0, 1, 3, 4, 5]) {
      expect(() => picker.pickerLines('/x', [conv({ aiTitle: 't', lastMessages: ['m'] })], new Map(), width, { hasWorktrees: true, now: NOW }), String(width)).not.toThrow()
    }
  })
})

describe('everything the picker shows is plain text', () => {
  const k = picker.colours
  const ESC = String.fromCharCode(0x1b)
  const BEL = String.fromCharCode(0x07)
  const ST = ESC + String.fromCharCode(0x5c)
  // Built here, never typed on a command line: a visible tag first, then a
  // clear screen, a window title, a link, a clipboard write, a bell, the
  // 8-bit CSI / OSC / ST forms and a right-to-left override.
  const marked = (tag: string): string =>
    tag + ESC + '[2J' + ESC + ']0;t' + BEL + ESC + ']8;;https://example.invalid/' + ST + 'x' + ESC + ']8;;' + ST +
    ESC + ']52;c;aGk=' + BEL + BEL + String.fromCharCode(0x9b) + '1;1H' + String.fromCharCode(0x9d) + '0;t' +
    String.fromCharCode(0x9c) + String.fromCharCode(0x202e) + 'end'

  // Anything a reader cannot see, and a lone half of a surrogate pair.
  const NOT_PLAIN = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029\ud800-\udfff]/u
  // The picker's own colour sequences are the only escapes it may print.
  const own = Object.values(k).sort((a, b) => b.length - a.length)
  const withoutOwnColours = (line: string): string => own.reduce((s, c) => s.split(c).join(''), line)
  const notPlain = (lines: string[]): string[] => lines.filter((l) => NOT_PLAIN.test(withoutOwnColours(l))).map((l) => JSON.stringify(l))

  const names = new Map([
    ['named-a', marked('NAME')],
    ['named-f', marked('NAMEF')],
    ['named-g', marked('NAMEG')],
  ])
  const list = [
    conv({ sessionId: 'named-a', aiTitle: marked('SUBTITLE'), model: marked('MODEL'), worktreeLabel: marked('WT'), lastMessages: [marked('MSG1'), marked('MSG2')] }),
    conv({ sessionId: marked('SID'), aiTitle: marked('TITLE') }),
    conv({ sessionId: 'c', firstMessage: marked('FIRST') }),
    conv({ sessionId: 'd', lastPrompt: marked('PROMPT') }),
    conv({ sessionId: 'e', lastMessages: [marked('RECENT')] }),
    conv({ sessionId: 'named-f', firstMessage: marked('SUBFIRST') }),
    conv({ sessionId: 'named-g', lastPrompt: marked('SUBPROMPT') }),
  ]
  const cwd = '/home/jo/' + marked('DIR')

  it('every field the picker shows is plain text', () => {
    const lines = picker.pickerLines(cwd, list, names, 200, { hasWorktrees: true, now: NOW })
    expect(notPlain(lines)).toEqual([])
    // Still shown, as text: every field's own words reach the screen.
    const all = lines.map(withoutOwnColours).join('\n')
    for (const tag of ['DIR', 'NAME', 'SUBTITLE', 'MODEL', 'SID', 'WT', 'MSG1', 'MSG2', 'TITLE', 'FIRST', 'PROMPT', 'RECENT', 'NAMEF', 'SUBFIRST', 'NAMEG', 'SUBPROMPT']) {
      expect(all, tag).toContain(tag)
    }
  })

  it('the folder line is shown as plain text', () => {
    const lines = picker.pickerLines(cwd, [conv({})], new Map(), 200, { now: NOW })
    const header = lines[1]
    expect(withoutOwnColours(header)).toContain('/home/jo/DIR')
    expect(notPlain([header])).toEqual([])
  })

  it('every field is plain text at the narrowest width too', () => {
    expect(notPlain(picker.pickerLines(cwd, list, names, picker.computeLayoutWidth(1), { hasWorktrees: true, now: NOW }))).toEqual([])
  })

  it('a cut never splits a character in two', () => {
    const face = cp(0x1f600)
    const title = 'a'.repeat(66) + face + 'tail'
    // At width 80 the folder is cut to 73 code points and an ellipsis: the face is the 73rd.
    const dir = '/x' + 'b'.repeat(70) + face + 'cc'
    const lines = picker.pickerLines(dir, [conv({ aiTitle: title, lastMessages: ['m'.repeat(62) + face + 'tail'] })], new Map(), 80, { now: NOW })
    expect(notPlain(lines)).toEqual([])
    expect(withoutOwnColours(lines[1])).toContain('/x' + 'b'.repeat(70) + face + '… ')
    expect(lines.some((l) => l.includes('a'.repeat(66) + face + '…'))).toBe(true)
    expect(lines.some((l) => l.includes('> ' + 'm'.repeat(62) + face + '…'))).toBe(true)
  })

  it('the folder line\'s border counts a character outside the basic plane once', () => {
    const dashes = (cwd: string): number => (withoutOwnColours(picker.pickerLines(cwd, [conv({})], new Map(), 80, { now: NOW })[1]).match(/─/g) ?? []).length
    const face = cp(0x1f600)
    expect(dashes('/' + 'd'.repeat(8) + face)).toBe(dashes('/' + 'd'.repeat(9)))
    expect(dashes('/' + 'd'.repeat(9))).toBe(80 - 26 - 10 + 2)
  })
})
