/**
 * P3.13 (row 72): the one-at-a-time rule and its words are ONE definition,
 * asked by the renderer's launch surfaces and by main at pty:spawn. These pin
 * the rule's table, the words, and the one naming convention main and the
 * renderer must agree on (the partner terminal's PTY id).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isOneAtATimeBlocked,
  alreadyRunningCopy,
  alreadyRunningRefusalMessage,
  PARTNER_PTY_SUFFIX,
  isPartnerPtyId,
} from '../../../src/shared/multi-spawn-rule'
import { refusedTabText } from '../../../src/shared/providers'

const ROOT = resolve(__dirname, '..', '..', '..')

describe('isOneAtATimeBlocked', () => {
  it('nothing else running: never blocked, whatever the stored value', () => {
    for (const v of [undefined, false, true, 'yes', 1, null]) expect(isOneAtATimeBlocked(v, 0), String(v)).toBe(false)
  })

  it('another copy running: only an explicit true lets a launch through', () => {
    expect(isOneAtATimeBlocked(true, 1)).toBe(false)
    expect(isOneAtATimeBlocked(true, 5)).toBe(false)
    // never chosen, declined, and anything a hand edit could leave behind
    for (const v of [undefined, false, 'yes', 'true', 1, 0, null, {}, []]) expect(isOneAtATimeBlocked(v, 1), String(v)).toBe(true)
  })

  it('a count that is not a count never blocks', () => {
    for (const n of [0, -1, Number.NaN]) expect(isOneAtATimeBlocked(false, n), String(n)).toBe(false)
  })
})

describe('the words', () => {
  it('the popover copy is what the sidebar has always said', () => {
    expect(alreadyRunningCopy('App Dev')).toEqual({
      headline: 'App Dev is already running.',
      body: "It isn't a Multi Spawn config, so it runs one at a time.",
    })
  })

  it('main\'s refusal says it and then what to do, and reads as a whole sentence in the tab', () => {
    const message = alreadyRunningRefusalMessage('App Dev')
    expect(message).toBe("App Dev is already running. It isn't a Multi Spawn config, so it runs one at a time. Close the other copy, or turn on Allow Multi Spawn for it.")
    expect(refusedTabText({ message })).toBe("Not started. App Dev is already running. It isn't a Multi Spawn config, so it runs one at a time. Close the other copy, or turn on Allow Multi Spawn for it, then Restart this tab.")
  })

  it('the words name the setting by the label the config dialog shows', () => {
    const dialog = readFileSync(resolve(ROOT, 'src/renderer/components/SessionDialog.tsx'), 'utf8')
    expect(dialog).toContain('Allow Multi Spawn')
    expect(alreadyRunningRefusalMessage('x')).toContain('Allow Multi Spawn')
  })

  it('every refusal is plain ASCII', () => {
    expect(alreadyRunningRefusalMessage('x')).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('the partner terminal id', () => {
  it('is a session id plus the suffix', () => {
    expect(isPartnerPtyId('a1b2c3-partner')).toBe(true)
    expect(isPartnerPtyId('a1b2c3')).toBe(false)
    expect(isPartnerPtyId('a1b2c3-partner-x')).toBe(false)
    expect(isPartnerPtyId('')).toBe(false)
  })

  it('is the suffix every renderer site that names a partner terminal uses', () => {
    // main recognises the shell of a session by this shape; a renderer that
    // named it another way would make the shell count as a copy of its config.
    for (const file of ['src/renderer/App.tsx', 'src/renderer/hooks/useRestartSession.ts', 'src/renderer/ptyTracker.ts']) {
      const text = readFileSync(resolve(ROOT, file), 'utf8')
      const named = [...text.matchAll(/\+\s*'(-[a-z]+)'/g)].map((m) => m[1]).filter((s) => /partner/.test(s))
      expect(named.length, file).toBeGreaterThan(0)
      for (const s of named) expect(s, file).toBe(PARTNER_PTY_SUFFIX)
    }
  })
})
