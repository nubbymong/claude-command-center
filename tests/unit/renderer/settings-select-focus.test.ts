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
