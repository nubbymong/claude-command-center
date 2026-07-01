import { useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { WelcomeStep } from './WelcomeStep'
import { FindClaudeStep } from './FindClaudeStep'
import { CompatibilityStep } from './CompatibilityStep'
import { AccountsStep } from './AccountsStep'
import { StatusLineStep } from './StatusLineStep'
import { GitHubStep } from './GitHubStep'
import { BuiltinToolsStep } from './BuiltinToolsStep'
import { CodexStep } from './CodexStep'
import { CodexSignInStep } from './CodexSignInStep'
import { TransparencyStep } from './TransparencyStep'
import { useSettingsStore } from '../stores/settingsStore'

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
  /** Applicability gate, evaluated at navigation time (mirrors the registry's
   *  when()); a false step is skipped in both directions. */
  when?: () => boolean
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
    render: (nav, ctx) => (
      <CompatibilityStep onNext={nav.onNext} onBack={nav.onBack} version={ctx.version} onVersion={ctx.setVersion} />
    ),
  },
  { id: 'accounts', phase: 1, render: (nav) => <AccountsStep onNext={nav.onNext} onBack={nav.onBack} /> },
  // GitHub deliberately precedes Status line (user call 2026-07-01): the p4
  // preview's Copilot element only exists once the meter is enabled, so the
  // integration must be introduced first.
  { id: 'github', phase: 2, render: (nav) => <GitHubStep onNext={nav.onNext} onBack={nav.onBack} /> },
  { id: 'statusline', phase: 2, render: (nav) => <StatusLineStep onNext={nav.onNext} onBack={nav.onBack} /> },
  // Codex precedes Built-in tools (user call 2026-07-02): the answer drives
  // p6's Code review card ("Codex off" state) and the codex_review tool gate.
  { id: 'codex', phase: 2, render: (nav) => <CodexStep onNext={nav.onNext} onBack={nav.onBack} /> },
  {
    id: 'codexSignIn',
    phase: 2,
    when: () => useSettingsStore.getState().settings.codexEnabled === true,
    render: (nav) => <CodexSignInStep onNext={nav.onNext} onBack={nav.onBack} />,
  },
  { id: 'builtinTools', phase: 2, render: (nav) => <BuiltinToolsStep onNext={nav.onNext} onBack={nav.onBack} /> },
  { id: 'transparency', phase: 3, render: (nav) => <TransparencyStep onNext={nav.onNext} onBack={nav.onBack} /> },
]

export function OnboardingHarness() {
  const [cursor, setCursor] = useState(PAGES[0].id)
  const [version, setVersion] = useState<string | null>(null)
  const idx = Math.max(0, PAGES.findIndex((p) => p.id === cursor))
  const step = PAGES[idx]
  const applicable = (p: BuiltStep | undefined) => !!p && (!p.when || p.when())
  const nav: StepNav = {
    onNext: () => {
      for (let i = idx + 1; i < PAGES.length; i++) {
        if (applicable(PAGES[i])) return setCursor(PAGES[i].id)
      }
    },
    onBack: () => {
      for (let i = idx - 1; i >= 0; i--) {
        if (applicable(PAGES[i])) return setCursor(PAGES[i].id)
      }
    },
  }
  const ctx: OnboardingCtx = { version, setVersion }
  return <OnboardingShell phase={step.phase}>{step.render(nav, ctx)}</OnboardingShell>
}
