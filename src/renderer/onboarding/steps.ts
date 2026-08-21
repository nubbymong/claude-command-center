import type { FC } from 'react'

/**
 * Bump ONLY to force EVERY user through the WHOLE flow again (rare). NOT __APP_VERSION__.
 *
 * ─── ADDING A PAGE? READ THIS FIRST ───────────────────────────────────────────
 *
 * Give the new step a `sinceVersion` of **the release it ships in** and stop
 * there. That is the whole mechanism: an upgrader gets the What's New page plus
 * every step whose `sinceVersion` is newer than the build they last ran, badged
 * "New in this release" (see `stepsNewSince` in gate.ts). A fresh install gets
 * the full flow regardless. Neither needs this constant touched.
 *
 * The trap is copying a neighbouring line and inheriting its `sinceVersion`.
 * A step stamped `2.0.0` is new to nobody who has already onboarded, so it is
 * invisible to every existing user — silently, with no error. The frozen
 * id→sinceVersion table in `onboarding-registry.test.ts` exists to make that a
 * deliberate act: adding or renumbering a step fails that test until you update
 * the table, which is where you will read this rule again.
 *
 * A page whose CONTENT materially changes bumps its own `sinceVersion` and
 * re-surfaces by the same rule. One field, both cases.
 *
 * Bump THIS constant only for "everyone walks the whole thing again", and take
 * the cost seriously: it is twelve pages in front of someone who came for the
 * release notes. Before 2026-08-21 every beta build did exactly that, which is
 * what made the first-launch experience a wall.
 *
 * '3' for the 2.1 line. A release that renamed the app, made remote sessions
 * survive a dropped link, and added the Agent Canvas is worth walking someone
 * through again — and the upgrade page's own content changed for the 2.1
 * cohort, which is the case this constant exists for.
 */
export const ONBOARDING_VERSION = '3'

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

// NOTE (contract, revised 2026-08-21): the harness runs in one of two shapes.
// The FULL flow (fresh install, or a forced re-onboard) walks every applicable
// page and does not consult completedSteps. The WHAT'S-NEW-ONLY run — the
// ordinary upgrade — shows the notes page plus `stepsNewSince(lastSeenVersion)`
// and nothing else.
//
// So adding a page no longer REQUIRES an ONBOARDING_VERSION bump, which is what
// this note used to say: give it the `sinceVersion` of its release and
// upgraders get it on its own. Bump the constant only when everyone should
// re-walk the whole flow. See the constant's own comment above.
//
// Unchanged: whatsNewV2's upgraders-only gate lives in the harness (when():
// !!appMeta.lastSeenVersion, meta-based) and can't be expressed in the
// settings-view when() below.
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
