import { useState } from 'react'
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
import { AssistantsStep } from './AssistantsStep'
import { CodexSetupStep } from './CodexSetupStep'
import { TransparencyStep } from './TransparencyStep'
import { FinishStep } from './FinishStep'
import { settleOnboardingFinish, settleWhatsNewOnly } from './settle'
import { seenVersion } from './whats-new-gate'
import { usesClaude, usesCodex, claudeWasMissingAtSetup } from './provider-choice'
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
  /** Step aside so a terminal a page opened can be seen; the harness shows
   *  the way back and keeps the page as it was. */
  stepAside: () => void
  /** How many times the user has come back from stepping aside. */
  returns: number
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
  /** True when no page comes before this one: Back would go nowhere. */
  isFirst: boolean
}

/** #463: one predicate, used straight and negated, so the upgrade and
 *  fresh What's-New steps can never both apply. lastSeenVersion is stamped
 *  by settleOnboardingFinish (markWhatsNewSeen) at the end of EVERY run —
 *  fresh included — which is what retires the fresh step after first launch.
 *  whatsNewV2Fresh deliberately has NO steps.ts entry: it must never surface
 *  via stepsNewSince; the stamp alone retires it. */
const isUpgrader = () => !!useAppMetaStore.getState().meta.lastSeenVersion

/** WP2: the assistants page's choice, read at navigation time like every
 *  when(). The page saves it before it moves on, so the pages after it
 *  follow the choice, forwards and back. */
const claudeChosen = () => usesClaude(useSettingsStore.getState().settings)
const codexChosen = () => usesCodex(useSettingsStore.getState().settings)

/** WP2: an upgrader who pressed "Use Codex only" on a setup screen in THIS
 *  run (the Claude Code CLI was missing): the version-change screen, or the
 *  first-run screen of a new computer pointed at an existing resources
 *  folder, whose user has run the app before. Upgraders never see the
 *  fresh-install assistants page, so without this they would be left with
 *  Codex on and no way shown to set it up. They are handed the Codex setup
 *  page once, in this run: the flag is in memory only (provider-choice.ts),
 *  so a later start never shows it again, and nothing else is re-run. */
const codexHandOff = () => isUpgrader() && claudeWasMissingAtSetup() && codexChosen()

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
        hint={run.isLast ? "That's the tour." : 'The next pages set these up, one at a time.'}
      />
    ),
  },
  {
    id: 'assistants',
    phase: 0,
    // "Which assistants will you use?" (WP2): fresh installs only (owner
    // call). An upgrader keeps the providers they have, and changes them in
    // Settings, Accounts; steps.ts marks it freshInstallOnly for the notes run.
    // After Welcome and its showcase, as the first setup page: the showcase
    // has no Back, so this is where Back from the pages the choice decides
    // can always return to, to choose again.
    when: () => !isUpgrader(),
    render: (nav) => <AssistantsStep onNext={nav.onNext} onBack={nav.onBack} />,
  },
  // The one-row command bar (#382): new in 2.1.0-beta.17, so an upgrader's
  // notes run shows it right after the release notes; the full flow shows it
  // after Welcome. Back is offered only when there is a page before it.
  {
    id: 'commandBar',
    phase: 0,
    render: (nav, _ctx, _done, run) => <CommandBarStep onNext={nav.onNext} onBack={run.whatsNewOnly ? undefined : nav.onBack} />,
  },
  // Claude Code's own pages (find it, check its version, its accounts, its
  // status line) follow the assistants choice: a Codex-only run skips them.
  {
    id: 'findClaude',
    phase: 0,
    when: claudeChosen,
    render: (nav, ctx) => <FindClaudeStep onNext={nav.onNext} onBack={nav.onBack} onVersion={ctx.setVersion} />,
  },
  {
    id: 'compatibility',
    phase: 0,
    when: claudeChosen,
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
    when: () => claudeChosen() && window.electronPlatform !== 'darwin',
    render: (nav) => <AccountsStep onNext={nav.onNext} onBack={nav.onBack} />,
  },
  {
    id: 'codexSetup',
    phase: 1,
    // "Set up Codex" (WP2): install, update and sign in, when Codex was
    // chosen. Fresh installs only, like the choice itself, with one exception:
    // the upgrader handed to it by this run's "Use Codex only" (codexHandOff).
    // It replaces the "Do you use Codex?" and Codex sign-in pages, which have
    // left the flow.
    when: () => (!isUpgrader() && codexChosen()) || codexHandOff(),
    render: (nav, ctx, _done, run) => (
      <CodexSetupStep
        onNext={nav.onNext}
        onBack={run.isFirst ? undefined : nav.onBack}
        stepAside={ctx.stepAside}
        returns={ctx.returns}
      />
    ),
  },
  // GitHub deliberately precedes Status line (user call 2026-07-01): the p4
  // preview's Copilot element only exists once the meter is enabled, so the
  // integration must be introduced first.
  { id: 'github', phase: 2, render: (nav) => <GitHubStep onNext={nav.onNext} onBack={nav.onBack} /> },
  { id: 'statusline', phase: 2, when: claudeChosen, render: (nav) => <StatusLineStep onNext={nav.onNext} onBack={nav.onBack} /> },
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
 * @param codexSetupOnly The harness opened only to hand an upgrader who chose
 *   "Use Codex only" on a setup screen in this run (first-run or version
 *   change) to the Codex setup page (see codexHandOff): that page alone, no
 *   notes, no phases, and nothing stamped when it ends. App sets it only when
 *   neither the full flow nor the notes are due; in those runs the page joins
 *   them instead.
 */
