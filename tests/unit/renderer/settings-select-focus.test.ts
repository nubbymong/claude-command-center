// Keyboard focus on the Settings selects (the Sentinel "Analysis account" among
// them): the VM capture at 38cbc9d7 found only a faint border tint, with no
// outline and no ring. Every <select> in SettingsPage now draws the strong
// focus ring the switches use (.focus-ring-strong, pinned for contrast in
// token-contrast.test.ts). Read from the source: the page is too large to
// render here for a style the test environment cannot compute anyway.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')

/** The className of every <select> element in the file. */
function selectClassNames(src: string): string[] {
  return src.split('<select').slice(1).map((chunk) => {
    const body = chunk.slice(0, chunk.indexOf('</select>'))
    return body.match(/className="([^"]*)"/)?.[1] ?? ''
  })
}

describe('Settings selects: a clearly visible keyboard focus', () => {
  it('every select draws the strong focus ring, and none switches its outline off', () => {
    const classes = selectClassNames(SRC)
    expect(classes.length).toBeGreaterThanOrEqual(6)
    for (const c of classes) {
      expect(c, c).toContain('focus-ring-strong')
      expect(c, c).not.toContain('focus:outline-none')
    }
  })

  it('the Sentinel "Analysis account" select is one of them', () => {
    const at = SRC.indexOf('<Field label="Analysis account">')
    expect(at).toBeGreaterThan(-1)
    expect(selectClassNames(SRC.slice(at))[0]).toContain('focus-ring-strong')
  })
})

/** The className of every <input> and <textarea> element in the file (a
 *  checkbox has its own native focus and no outline override). */
function fieldClassNames(src: string): string[] {
  return src.split(/<(?:input|textarea)\b/).slice(1).map((chunk) => {
    const end = chunk.search(/\/>|<\/textarea>/)
    return chunk.slice(0, end < 0 ? undefined : end).match(/className="([^"]*)"/)?.[1] ?? ''
  })
}

describe('Settings text fields: a clearly visible keyboard focus (WP2 final fixes)', () => {
  it('no field switches its outline off, and every tinted text field draws the strong focus ring', () => {
    const classes = fieldClassNames(SRC)
    expect(classes.length).toBeGreaterThanOrEqual(5)
    const tinted = classes.filter((c) => c.includes('focus:border-blue/50'))
    expect(tinted.length).toBeGreaterThanOrEqual(5)
    for (const c of classes) expect(c, c).not.toContain('focus:outline-none')
    for (const c of tinted) expect(c, c).toContain('focus-ring-strong')
  })

  it('Default Working Directory and Local Machine Name are among them', () => {
    for (const label of ['Default Working Directory', 'Local Machine Name']) {
      const at = SRC.indexOf(`<Field label="${label}"`)
      expect(at, label).toBeGreaterThan(-1)
      expect(fieldClassNames(SRC.slice(at))[0], label).toContain('focus-ring-strong')
    }
  })
})

describe('Settings, Accounts fields: a clearly visible keyboard focus (WP2 final fixes)', () => {
  // The account rename field and each account row's web session selects
  // (sign-in flow, where claude.ai sign-in and artifacts open, the sign-in
  // browser) switched their outline off and showed only a faint border tint.
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components', rel), 'utf8')
  const FILES = ['AccountsPanel.tsx', 'settings/AccountWebSession.tsx']

  it('no field switches its outline off, and every tinted field draws the strong focus ring', () => {
    const classes = FILES.flatMap((f) => [...fieldClassNames(read(f)), ...selectClassNames(read(f))].map((c) => [f, c] as const))
    const tinted = classes.filter(([, c]) => c.includes('focus:border-blue/50'))
    expect(tinted.length, 'the rename field and the four web session selects').toBeGreaterThanOrEqual(5)
    for (const [f, c] of classes) expect(c, `${f}: ${c}`).not.toContain('focus:outline-none')
    for (const [f, c] of tinted) expect(c, `${f}: ${c}`).toContain('focus-ring-strong')
  })

  it('the account rename field is one of them', () => {
    const src = read('AccountsPanel.tsx')
    const at = src.indexOf('placeholder="Optional friendly name"')
    expect(at, 'the rename field').toBeGreaterThan(-1)
    const cls = src.slice(at).match(/className="([^"]*)"/)?.[1] ?? ''
    expect(cls).toContain('focus-ring-strong')
    expect(cls).not.toContain('focus:outline-none')
  })
})

