// The shared rule for text shown from outside the app (a folder name, an
// account name, a spawn error): every character a reader cannot see becomes a
// space, and the cut never splits a character. Pure; no file is touched.
import { describe, it, expect } from 'vitest'
import { stripSpoofableText } from '../../../src/shared/safe-text'

const cp = (n: number): string => String.fromCodePoint(n)
const hex = (n: number): string => `U+${n.toString(16).toUpperCase().padStart(4, '0')}`

describe('shown text drops every character a reader cannot see', () => {
  const invisible: number[] = [
    0x034f, // combining grapheme joiner
    0x115f, 0x1160, 0x3164, 0xffa0, // Hangul fillers
    0xfe00, 0xfe01, 0xfe0e, 0xfe0f, // variation selectors
    0xe0100, 0xe0150, 0xe01ef, // variation selectors supplement
    0x17b4, 0x17b5, // Khmer inherent vowels
    0x180b, 0x180c, 0x180d, 0x180f, // Mongolian free variation selectors
    0x2065, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
    0x1d173, 0x1d174, 0x1d17a, // musical symbol format controls
    0x1bca0, 0x1bca1, 0x1bca3, // shorthand format controls
    0xfff0, 0xfff8, // unassigned specials
    0xe0000, 0xe0fff, // the rest of the TAG plane block
  ]
  for (const n of invisible) {
    it(`${hex(n)} becomes a space`, () => {
      expect(stripSpoofableText(`a${cp(n)}b`)).toBe('a b')
    })
  }

  it('a lone high or low surrogate becomes a space, wherever it stands', () => {
    expect(stripSpoofableText('a\ud800b')).toBe('a b')
    expect(stripSpoofableText('a\udfffb')).toBe('a b')
    expect(stripSpoofableText('\udc00')).toBe(' ')
    expect(stripSpoofableText('x\ud83d')).toBe('x ')
    // A low surrogate first and a high one after it are two halves, not a pair.
    expect(stripSpoofableText('\ude00\ud83d')).toBe('  ')
  })

  it('the braille blank becomes a space, though Unicode does not count it ignorable', () => {
    expect(stripSpoofableText('a\u2800b')).toBe('a b')
  })
})

describe('what the rule already dropped, it still drops', () => {
  const kept: number[] = [
    0x0000, 0x0007, 0x001b, 0x001f, 0x007f, 0x0080, 0x009b, 0x009c, 0x009d, 0x009f, // C0, DEL and C1
    0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x2028, 0x2029, // line and paragraph separators
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069,
    0xfeff, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0xe0020, 0xe007f,
  ]
  for (const n of kept) {
    it(`${hex(n)} becomes a space`, () => {
      expect(stripSpoofableText(`a${cp(n)}b`)).toBe('a b')
    })
  }
})

describe('ordinary text is unchanged', () => {
  it('letters, digits, punctuation, paths and accented or non-Latin names', () => {
    for (const s of [
      'C:\\Users\\me\\proj (copy) #2',
      '/home/me/.config/app',
      'Ångström Özil naïve façade',
      'Ελληνικά Кириллица 日本語 한국어 עברית العربية',
      'tab-free text, with: commas; and "quotes"',
      '\u00a0non-breaking space and \u3000 ideographic space',
    ]) {
      expect(stripSpoofableText(s), s).toBe(s)
    }
  })

  it('a whole surrogate pair (an emoji, a supplementary letter) is one character and stays', () => {
    expect(stripSpoofableText('ok \ud83d\ude00 \ud801\udc00 \u{1f600}')).toBe('ok \ud83d\ude00 \ud801\udc00 \u{1f600}')
  })

  it('an emoji written with the emoji presentation selector keeps its base character', () => {
    // The selector is a variation selector like the others; the heart stays.
    expect(stripSpoofableText('a\u2764\ufe0f')).toBe('a\u2764 ')
  })
})

describe('the cut', () => {
  it('cuts to max code points and never splits a surrogate pair', () => {
    const s = 'ab\u{1f600}cd'
    expect(stripSpoofableText(s, 3)).toBe('ab\u{1f600}')
    expect(stripSpoofableText(s, 2)).toBe('ab')
    expect(Array.from(stripSpoofableText('\u{1f600}'.repeat(10), 4))).toHaveLength(4)
  })

  it('leaves text at or under max as it is', () => {
    expect(stripSpoofableText('abc', 3)).toBe('abc')
    expect(stripSpoofableText('x'.repeat(500))).toHaveLength(500)
    expect(stripSpoofableText('x'.repeat(501))).toHaveLength(500)
  })
})
