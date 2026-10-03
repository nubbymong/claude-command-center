/**
 * "Do you use Codex?", asked once of everyone who updates (owner decisions,
 * 2026-09-26): "No matter who upgrades we need to either not set up codex or
 * set it up - they reconfirm either way." Codex now has accounts of its own
 * in this app, so nothing carries over from the earlier Codex setting, and
 * the Codex sign-in already on the computer is taken in only by the user's
 * explicit "Use this sign-in".
 *
 * The page (CodexReconfirmPage) is a boot gate, like the Allow Multi Spawn
 * startup page (multi-spawn-intro-gate.ts), and it follows the same split:
 * this module decides at BOOT, from meta read before anything stamps, whether
 * the page is armed for this launch; App keeps it up until the user answers.
 *
 * The marker is the answer itself, `settings.codexAnswered`, written with
 * `codexEnabled` by every way of answering (saveProviderSwitch): this page,
 * the fresh-install assistants page, "Use Codex only" on a setup screen, the
 * Providers switch and "Yes, I use Codex" in Settings, Accounts, and adding a
 * Codex account. It is NOT a "seen" stamp: showing the page stamps nothing,
 * so an app closed before an answer asks again at the next start. And it is
 * not a version stamp: once answered, no later update asks again.
 *
 * Two launches never get the page:
 *   - one that has ANSWERED (the marker is saved);
 *   - a FRESH INSTALL. It answers on the assistants page of its first-run
 *     setup, which records the same marker. `first-install` is asked of
 *     decideUpgradeFlow rather than re-derived here, so this and What's New
 *     can never disagree about which launch is somebody's first. A fresh
 *     install that left setup before answering is asked at its next start,
 *     which is no longer its first.
 */

import { decideUpgradeFlow } from './upgrade-flow'

export type CodexReconfirmReason = 'answered' | 'fresh-install' | 'due'

export interface CodexReconfirmDecision {
  /** Arm the page this launch. */
  show: boolean
  /** Why, in a word, so a test can assert the reason and not just the outcome. */
  reason: CodexReconfirmReason
}

export interface CodexReconfirmInput {
  /** codexAnswered(settings), as the saved settings say it. */
  answered: boolean
  /** `lastSeenVersion` from app meta, read before this launch stamps anything. */
  lastSeenVersion?: string
  /** `lastRunVersionOf(meta)`: see upgrade-flow. */
  lastRunVersion?: string
  /** The version now running (`__APP_VERSION__`). */
  currentVersion: string
  /** Passed through to decideUpgradeFlow; only its first-install arm is used. */
  channel?: string
}

/** The user has answered "do you use Codex?" in this model. */
export function codexAnswered(settings: { codexAnswered?: boolean }): boolean {
  return settings.codexAnswered === true
}

/** Decided once, at boot. */
export function decideCodexReconfirm(input: CodexReconfirmInput): CodexReconfirmDecision {
  if (input.answered) return { show: false, reason: 'answered' }
  const flow = decideUpgradeFlow({
    lastSeenVersion: input.lastSeenVersion,
    lastRunVersion: input.lastRunVersion,
    currentVersion: input.currentVersion,
    channel: input.channel,
  })
  if (flow.kind === 'first-install') return { show: false, reason: 'fresh-install' }
  return { show: true, reason: 'due' }
}

/**
 * Is the page due now? Armed at boot and not yet answered, read live, so an
 * answer given before the page's turn (a setup screen's "Use Codex only" in
 * this run) means it never shows. Once it is showing (`shown`), only its own
 * answer closes it: the answer lands in the settings store before the page
 * has finished (and the save to disk can still fail, which the page reports
 * and lets the user retry), so the store alone must not take it down.
 */
export function codexReconfirmDue(s: { armed: boolean; shown: boolean; answered: boolean }): boolean {
  return s.armed && (s.shown || !s.answered)
}