describe('Settings and Accounts: no control trades its outline for a faint ring (WP2 final fixes)', () => {
  // A control that switches its outline off and shows focus as a 1px or
  // half-strength ring (focus-visible:ring-1 ring-blue/50) is close to
  // invisible on these cards. No control in these files switches its outline
  // off: one that takes the outline over draws the strong ring
  // (.focus-ring-strong), the rest keep the browser's own outline. The app's
  // standard .focus-ring is itself outline: none with a 60% ring (2.0-2.2:1 on
  // the light surfaces), so it is not used here either: the Settings tabs,
  // which run edge to edge in the scrolling rail where an outside ring would be
  // clipped, draw the strong ring inside (.focus-ring-strong-inset). An inline
  // outline would override the ring, so none is set inline (the colour
  // swatches show selection as a box-shadow, and their focus ring sits outside
  // it: .focus-ring-strong-outset).
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components', rel), 'utf8')
  const FILES = ['SettingsPage.tsx', 'AccountsPanel.tsx', 'settings/AccountIsolationNotice.tsx', 'settings/AccountWebSession.tsx']
  /** The outline switched off, hidden, zero-width or transparent, under any
   *  variant (focus:, focus-visible:) or none, with the important mark before
   *  (v3, !outline-none) or after (v4, outline-none!). */
  const OUTLINE_OFF = /(?:^|[\s"'`{:])!?outline-(?:none|hidden|0|transparent|\[0(?:px)?\]|\[transparent\])!?(?=[\s"'`}]|$)/
  /** A Tailwind ring drawn on focus: focus: or focus-visible:, then ring or
   *  ring-*, important mark either side included. */
  const FOCUS_RING = /(?:^|[\s"'`{:])focus(?:-visible)?:(?:[a-z-]+:)*!?ring(?:-[^\s"'`}]+)?!?(?=[\s"'`}]|$)/
  /** The standard, translucent .focus-ring class (not the strong forms). */
  const WEAK_CLASS = /(?:^|[\s"'`{])focus-ring(?=[\s"'`}]|$)/
  /** An outline set as a property: in an inline style object (camelCase,
   *  spaced or not, key quoted or not) or a Tailwind arbitrary property
   *  (kebab-case, focus-visible:[outline-style:none]). */
  const INLINE_OUTLINE = /\boutline(?:Offset|Width|Color|Style|-offset|-width|-color|-style)?['"]?\s*:/

  it('the patterns match what they name and nothing else', () => {
    for (const s of [
      'className="focus:outline-none"', 'className="a outline-none b"', 'className="focus-visible:outline-none"',
      'className="focus:outline-hidden"', 'className="focus-visible:outline-0"', 'className="focus:outline-none!"',
      'className="!outline-none"', 'className="focus:!outline-none"', 'className="outline-transparent"', 'className="focus:outline-[0px]"',
      'className="focus-visible:outline-[transparent]"',
    ]) {
      expect(OUTLINE_OFF.test(s), s).toBe(true)
    }
    for (const s of [
      'className="focus-visible:ring-1"', 'className="x focus:ring-blue/50"', 'className="focus-visible:ring"', 'className="focus-visible:ring-[1px]"',
      'className="focus-visible:!ring-1"', 'className="focus-visible:ring-1!"', 'className="focus:ring!"',
    ]) {
      expect(FOCUS_RING.test(s), s).toBe(true)
    }
    for (const s of ['className="focus-ring"', 'className="a focus-ring b"', "{'focus-ring'}"]) expect(WEAK_CLASS.test(s), s).toBe(true)
    for (const s of ['className="focus-ring-strong"', 'className="focus-ring-strong-inset"', 'className="focus-ring-strong-outset"', 'className="ring-1 ring-surface0"', 'className="outline-offset-2"', 'className="outline-offset-0"', 'className="outline-2"']) {
      expect(OUTLINE_OFF.test(s), s).toBe(false)
      expect(FOCUS_RING.test(s), s).toBe(false)
      expect(WEAK_CLASS.test(s), s).toBe(false)
    }
    for (const s of [
      "outline: isSelected ? '2px solid red' : undefined,", "outlineOffset: '2px',", "style={{outline:'none'}}", "style={{ 'outline': 'none' }}", 'style={{ outlineWidth : 0 }}',
      'className="focus-visible:[outline-style:none]"', 'className="[outline-width:0]"', 'className="focus:[outline:none]"',
    ]) {
      expect(INLINE_OUTLINE.test(s), s).toBe(true)
    }
    for (const s of ['className="focus-ring-strong"', 'className="focus:outline-none"', '// the outline of the card']) {
      expect(INLINE_OUTLINE.test(s), s).toBe(false)
    }
  })

  it('no control switches its outline off, draws its focus as a Tailwind ring or the translucent .focus-ring, and no inline style sets an outline', () => {
    const hits = FILES.flatMap((f) => read(f).split(/\r?\n/)
      .filter((l) => OUTLINE_OFF.test(l) || FOCUS_RING.test(l) || WEAK_CLASS.test(l) || INLINE_OUTLINE.test(l))
      .map((l) => `${f}: ${l.trim()}`))
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('the controls that had the faint ring or none draw the strong one', () => {
    const cases: [string, string, number, string][] = [
      // The colour swatches: the outset form, outside a selected swatch's own ring.
      ['AccountsPanel.tsx', 'data-testid={`colour-swatch-', 1, 'focus-ring-strong-outset'],
      ['AccountsPanel.tsx', 'data-testid={`delete-profile-', 1, 'focus-ring-strong'],
      ['AccountsPanel.tsx', 'data-testid="add-account-btn"', 1, 'focus-ring-strong'],
      ['settings/AccountIsolationNotice.tsx', 'data-testid="isolation-info-toggle"', 1, 'focus-ring-strong'],
      // The shortcut capture boxes, focused by the app when a capture starts.
      ['SettingsPage.tsx', 'data-shortcut-capture', 2, 'focus-ring-strong'],
      // The Settings tabs rail.
      ['SettingsPage.tsx', 'onClick={() => onChange(tab.id)}', 1, 'focus-ring-strong-inset'],
    ]
    for (const [f, anchor, n, ring] of cases) {
      const parts = read(f).split(anchor).slice(1)
      expect(parts, `${f}: ${anchor}`).toHaveLength(n)
      for (const p of parts) expect(p.match(/className="([^"]*)"/)?.[1]?.split(/\s+/), `${f}: ${anchor}`).toContain(ring)
    }
  })
})
