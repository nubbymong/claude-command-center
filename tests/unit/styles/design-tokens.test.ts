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

function tokenValue(block: string, name: string): string {
  const m = block.match(new RegExp(name + '\\s*:\\s*([^;]+);'))
  if (!m) throw new Error('token not found: ' + name)
  return m[1].trim()
}
// WCAG 2.1 relative luminance + contrast ratio.
function srgbToLin(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16)
  return 0.2126 * srgbToLin((n >> 16) & 255)
    + 0.7152 * srgbToLin((n >> 8) & 255)
    + 0.0722 * srgbToLin(n & 255)
}
function contrast(a: string, b: string): number {
  const l1 = luminance(a), l2 = luminance(b)
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

describe('TL2.1 light theme text contrast (WCAG AA)', () => {
  const panel = tokenValue(light, '--surface-panel')
  const stage = tokenValue(light, '--surface-stage')
  it('primary text on stage >= 7:1', () => {
    expect(contrast(tokenValue(light, '--text-primary'), stage)).toBeGreaterThanOrEqual(7)
  })
  it('secondary text on panel >= 4.5:1', () => {
    expect(contrast(tokenValue(light, '--text-secondary'), panel)).toBeGreaterThanOrEqual(4.5)
  })
  it('muted text on panel >= 4.5:1 (the "washed out" fix)', () => {
    expect(contrast(tokenValue(light, '--text-muted'), panel)).toBeGreaterThanOrEqual(4.5)
  })
})
