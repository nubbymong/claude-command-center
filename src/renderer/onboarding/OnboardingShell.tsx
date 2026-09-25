import { useRef } from 'react'
import type { ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'
import { useContainFocus } from './contain-focus'

/** Phase-based breadcrumb (matches the mockup's crumbsHtml / PHASE map). */
const PHASES = ['Set up', 'Account', 'Features', 'Review']

function crumbClass(i: number, phase: number): string {
  if (i < phase) return 'crumb done'
  if (i === phase) return 'crumb on'
  return 'crumb'
}

export function OnboardingShell({
  phase,
  isNew = false,
  showPhases = true,
  hidden = false,
  children,
}: {
  phase: number
  /** This page is here because the setting it covers is NEW in this build —
   *  badge it, so an upgrader can see why they are being shown it at all. */
  isNew?: boolean
  /** False on a release-notes run: the four-phase breadcrumb describes a setup
   *  flow that is not happening, and would light one phase the user can never
   *  navigate away from. */
  showPhases?: boolean
  /** Stepped aside (a terminal the page opened is showing): kept mounted,
   *  not shown. `display` itself, because .ob-root sets its own. */
  hidden?: boolean
  children: ReactNode
}) {
  // The pages cover the whole window, so Tab stays on them (contain-focus.ts):
  // it used to walk out to the title bar and sidebar hidden underneath. Not
  // while stepped aside: the terminal the page opened is the user's then.
  // The introduction takeover and its replay are rendered in this shell too.
  const rootRef = useRef<HTMLDivElement>(null)
  useContainFocus(rootRef, !hidden)
  return (
    <div ref={rootRef} className="ob-root" style={hidden ? { display: 'none' } : undefined}>
      <div className="field-bg">
        <div className="glow" />
        <div className="ring r1" />
        <div className="ring r2" />
        <div className="ring r3" />
      </div>
      <div className="top">
        <BrandMark className="blogo" />
        <span className="bname">AI Code Conductor</span>
        {isNew && <span className="ob-new">New in this release</span>}
        {showPhases && (
          <div className="crumbs">
            {PHASES.map((n, i) => (
              <span key={n} className={crumbClass(i, phase)}>
                {i < phase ? String.fromCodePoint(0x2713) + ' ' : ''}
                {n}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="pages">
        <section className="page active">{children}</section>
      </div>
    </div>
  )
}
