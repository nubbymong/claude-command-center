import type { FC } from 'react'

/** Bump ONLY to force every user through the full flow again (rare). NOT __APP_VERSION__. */
export const ONBOARDING_VERSION = '2'

/** The minimal settings view the step `when` predicates read. Widen as later steps need it. */
export interface OnboardingSettingsView {
  codexEnabled?: boolean
}

export interface OnboardingStepProps {
  onNext: () => void
  onBack: () => void
  index: number
  total: number
}

export interface OnboardingSettleCtx {
  appVersion: string
}

export interface OnboardingStep {
  id: string
  sinceVersion: string
  requiresSetup: boolean
  /** Optional applicability gate; a when()-false step is excluded from the applicable set. */
  when?: (settings: OnboardingSettingsView) => boolean
  /** Attached per-page in later phases; absent here so pure tests build steps from metadata. */
  Component?: FC<OnboardingStepProps>
  /** Attached per-page in later phases; writes this step's real underlying flag(s). */
  settle?: (ctx: OnboardingSettleCtx) => void | Promise<void>
}

// NOTE (v2 contract): the harness (OnboardingHarness PAGES) is FULL-FLOW-ONLY.
// It does not consult completedSteps, so deriveOnboarding's incremental path
// (adding a step without bumping ONBOARDING_VERSION -> due:true for just that
// step) would re-run the whole flow from the top. Adding a page in a later
// release therefore REQUIRES an ONBOARDING_VERSION bump. Also: whatsNewV2's
// upgraders-only gate lives in the harness (when(): !!appMeta.lastSeenVersion,
// meta-based) and can't be expressed in the settings-view when() below.
export const STEPS: OnboardingStep[] = [
  { id: 'whatsNewV2',    sinceVersion: '2.0.0', requiresSetup: false },
  { id: 'welcome',       sinceVersion: '2.0.0', requiresSetup: false },
  { id: 'findClaude',    sinceVersion: '2.0.0', requiresSetup: false },
  { id: 'compatibility', sinceVersion: '2.0.0', requiresSetup: false },
  { id: 'accounts',      sinceVersion: '2.0.0', requiresSetup: false },
  // github precedes statusline (user call 2026-07-01): the status-line page's
  // Copilot preview element only exists once the GitHub meter is enabled.
  // codex precedes builtinTools (user call 2026-07-02): the answer drives the
  // Code review card's "Codex off" state and the codex_review tool gate.
  { id: 'github',        sinceVersion: '2.0.0', requiresSetup: true  },
  { id: 'statusline',    sinceVersion: '2.0.0', requiresSetup: true  },
  { id: 'codex',         sinceVersion: '2.0.0', requiresSetup: true  },
  { id: 'codexSignIn',   sinceVersion: '2.0.0', requiresSetup: true, when: (s) => s.codexEnabled === true },
  { id: 'builtinTools',  sinceVersion: '2.0.0', requiresSetup: true  },
  { id: 'transparency',  sinceVersion: '2.0.0', requiresSetup: true  },
  { id: 'finish',        sinceVersion: '2.0.0', requiresSetup: false },
]
