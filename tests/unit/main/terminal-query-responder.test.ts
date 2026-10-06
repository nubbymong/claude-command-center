// [host] Codex asks the terminal for its default colours once it has started
// (codex-rs tui, terminal_probe/windows.rs: `ESC ] 10 ; ? ESC \ ESC ] 11 ; ? ESC \`)
// and waits 100 ms for the answers (terminal_probe.rs DEFAULT_TIMEOUT). An
// answer that comes later stays in the console input and reaches Codex's
// composer as typed text. The answer used to come only from the renderer's
// xterm.js, which on Electron 44 can be busy drawing for longer than that (VM:
// up to 114 ms). Main now answers the moment the query arrives, in exactly the
// bytes xterm.js sends, and keeps the query from the renderer so it is never
// answered twice. These tests hold the responder to that, byte for byte.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createColorQueryResponder,
  colorQueryReply,
  parseHexColor,
  terminalReplyColors,
  type ReplyColors,
} from '../../../src/main/terminal-query-responder'
import { TERMINAL_DEFAULT_COLORS } from '../../../src/shared/terminal-colors'

const ESC = '\x1b'
const ST = `${ESC}\\`
const BEL = '\x07'
/** The 16 bytes Codex writes (terminal_probe/windows.rs:68), seen as ONE chunk on the VM. */
const CODEX_QUERY = `${ESC}]10;?${ST}${ESC}]11;?${ST}`
/** What the app's xterm.js answered on the VM (runs col-insca*.json, dark theme): the bytes to match. */
const XTERM_DARK_FG = `${ESC}]10;rgb:eeee/f2f2/f7f7${ST}`
const XTERM_DARK_BG = `${ESC}]11;rgb:1717/1e1e/2727${ST}`

const DARK: ReplyColors = { foreground: [0xee, 0xf2, 0xf7], background: [0x17, 0x1e, 0x27] }

function responder(colors: () => ReplyColors | null = () => DARK) {
  const replies: string[] = []
  const r = createColorQueryResponder({ colors, reply: (b) => replies.push(b) })
  return { r, replies }
}

describe('the reply main gives (xterm.js parity)', () => {
  it('is byte-for-byte what the app\'s xterm.js sent on the VM for the dark theme', () => {
    expect(colorQueryReply(10, DARK.foreground)).toBe(XTERM_DARK_FG)
    expect(colorQueryReply(11, DARK.background)).toBe(XTERM_DARK_BG)
  })

  it('writes each channel as xterm.js does: two lower-case hex digits, repeated (toRgbString, 16 bits)', () => {
    expect(colorQueryReply(11, [0, 10, 255])).toBe(`${ESC}]11;rgb:0000/0a0a/ffff${ST}`)
  })
})

describe('a Codex colour query in the PTY output', () => {
  it('the one-chunk query: both answers at once, in order, and nothing of it forwarded', () => {
    const { r, replies } = responder()
    expect(r.filter(CODEX_QUERY)).toBe('')
    expect(replies).toEqual([XTERM_DARK_FG, XTERM_DARK_BG])
  })

  it('a query in the middle of output: the output around it is forwarded intact and in order', () => {
    const { r, replies } = responder()
    const before = `${ESC}[?25l${ESC}[2;1Hhooks ok${ESC}[0m\r\n`
    const after = `${ESC}[3;1H› Ask Codex to do anything${ESC}[?25h`
    expect(r.filter(before + CODEX_QUERY + after)).toBe(before + after)
    expect(replies).toEqual([XTERM_DARK_FG, XTERM_DARK_BG])
  })

  it('a BEL-terminated query is answered too, in the form xterm.js uses for every query (ST)', () => {
    const { r, replies } = responder()
    expect(r.filter(`a${ESC}]11;?${BEL}b${ESC}]10;?${BEL}c`)).toBe('abc')
    expect(replies).toEqual([XTERM_DARK_BG, XTERM_DARK_FG])
  })

  it('split across two chunks at EVERY byte: each query answered exactly once, the rest forwarded intact', () => {
    const stream = `x${ESC}[1m` + CODEX_QUERY + `${ESC}[0my`
    for (let k = 0; k <= stream.length; k++) {
      const { r, replies } = responder()
      const out = r.filter(stream.slice(0, k)) + r.filter(stream.slice(k))
      expect(out, `split at ${k}`).toBe(`x${ESC}[1m${ESC}[0my`)
      expect(replies, `split at ${k}`).toEqual([XTERM_DARK_FG, XTERM_DARK_BG])
    }
  })

  it('fed one byte at a time (BEL and ST forms): the same answers, the same forwarded bytes', () => {
    for (const term of [ST, BEL]) {
      const stream = `p${ESC}]10;?${term}q${ESC}]11;?${term}r`
      const { r, replies } = responder()
      let out = ''
      for (const ch of stream) out += r.filter(ch)
      expect(out).toBe('pqr')
      expect(replies).toEqual([XTERM_DARK_FG, XTERM_DARK_BG])
    }
  })

  it('every query is answered once, never twice, however many come', () => {
    const { r, replies } = responder()
    expect(r.filter(CODEX_QUERY)).toBe('')
    expect(r.filter('text' + CODEX_QUERY)).toBe('text')
    expect(replies).toEqual([XTERM_DARK_FG, XTERM_DARK_BG, XTERM_DARK_FG, XTERM_DARK_BG])
  })

  it('the colours are read when the query arrives, not before', () => {
    let calls = 0
    const { r } = responder(() => { calls++; return DARK })
    r.filter('plain output, no query')
    expect(calls).toBe(0)
    r.filter(CODEX_QUERY)
    expect(calls).toBeGreaterThan(0)
  })
})

