import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const css = readFileSync(resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8')

// Return the body of the rule for `selector` that defines the semantic tokens
// (identified by containing --surface-chrome). There are two `:root` blocks
// in the file -- the raw --color-* palette and the semantic block; this picks
// the semantic one. CSS custom-property blocks have no nested braces, so a
// non-greedy [^}]* body match is safe.
function themeBlock(selector: string): string {
  const re = new RegExp(selector + '\\s*\\{([^}]*)\\}', 'g')
  for (const m of css.matchAll(re)) {
    if (m[1].includes('--surface-chrome')) return m[1]
  }
  throw new Error('semantic block not found for ' + selector)
}
function tokenNames(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
}

const NEW_TOKENS = [
  '--surface-base', '--surface-sunken', '--surface-overlay',
  '--border-subtle', '--border-strong',
]
const dark = themeBlock(':root')
const light = themeBlock('\\[data-theme="light"\\]')

describe('V2 shell design tokens', () => {
  it.each(NEW_TOKENS)('defines %s in the dark (:root) semantic block', (t) => {
    expect(tokenNames(dark).has(t)).toBe(true)
  })
  it.each(NEW_TOKENS)('defines %s in the light ([data-theme=light]) block', (t) => {
    expect(tokenNames(light).has(t)).toBe(true)
  })
  it('defines the same --surface-*/--border-* token set in both themes (no drift)', () => {
    const surfBorder = (s: Set<string>) =>
      [...s].filter((t) => t.startsWith('--surface-') || t.startsWith('--border-')).sort()
    expect(surfBorder(tokenNames(light))).toEqual(surfBorder(tokenNames(dark)))
  })
})
