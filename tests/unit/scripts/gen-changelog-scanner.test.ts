/**
 * #156 -- the changelog literal scanner must understand comments.
 *
 * `sliceArrayLiteral` bracket-matches the `changelog` array out of the TS source
 * so the generator needs no TS toolchain. It tracked string quotes but had no
 * notion of comments, so ONE apostrophe in a `//` comment inside the array --
 * "the entry's version", the most natural English to write -- opened a phantom
 * string. Depth tracking stopped, the slice ended in the wrong place, and the
 * failure surfaced as:
 *
 *     SyntaxError: Unexpected token ')'   at new Function (<anonymous>)
 *
 * pointing at generated code, with nothing to suggest the real cause.
 *
 * These cases run on SYNTHETIC sources on purpose. The real changelog.ts happens
 * not to contain a comment with an apostrophe today (it carries a NOTE warning
 * authors not to write one), so a test against the real file would pass either
 * way and prove nothing.
 */
import { describe, it, expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sliceArrayLiteral } = require('../../../scripts/gen-changelog.js') as {
  sliceArrayLiteral: (src: string, anchor: string) => string
}

const ANCHOR = 'changelog: ChangelogEntry[] ='
const wrap = (body: string): string =>
  `export const ${ANCHOR}\n[\n${body}\n]\n\nexport const after = 1\n`

const parse = (src: string): unknown =>
  // eslint-disable-next-line no-new-func
  new Function(`return (${sliceArrayLiteral(src, ANCHOR)})`)()

describe('scanner ignores comments', () => {
  it('survives an apostrophe in a line comment -- the #156 repro', () => {
    const src = wrap(`  // rewrites the first entry's version\n  { version: '1.0.0' },`)
    expect(parse(src)).toEqual([{ version: '1.0.0' }])
  })

  it('survives a backtick in a line comment', () => {
    const src = wrap('  // run `npm run changelog` after editing\n  { version: \'1.0.0\' },')
    expect(parse(src)).toEqual([{ version: '1.0.0' }])
  })

  it('survives a double quote in a line comment', () => {
    const src = wrap('  // the "What\'s New" modal reads this\n  { version: \'1.0.0\' },')
    expect(parse(src)).toEqual([{ version: '1.0.0' }])
  })

  it('survives an apostrophe in a block comment', () => {
    const src = wrap("  /* the entry's date is not synced here */\n  { version: '1.0.0' },")
    expect(parse(src)).toEqual([{ version: '1.0.0' }])
  })

  it('ignores a bracket inside a comment', () => {
    const src = wrap('  // a stray ] and [ in prose\n  { version: \'1.0.0\' },')
    expect(parse(src)).toEqual([{ version: '1.0.0' }])
  })
})

describe('scanner still respects strings', () => {
  it('does NOT treat // inside a string as a comment', () => {
    // The regression risk of the fix: a URL in a description would truncate
    // the literal if comment detection ran before the string check.
    const src = wrap("  { version: '1.0.0', url: 'https://example.com/a]b' },")
    expect(parse(src)).toEqual([{ version: '1.0.0', url: 'https://example.com/a]b' }])
  })

  it('does NOT treat /* inside a string as a comment', () => {
    const src = wrap("  { version: '1.0.0', note: 'glob /* matches' },")
    expect(parse(src)).toEqual([{ version: '1.0.0', note: 'glob /* matches' }])
  })

  it('still ignores brackets inside strings', () => {
    const src = wrap("  { version: '1.0.0', note: 'array ] literal [' },")
    expect(parse(src)).toEqual([{ version: '1.0.0', note: 'array ] literal [' }])
  })

  it('handles an escaped quote inside a string', () => {
    // The scanned source must literally read:  note: 'it\'s fine'
    const src = wrap("  { version: '1.0.0', note: 'it\\'s fine' },")
    expect(src).toContain("'it\\'s fine'")
    expect(parse(src)).toEqual([{ version: '1.0.0', note: "it's fine" }])
  })
})

describe('scanner slices the right span', () => {
  it('stops at the matching bracket, not the first one', () => {
    const src = wrap("  { version: '1.0.0', tags: ['a', 'b'] },")
    expect(parse(src)).toEqual([{ version: '1.0.0', tags: ['a', 'b'] }])
  })

  it('throws a message naming the likely cause when unterminated', () => {
    const src = `export const ${ANCHOR}\n[\n  { version: '1.0.0' },\n`
    expect(() => sliceArrayLiteral(src, ANCHOR)).toThrow(/unterminated string or comment/i)
  })

  it('throws when the anchor is absent', () => {
    expect(() => sliceArrayLiteral('const x = [1]', ANCHOR)).toThrow(/Could not find/)
  })
})