describe('what main never answers (the renderer\'s xterm.js still does, as before)', () => {
  const passthrough = (input: string) => {
    const { r, replies } = responder()
    expect(r.filter(input)).toBe(input)
    expect(replies).toEqual([])
  }

  it('any other query: cursor colour (OSC 12), a palette entry (OSC 4), device attributes, cursor position', () => {
    passthrough(`${ESC}]12;?${ST}`)
    passthrough(`${ESC}]4;1;?${BEL}`)
    passthrough(`${ESC}[c`)
    passthrough(`${ESC}[>c`)
    passthrough(`${ESC}[6n`)
    passthrough(`${ESC}]110;?${ST}`)
  })

  it('a two-slot query (OSC 10 ; ? ; ?) is left to xterm.js, which answers both', () => {
    passthrough(`${ESC}]10;?;?${ST}`)
  })

  it('an escape split at a chunk end that turns out to be something else is forwarded whole, in order', () => {
    for (const [a, b] of [['abc' + ESC, '[31mred'], ['x' + ESC + ']1', '2;?' + BEL], ['y' + ESC + ']10;', '?;?' + ST], ['z' + ESC + ']11;?' + ESC, '[0m']]) {
      const { r, replies } = responder()
      expect(r.filter(a) + r.filter(b), JSON.stringify([a, b])).toBe(a + b)
      expect(replies).toEqual([])
    }
  })

  it('once the program SETS a default colour (OSC 10/11 with a value), every later query is left to xterm.js', () => {
    const { r, replies } = responder()
    const set = `${ESC}]11;#000000${ST}`
    expect(r.filter(set)).toBe(set)
    expect(r.filter(CODEX_QUERY)).toBe(CODEX_QUERY)
    expect(replies).toEqual([])
  })

  it('a query answered before a set in the same chunk stays answered; the set and everything after it go through', () => {
    const { r, replies } = responder()
    const set = `${ESC}]10;#ffffff${ST}`
    expect(r.filter(`a${ESC}]11;?${ST}b${set}c${ESC}]10;?${ST}`)).toBe(`ab${set}c${ESC}]10;?${ST}`)
    expect(replies).toEqual([XTERM_DARK_BG])
  })

  it('a set split across chunks is seen too', () => {
    const { r, replies } = responder()
    expect(r.filter(`${ESC}]10;`) + r.filter(`rgb:ff/ff/ff${BEL}`)).toBe(`${ESC}]10;rgb:ff/ff/ff${BEL}`)
    expect(r.filter(CODEX_QUERY)).toBe(CODEX_QUERY)
    expect(replies).toEqual([])
  })

  it('when the colours cannot be known exactly here, the query goes to xterm.js untouched', () => {
    const { r, replies } = responder(() => null)
    expect(r.filter('a' + CODEX_QUERY + 'b')).toBe('a' + CODEX_QUERY + 'b')
    expect(replies).toEqual([])
  })
})

