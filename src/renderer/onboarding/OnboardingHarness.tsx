import { useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { WelcomeStep } from './WelcomeStep'
import { FindClaudeStep } from './FindClaudeStep'
import { CompatibilityStep } from './CompatibilityStep'
import { AccountsStep } from './AccountsStep'

interface StepNav {
  onNext: () => void
  onBack: () => void
}

// Shared onboarding state that flows between steps — e.g. the Claude version p2
// detects, which p3 (Compatibility) uses for its version check.
interface OnboardingCtx {
  version: string | null
  setVersion: (v: string | null) => void
}

interface BuiltStep {
  id: string
  phase: number
  render: (nav: StepNav, ctx: OnboardingCtx) => ReactNode
}

// The built onboarding pages in flow order. Grows as each page lands; the full
// registry-driven flow (completedSteps stamping, per-step settle, finish, and
// conditional steps) replaces this array once every page is signed off.
const PAGES: BuiltStep[] = [
  { id: 'welcome', phase: 0, render: (nav) => <WelcomeStep onNext={nav.onNext} /> },
  {
    id: 'findClaude',
    phase: 0,
    render: (nav, ctx) => <FindClaudeStep onNext={nav.onNext} onBack={nav.onBack} onVersion={ctx.setVersion} />,
  },
  {
    id: 'compatibility',
    phase: 0,
    render: (nav, ctx) => <CompatibilityStep onNext={nav.onNext} onBack={nav.onBack} version={ctx.version} />,
  },
  { id: 'accounts', phase: 1, render: (nav) => <AccountsStep onNext={nav.onNext} onBack={nav.onBack} /> },
]

export function OnboardingHarness() {
  const [cursor, setCursor] = useState(PAGES[0].id)
  const [version, setVersion] = useState<string | null>(null)
  const idx = Math.max(0, PAGES.findIndex((p) => p.id === cursor))
  const step = PAGES[idx]
  const nav: StepNav = {
    onNext: () => {
      const next = PAGES[idx + 1]
      if (next) setCursor(next.id)
    },
    onBack: () => {
      const prev = PAGES[idx - 1]
      if (prev) setCursor(prev.id)
    },
  }
  const ctx: OnboardingCtx = { version, setVersion }
  return <OnboardingShell phase={step.phase}>{step.render(nav, ctx)}</OnboardingShell>
}
