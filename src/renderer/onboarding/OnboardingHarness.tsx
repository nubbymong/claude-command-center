import { useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { WhatsNewV2Step } from './WhatsNewV2Step'
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
import { FinishStep } from './FinishStep'
import { settleOnboardingFinish } from './settle'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'

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

interface StepDone {
  /** Called from the finish page. startTour=true launches the live-app guided
   *  tour after the harness dismisses; false reveals the app directly. */
  finish: (startTour: boolean) => void
}

interface BuiltStep {
  id: string
  phase: number
  /** Applicability gate, evaluated at navigation time (mirrors the registry's
   *  when()); a false step is skipped in both directions. */
  when?: () => boolean
  render: (nav: StepNav, ctx: OnboardingCtx, done: StepDone) => ReactNode
}

// The built onboarding pages in flow order. Grows as each page lands; the full
// registry-driven flow (completedSteps stamping, per-step settle, finish, and
// conditional steps) replaces this array once every page is signed off.
const PAGES: BuiltStep[] = [
  {
    id: 'whatsNewV2',
    phase: 0,
    // Upgraders only: lastSeenVersion is stamped by every What's-New/finish
    // dismissal since 1.2.x, so it exists exactly when there is a "before" to
    // compare against. Fresh installs have nothing "new" and start at welcome.
    when: () => !!useAppMetaStore.getState().meta.lastSeenVersion,
    render: (nav) => <WhatsNewV2Step onNext={nav.onNext} />,
  },
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
  {
    id: 'accounts',
    phase: 1,
    // Multi-account isolation is Windows-only: on macOS Claude Code's OAuth
    // token lives in the login Keychain, which HOME redirection cannot
    // isolate, so the page's "logins never mix" promise would be false there
    // (Mac readiness review 2026-07-02). Skip the page on darwin.
    when: () => window.electronPlatform !== 'darwin',
    render: (nav) => <AccountsStep onNext={nav.onNext} onBack={nav.onBack} />,
  },
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
  {
    id: 'finish',
    phase: 3,
    render: (_nav, _ctx, done) => (
      <FinishStep onTour={() => done.finish(true)} onSkip={() => done.finish(false)} />
    ),
  },
]

export function OnboardingHarness({ onComplete }: { onComplete: (startTour: boolean) => void }) {
  // Start at the first APPLICABLE page — PAGES[0] (whatsNewV2) is upgrader-only,
  // so a fresh install must open on welcome, not render a when():false page.
  const [cursor, setCursor] = useState(() => (PAGES.find((p) => !p.when || p.when()) ?? PAGES[0]).id)
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
  const done: StepDone = {
    finish: (startTour) => {
      // Stamp completion + retire legacy popups, THEN hand control back to App.
      // The appMeta write flips deriveOnboarding to due:false; App's reactive
      // gate unmounts this harness on the next render.
      settleOnboardingFinish()
      onComplete(startTour)
    },
  }
  const ctx: OnboardingCtx = { version, setVersion }
  return <OnboardingShell phase={step.phase}>{step.render(nav, ctx, done)}</OnboardingShell>
}