describe('the colours xterm.js shows a session with (terminalTheme.ts getTerminalTheme)', () => {
  const rgb = (hex: string) => parseHexColor(hex)!

  it('dark (the default, and any unknown theme value): the dark theme\'s foreground and background', () => {
    for (const settings of [null, {}, { theme: 'dark' }, { theme: 'night' }, { theme: 42 }]) {
      expect(terminalReplyColors(settings, false), JSON.stringify(settings)).toEqual({ foreground: rgb(TERMINAL_DEFAULT_COLORS.dark.foreground), background: rgb(TERMINAL_DEFAULT_COLORS.dark.background) })
    }
  })

  it('light, and system following the OS (nativeTheme), as the renderer\'s data-theme does', () => {
    const light = { foreground: rgb(TERMINAL_DEFAULT_COLORS.light.foreground), background: rgb(TERMINAL_DEFAULT_COLORS.light.background) }
    const dark = { foreground: rgb(TERMINAL_DEFAULT_COLORS.dark.foreground), background: rgb(TERMINAL_DEFAULT_COLORS.dark.background) }
    expect(terminalReplyColors({ theme: 'light' }, true)).toEqual(light)
    expect(terminalReplyColors({ theme: 'system' }, false)).toEqual(light)
    expect(terminalReplyColors({ theme: 'system' }, true)).toEqual(dark)
  })

  it('the user\'s terminal background, when set, replaces the theme\'s background only', () => {
    expect(terminalReplyColors({ theme: 'light', terminal: { background: '#102030' } }, false)).toEqual({ foreground: rgb(TERMINAL_DEFAULT_COLORS.light.foreground), background: [0x10, 0x20, 0x30] })
    expect(terminalReplyColors({ terminal: { background: '#AbC' } }, false)!.background).toEqual([0xaa, 0xbb, 0xcc])
    // An empty override is no override (the renderer's `override || token`).
    expect(terminalReplyColors({ terminal: { background: '' } }, false)!.background).toEqual(rgb(TERMINAL_DEFAULT_COLORS.dark.background))
  })

  it('a background main cannot read exactly (not #rgb / #rrggbb) gives no colours: xterm.js answers instead', () => {
    for (const background of ['rgb(1, 2, 3)', 'black', '#12345', '#1234567', '#12345678', ' #102030', 7]) {
      expect(terminalReplyColors({ terminal: { background } }, false), String(background)).toBeNull()
    }
  })

  it('reads #rgb and #rrggbb as xterm.js does, in any case; nothing else', () => {
    expect(parseHexColor('#eef2f7')).toEqual([0xee, 0xf2, 0xf7])
    expect(parseHexColor('#EEF2F7')).toEqual([0xee, 0xf2, 0xf7])
    expect(parseHexColor('#fff')).toEqual([0xff, 0xff, 0xff])
    for (const bad of ['eef2f7', '#ggg', '#ff', '#ffff', '', '#eef2f7 ']) expect(parseHexColor(bad), bad).toBeNull()
  })
})

describe('one source for the terminal\'s default colours', () => {
  // styles.css gives xterm.js its colours (--terminal-foreground, --surface-stage);
  // the shared constants are what main answers with. They must never disagree.
  const css = readFileSync(join(__dirname, '../../../src/renderer/styles.css'), 'utf-8')
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    return css.slice(start, css.indexOf('\n}', start))
  }
  const value = (b: string, name: string) => {
    const m = b.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
    expect(m, name).not.toBeNull()
    return m![1].toLowerCase()
  }

  it('the dark theme (:root) and the light theme ([data-theme="light"]) match src/shared/terminal-colors.ts', () => {
    const root = block(':root')
    const light = block('[data-theme="light"]')
    expect(value(root, '--terminal-foreground')).toBe(TERMINAL_DEFAULT_COLORS.dark.foreground)
    expect(value(root, '--surface-stage')).toBe(TERMINAL_DEFAULT_COLORS.dark.background)
    expect(value(light, '--terminal-foreground')).toBe(TERMINAL_DEFAULT_COLORS.light.foreground)
    expect(value(light, '--surface-stage')).toBe(TERMINAL_DEFAULT_COLORS.light.background)
  })
})
