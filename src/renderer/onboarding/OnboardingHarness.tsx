import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { stepsNewSince } from './gate'
import { WhatsNewV2Step } from './WhatsNewV2Step'
import { WelcomeStep } from './WelcomeStep'
import { CommandBarStep } from './CommandBarStep'
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
import { settleOnboardingFinish, settleWhatsNewOnly } from './settle'
import { seenVersion } from './whats-new-gate'
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
  render: (nav: StepNav, ctx: OnboardingCtx, done: StepDone, run: RunShape) => ReactNode
}

/** What kind of run the page is being rendered inside, so a page can adapt its
 *  own copy without knowing how the harness picked its page list. */
interface RunShape {
  /** True when the harness opened purely to deliver release notes. */
  whatsNewOnly: boolean
  /** True when nothing follows this page — its CTA ends the run. */
  isLast: boolean
}

/** #463: one predicate, used straight and negated, so the upgrade and
 *  fresh What's-New steps can never both apply. lastSeenVersion is stamped
 *  by settleOnboardingFinish (markWhatsNewSeen) at the end of EVERY run —
 *  fresh included — which is what retires the fresh step after first launch.
 *  whatsNewV2Fresh deliberately has NO steps.ts entry: it must never surface
 *  via stepsNewSince; the stamp alone retires it. */
const isUpgrader = () => !!useAppMetaStore.getState().meta.lastSeenVersion

