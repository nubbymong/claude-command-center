/**
 * The onboarding overflow contract (laptop bug, 2026-09-02).
 *
 * .ob-root is position:fixed + overflow:hidden, so any step taller than the
 * viewport used to push the footer's ONLY advance buttons off-screen with no
 * scrollbar anywhere (flex min-height:auto refused to shrink .p2; the
 * "What you're getting" summary on a short laptop screen was the reporter).
 * The fix is three declarations in onboarding.css and nothing else, and jsdom
 * performs no layout, so this pins the DECLARATIONS themselves — verified
 * against a real engine at 600px (canvas layout check, 2026-09-02): the old
 * rules clip the CTA past the frame edge, the new ones keep the footer fully
 * visible and make the content scroll from the top.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(
  path.resolve(__dirname, '../../../src/renderer/onboarding/onboarding.css'),
  'utf-8',
)

/** The single .p2 rule (first match wins — it is defined once). */
function rule(selector: string): string {
  const m = css.match(new RegExp(`\\.ob-root ${selector.replace('.', '\\.')} \\{([^}]*)\\}`))
  expect(m, `${selector} rule exists`).toBeTruthy()
  return m![1]
}

describe('onboarding step overflow contract', () => {
  it('.p2 is a shrinkable scroll container, so the footer can never be pushed off-screen', () => {
    const p2 = rule('.p2')
    expect(p2).toContain('min-height: 0')
    expect(p2).toContain('overflow-y: auto')
    // The centred-flex overflow trap: justify-content: center clips BOTH ends
    // of overflowing content unreachably. Centring must ride the child's auto
    // margins instead.
    expect(p2).not.toContain('justify-content: center')
  })

  it('.p2-inner centres via auto margins (identical when it fits, scrollable from the top when it does not)', () => {
    const inner = rule('.p2-inner')
    expect(inner).toContain('margin-top: auto')
    expect(inner).toContain('margin-bottom: auto')
  })

  it('.hero (welcome/finish) carries the same contract, via first/last-child auto margins (it has no single inner wrapper)', () => {
    const hero = rule('.hero')
    expect(hero).toContain('min-height: 0')
    expect(hero).toContain('overflow-y: auto')
    expect(hero).not.toContain('justify-content: center')
    expect(css).toContain('.ob-root .hero > :first-child { margin-top: auto; }')
    expect(css).toContain('.ob-root .hero > :last-child { margin-bottom: auto; }')
  })

  it('.sl-stage (status line step) carries the same contract', () => {
    const stage = rule('.sl-stage')
    expect(stage).toContain('min-height: 0')
    expect(stage).toContain('overflow-y: auto')
    expect(stage).not.toContain('justify-content: center')
    const inner = rule('.sl-inner')
    expect(inner).toContain('margin-top: auto')
    expect(inner).toContain('margin-bottom: auto')
  })
})
