import type { ReactNode } from 'react'
import { BrandMark } from './BrandMark'

/** Phase-based breadcrumb (matches the mockup's crumbsHtml / PHASE map). */
const PHASES = ['Set up', 'Account', 'Features', 'Review']

function crumbClass(i: number, phase: number): string {
  if (i < phase) return 'crumb done'
  if (i === phase) return 'crumb on'
  return 'crumb'
}

export function OnboardingShell({ phase, children }: { phase: number; children: ReactNode }) {
  return (
    <div className="ob-root">
      <div className="field-bg">
        <div className="glow" />
        <div className="ring r1" />
        <div className="ring r2" />
        <div className="ring r3" />
      </div>
      <div className="top">
        <BrandMark className="blogo" />
        <span className="bname">Claude Command Center</span>
        <div className="crumbs">
          {PHASES.map((n, i) => (
            <span key={n} className={crumbClass(i, phase)}>
              {i < phase ? String.fromCodePoint(0x2713) + ' ' : ''}
              {n}
            </span>
          ))}
        </div>
      </div>
      <div className="pages">
        <section className="page active">{children}</section>
      </div>
    </div>
  )
}