// The built onboarding pages in flow order. Grows as each page lands; the full
// registry-driven flow (completedSteps stamping, per-step settle, finish, and
// conditional steps) replaces this array once every page is signed off.
const PAGES: BuiltStep[] = [
  {
    id: 'whatsNewV2',
    phase: 0,
    // Upgraders only: lastSeenVersion is stamped by every What's-New/finish
    // dismissal since 1.2.x, so it exists exactly when there is a "before" to
    // compare against. Fresh installs have nothing "new" and start at welcome
    // (they meet the showcase at whatsNewV2Fresh below — the two gates are
    // isUpgrader() and its negation, so exactly one can ever apply).
    when: isUpgrader,
    render: (nav, _ctx, _done, run) => (
      <WhatsNewV2Step
        onNext={nav.onNext}
        // The page's own footer promised "the next pages set these up", which
        // is a lie on the common upgrade where nothing new needs setting up.
        ctaLabel={run.isLast ? 'Continue' : 'Set it up →'}
        hint={
          run.isLast
            ? 'Nothing to set up — your settings carried over.'
            : run.whatsNewOnly
              ? "Next: the settings this release added, and nothing else."
              : 'The next pages set these up, one at a time.'
        }
      />
    ),
  },
  { id: 'welcome', phase: 0, render: (nav) => <WelcomeStep onNext={nav.onNext} /> },
  {
    id: 'whatsNewV2Fresh',
    phase: 0,
    // First-runners (#463): the same showcase, right after Welcome — the
    // flagships ARE the app's introduction, so a fresh install meets them
    // here instead of never. The component swaps its heading off the
    // "what's new" diff framing; sectionsFor already yields the full
    // 2.0 + 2.1 story when there is no lastSeenVersion.
    when: () => !isUpgrader(),
    render: (nav, _ctx, _done, run) => (
      <WhatsNewV2Step
        onNext={nav.onNext}
        fresh
        ctaLabel={run.isLast ? 'Continue' : 'Set it up →'}
        hint={run.isLast ? 'That’s the tour.' : 'The next pages set these up, one at a time.'}
      />
    ),
  },
  // The one-row command bar (#382): new in 2.1.0-beta.17, so an upgrader's
  // notes run shows it right after the release notes; the full flow shows it
  // after Welcome. Back is offered only when there is a page before it.
  {
    id: 'commandBar',
    phase: 0,
    render: (nav, _ctx, _done, run) => <CommandBarStep onNext={nav.onNext} onBack={run.whatsNewOnly ? undefined : nav.onBack} />,
  },
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

/**
 * @param whatsNewOnly The harness is delivering release notes to someone who
 *   has already completed the flow. It shows the notes page plus ONLY the
 *   pages whose `sinceVersion` is newer than the build they last ran — never
 *   the whole flow again. This is the ordinary upgrade path since 2026-08-21;
 *   before it, an upgrade either re-walked all twelve pages or fell back to a
 *   wall-of-text modal.
 */
export function OnboardingHarness({
  onComplete,
  whatsNewOnly = false,
}: {
  onComplete: (startTour: boolean) => void
  whatsNewOnly?: boolean
}) {
  // The page list for THIS run, fixed at mount. Not recomputed per render: the
  // pages write the very settings their when() reads (codexSignIn follows the
  // codex toggle), so a live list would reshuffle underneath the user
  // mid-flow. The full flow keeps evaluating when() at navigation time, which
  // is where that reshuffle is wanted.
  const [pages] = useState<BuiltStep[]>(() => {
    if (!whatsNewOnly) return PAGES
    // The stamp clamped to the last build that ran, not the raw stamp — the
    // same origin the launch decision used (#369), so a stamp written ahead of
    // its build cannot hide a page that is new in this one.
    const lastSeen = seenVersion()
    const settings = { codexEnabled: useSettingsStore.getState().settings.codexEnabled }
    const newIds = new Set(stepsNewSince(lastSeen, settings).map((s) => s.id))
    return PAGES.filter((p) => p.id === 'whatsNewV2' || newIds.has(p.id))
  })
  // Which pages carry the "New" badge: in a notes run, everything except the
  // notes page itself is there BECAUSE it is new in this build.
  const newIds = useMemo(
    () => new Set(whatsNewOnly ? pages.filter((p) => p.id !== 'whatsNewV2').map((p) => p.id) : []),
    [whatsNewOnly, pages],
  )
  // Start at the first APPLICABLE page — pages[0] (whatsNewV2) is upgrader-only,
  // so a fresh install must open on welcome, not render a when():false page.
  const [cursor, setCursor] = useState(() => (pages.find((p) => !p.when || p.when()) ?? pages[0]).id)
  const [version, setVersion] = useState<string | null>(null)
  const idx = Math.max(0, pages.findIndex((p) => p.id === cursor))
  const step = pages[idx]
  const applicable = (p: BuiltStep | undefined) => !!p && (!p.when || p.when())
  const isLast = !pages.slice(idx + 1).some(applicable)
  const done: StepDone = {
    finish: (startTour) => {
      // Stamp completion + retire legacy popups, THEN hand control back to App.
      // The appMeta write flips deriveOnboarding to due:false; App's reactive
      // gate unmounts this harness on the next render.
      //
      // A notes run settles NARROWLY: it must not claim the setup pages it
      // never showed were completed. See settleWhatsNewOnly.
      if (whatsNewOnly) settleWhatsNewOnly()
      else settleOnboardingFinish()
      onComplete(startTour)
    },
  }
  const nav: StepNav = {
    onNext: () => {
      for (let i = idx + 1; i < pages.length; i++) {
        if (applicable(pages[i])) return setCursor(pages[i].id)
      }
      // Nothing applicable after this one. In the full flow the last page is
      // always `finish`, which ends the run through done.finish and never
      // calls onNext — so this arm belongs to the notes run, where the last
      // page is the notes themselves (or the last new setting) and its CTA has
      // to be what ends the run. Without it that button is simply dead.
      done.finish(false)
    },
    onBack: () => {
      for (let i = idx - 1; i >= 0; i--) {
        if (applicable(pages[i])) return setCursor(pages[i].id)
      }
    },
  }
  const ctx: OnboardingCtx = { version, setVersion }
  const run: RunShape = { whatsNewOnly, isLast }
  return (
    <OnboardingShell phase={step.phase} isNew={newIds.has(step.id)} showPhases={!whatsNewOnly}>
      {step.render(nav, ctx, done, run)}
    </OnboardingShell>
  )
}
