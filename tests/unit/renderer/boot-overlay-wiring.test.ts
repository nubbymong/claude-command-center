// Two boot/overlay wirings that live in JSX and so have no behavioural test of
// their own. Both are one-expression regressions -- exactly the kind that a
// later edit drops silently -- so they are asserted against the source, the
// same technique app-lifecycle-wiring.test.ts uses.
//
// CRLF -> LF is normalised first: there is no `*.tsx text eol=lf` in
// .gitattributes, so a Windows checkout is CRLF and un-normalised markers miss.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const readSrc = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

describe('AccountLaunchGate is suppressed by the boot-gate chain', () => {
  const APP = readSrc('src/renderer/App.tsx')

  it('App passes the live boot gate to the account picker', () => {
    // Without this the per-session account pickers of a restore paint on top of
    // the Multi Spawn startup page, which by design comes AFTER resume.
    expect(APP).toContain('<AccountLaunchGate suppressed={bootGate !== null} />')
  })

  it('the gate is not ALSO rendered unsuppressed somewhere', () => {
    const uses = APP.match(/<AccountLaunchGate\b/g) ?? []
    expect(uses.length, 'exactly one render site').toBe(1)
  })

  it('SentinelPanel keeps its own suppression', () => {
    // The sibling overlay this fix was modelled on -- if it regresses, the
    // reasoning behind the account-gate fix has gone with it.
    expect(APP).toContain('{bootGate === null && <SentinelPanel />}')
  })
})

describe('SessionContextMenu is placed inside the viewport', () => {
  const MENU = readSrc('src/renderer/components/sidebar/SessionContextMenu.tsx')

  it('uses the shared placement helper rather than the raw pointer coordinates', () => {
    expect(MENU).toContain("import { placeMenu, type MenuPlacement } from '../../utils/menuPlacement'")
    expect(MENU).toContain('placeMenu({')
  })

  it('measures the FULL content height, not the capped box', () => {
    // Measuring offsetHeight once a maxHeight is applied shrinks the menu a
    // little more on every pass.
    expect(MENU).toContain('height: el.scrollHeight')
  })

  it('re-measures when the account list expands', () => {
    // Switch Account adds one row per account; without this dep the menu keeps
    // the placement it had while collapsed and the new rows fall off-screen --
    // the reported bug.
    expect(MENU).toMatch(/\}, \[x, y, accountOpen\]\)/)
  })

  it('re-measures on ANY size change, not just the one dep', () => {
    // ADR-009 on this delta: accountOpen is the only LOCAL state that changes
    // the height. watchdogChecks arrives as a prop, pushed asynchronously from
    // main, so a menu measured before the watcher reports then grows a header,
    // three toggles and a hint -- and with a stale placement those rows fall
    // off-screen along with the scrollbar that would have reached them.
    expect(MENU).toContain('new ResizeObserver(measure)')
    expect(MENU).toContain('ro.observe(menuRef.current)')
    expect(MENU, 'the observer must be torn down with the menu').toContain('ro?.disconnect()')
  })

  it('tolerates an environment without ResizeObserver', () => {
    expect(MENU).toContain("typeof ResizeObserver !== 'undefined'")
  })

  it('applies the cap and lets a capped menu scroll', () => {
    expect(MENU).toContain('maxHeight: placement?.maxHeight')
    expect(MENU).toContain("overflowY: 'auto'")
  })
})