export function OnboardingHarness({
  onComplete,
  whatsNewOnly = false,
  codexSetupOnly = false,
}: {
  onComplete: (startTour: boolean) => void
  whatsNewOnly?: boolean
  codexSetupOnly?: boolean
}) {
  // The page list for THIS run, fixed at mount, and which of them carry the
  // "New" badge. Not recomputed per render: the pages write the very settings
  // their when() reads (the assistants choice decides the Claude Code and
  // Codex setup pages), so a live list would reshuffle underneath the user
  // mid-flow. The full flow keeps evaluating when() at navigation time, which
  // is where that reshuffle is wanted: the pages after the assistants page
  // follow the choice as it is saved.
  const [{ pages, newIds }] = useState<{ pages: BuiltStep[]; newIds: ReadonlySet<string> }>(() => {
    if (codexSetupOnly) return { pages: PAGES.filter((p) => p.id === 'codexSetup'), newIds: new Set() }
    if (!whatsNewOnly) return { pages: PAGES, newIds: new Set() }
    // The stamp clamped to the last build that ran, not the raw stamp — the
    // same origin the launch decision used (#369), so a stamp written ahead of
    // its build cannot hide a page that is new in this one.
    const lastSeen = seenVersion()
    const { codexEnabled, claudeEnabled } = useSettingsStore.getState().settings
    // In a notes run, every page after the notes is there BECAUSE it is new in
    // this build, and is badged so; the Codex setup hand-off is there because
    // of this run's "Use Codex only", so it joins the run unbadged.
    const fresh = new Set(stepsNewSince(lastSeen, { codexEnabled, claudeEnabled }).map((s) => s.id))
    return {
      pages: PAGES.filter((p) => p.id === 'whatsNewV2' || fresh.has(p.id) || (p.id === 'codexSetup' && codexHandOff())),
      newIds: fresh,
    }
  })
  // Start at the first APPLICABLE page — pages[0] (whatsNewV2) is upgrader-only,
  // so a fresh install must open on welcome, not render a when():false page.
  const [cursor, setCursor] = useState(() => (pages.find((p) => !p.when || p.when()) ?? pages[0]).id)
  const [version, setVersion] = useState<string | null>(null)
  // Stepped aside for a terminal a page opened (Codex setup's "Run in a
  // terminal"): the pages stay mounted, just hidden, so the one the user left
  // is exactly as they left it when they come back.
  const [aside, setAside] = useState(false)
  const [returns, setReturns] = useState(0)
  const idx = Math.max(0, pages.findIndex((p) => p.id === cursor))
  const step = pages[idx]
  const applicable = (p: BuiltStep | undefined) => !!p && (!p.when || p.when())
  const isLast = !pages.slice(idx + 1).some(applicable)
  const isFirst = !pages.slice(0, idx).some(applicable)
  const done: StepDone = {
    finish: (startTour) => {
      // Stamp completion + retire legacy popups, THEN hand control back to App.
      // The appMeta write flips deriveOnboarding to due:false; App's reactive
      // gate unmounts this harness on the next render.
      //
      // A notes run settles NARROWLY: it must not claim the setup pages it
      // never showed were completed. See settleWhatsNewOnly. The Codex setup
      // hand-off alone settles nothing: it delivered no notes and completed
      // no flow, and App closes it by its own flag.
      if (codexSetupOnly) { /* nothing to stamp */ }
      else if (whatsNewOnly) settleWhatsNewOnly()
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
  const ctx: OnboardingCtx = { version, setVersion, stepAside: () => setAside(true), returns }
  const run: RunShape = { whatsNewOnly, isLast, isFirst }
  return (
    <>
      <OnboardingShell phase={step.phase} isNew={newIds.has(step.id)} showPhases={!whatsNewOnly && !codexSetupOnly} hidden={aside}>
        {step.render(nav, ctx, done, run)}
      </OnboardingShell>
      {aside && <BackToSetup onBack={() => { setAside(false); setReturns((n) => n + 1) }} />}
    </>
  )
}

/** While the harness has stepped aside for a terminal: the one way back. */
function BackToSetup({ onBack }: { onBack: () => void }) {
  return (
    <div
      className="fixed bottom-16 right-6 z-[100] flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg"
      style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-strong)' }}
      role="status"
      data-testid="onboarding-back-to-setup"
    >
      <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
        Setup is waiting. The terminal tab stays open when you go back.
      </span>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold focus-ring"
        style={{ background: 'var(--brand)', color: 'var(--text-on-brand)' }}
        data-testid="onboarding-back-to-setup-button"
      >
        Back to setup
      </button>
    </div>
  )
}
