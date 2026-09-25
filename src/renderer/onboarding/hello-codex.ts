// WP2 commit 6f: Hello Codex, the Codex introduction (docs/wp2/hello-codex-spec.md,
// mockup .ccc-canvas/hello-codex.html v1, page 4 from .ccc-canvas/commit6-surfaces.html
// F3). This module is the part without React: when the page is due, its seen
// stamp, whether a replay or the one-time takeover is open, and the copy.
//
// The copy lives here, as data, so the truthfulness rules can be tested on
// every line (no em dashes, no emoji), and so the lines that depend on
// something outside the page are decided by data, never by editing it: the
// Claude review line by the build (CLAUDE_REVIEW_SHIPS), and every Claude
// claim by whether Claude Code is on (a Codex-only install has no Claude
// sessions and no Claude reviews).
import type { AccountsSnapshot } from '../../shared/providers'
import type { HelloCodexOpen } from './hello-codex-open'
import { providerView } from '../stores/providerAccountsStore'
import { DEFAULT_CONDUCTOR_TOOLS } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { runningVersion } from './whats-new-gate'
import { usesClaude, type ProviderChoiceView } from './provider-choice'

/**
 * Does this build ship `claude_review` (WP2 commit 5b)? Read from the build's
 * own list of built-in tools: the Claude review switch shipped with the tool
 * in 5b, so its presence in that list stands for the tool. The review page's
 * "From a Codex session" line, the Codex half of its drawing and the
 * comparison table's Codex review cell follow it, together with Claude Code
 * being on (claudeCodeOn).
 */
export const CLAUDE_REVIEW_SHIPS: boolean = Object.prototype.hasOwnProperty.call(DEFAULT_CONDUCTOR_TOOLS, 'claudeReview')

/** The appMeta view the gate reads. */
export interface HelloCodexMetaView {
  helloCodexSeenVersion?: string
}

/**
 * "Set up", from the accounts snapshot (spec, "When it shows"):
 *   1. the Codex installation is enabled, and the user has said yes to it
 *      (not off, not undecided);
 *   2. its executable was found and its version is not refused (too old, or
 *      one this app does not support);
 *   3. at least one Codex account is active and last known signed in, not
 *      blocked, vouched for (not unverified), and not an external sign-in.
 *      External sign-ins (this computer's own ~/.codex) are excluded
 *      outright, so as the only account one never makes the page due;
 *      Settings, Accounts says what to do.
 */
export function codexSetUp(snapshot: AccountsSnapshot | null): boolean {
  if (!snapshot) return false
  const p = providerView(snapshot, 'codex')
  if (!p || !p.enabled || p.preference !== 'on') return false
  if (p.discoveryState !== 'found') return false
  if (p.compatibility === 'too-old' || p.compatibility === 'unsupported') return false
  return snapshot.accounts.some((a) =>
    a.providerId === 'codex'
    && a.lifecycle === 'active'
    && a.lastKnownAuthState === 'signed-in'
    && a.operationalState !== 'blocked'
    && !a.unverified
    && !a.external,
  )
}

/** Set up and never seen. Presence of the stamp is what counts, so an upgrade
 *  never shows the page again. */
export function helloCodexDue(snapshot: AccountsSnapshot | null, meta: HelloCodexMetaView): boolean {
  return !meta.helloCodexSeenVersion && codexSetUp(snapshot)
}

/** Is Claude Code on? The saved setting says so (absent means on), and main
 *  has not switched it off. With it off there are no Claude sessions and
 *  no Claude reviews (main offers claude_review only with Claude on), so the
 *  pages say nothing that needs Claude. */
export function claudeCodeOn(settings: ProviderChoiceView, snapshot: AccountsSnapshot | null): boolean {
  return usesClaude(settings) && providerView(snapshot, 'claude')?.enabled !== false
}

/** Record that the introduction was seen: Done, Skip, Escape and "Start a
 *  Codex session", in onboarding and in the takeover, and a replay left while
 *  the page was still due (it was the showing). The running version is
 *  recorded for the record; presence is what the gate reads, so a build with
 *  no version still stamps. */
export function markHelloCodexSeen(): void {
  try {
    useAppMetaStore.getState().update({ helloCodexSeenVersion: runningVersion() || 'seen' })
  } catch {
    // Ignore storage errors, like the other seen stamps.
  }
}

// Whether it is open outside onboarding, and the replay request: their own
// module (no store imports), re-exported here.
export { useHelloCodexStore, showHelloCodexReplay, type HelloCodexOpen } from './hello-codex-open'

/**
 * Should the one-time takeover open now? Only when the page is due, nothing
 * has it open already, every boot gate has had its turn (`gatesClear`, from
 * bootChain in utils/bootGates.ts), and no dialog or other window-level
 * overlay is up. Once open it stays open until the user leaves it: its own
 * overlay does not count against it, because this is asked only while closed.
 */
export function helloCodexTakeoverReady(s: { due: boolean; open: HelloCodexOpen; gatesClear: boolean; overlays: number }): boolean {
  return s.open === null && s.due && s.gatesClear && s.overlays === 0
}

/** Keys are ignored for this long after the takeover opens: it can open late
 *  (a slow discovery, a sign-in refresh) while the user is typing elsewhere,
 *  and a keystroke meant for a terminal must not page through it or dismiss
 *  it unseen. */
export const HELLO_CODEX_ARM_MS = 500

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

export type HelloCodexPageId = 'hello' | 'accounts' | 'launch' | 'review' | 'differences'

export interface HelloCodexPoint {
  /** Bold lead-in. */
  lead: string
  /** The rest of the line; `backticks` mark code. */
  rest: string
}

export interface HelloCodexPage {
  id: HelloCodexPageId
  heading: string
  tagline: string
  points: HelloCodexPoint[]
  /** The muted "Where:" locator, without the "Where: " prefix. */
  where?: string
  /** The small chip under page 1's points. */
  localNote?: string
}

export const HELLO_CODEX_PAGE_COUNT = 5

/** What the copy depends on outside the page. */
export interface HelloCodexCopyInputs {
  /** `claude_review` ships in this build (CLAUDE_REVIEW_SHIPS). */
  claudeReview: boolean
  /** Claude Code is on (claudeCodeOn). */
  claudeOn: boolean
}

/** The five pages, in order. With Claude Code off, nothing claims Claude
 *  sessions or Claude reviews, and the review page says what code review
 *  needs; with `claude_review` not shipped, the review page tells only the
 *  Claude-to-Codex direction. */
export function helloCodexPages(opts: HelloCodexCopyInputs): HelloCodexPage[] {
  const review: HelloCodexPoint[] = []
  if (!opts.claudeOn) {
    review.push(
      { lead: 'It needs Claude Code too.', rest: 'Code review asks the other provider for a second opinion, so it needs Claude Code on as well. Turn it on in Settings, Accounts.' },
      { lead: 'A separate reviewer, not another session.', rest: 'Each review starts its own one-off reviewer: read-only, in this project, and nothing is saved as a conversation. It never uses one of your open sessions, and it cannot ask for a review of its own.' },
    )
  } else {
    review.push({ lead: 'From a Claude session.', rest: 'Ask for a "Codex review". Codex reviews the change, or the files you name, on your Codex reviewer account.' })
    if (opts.claudeReview) {
      review.push({ lead: 'From a Codex session.', rest: 'Ask for a "Claude review". Claude does the same on your Claude reviewer account.' })
    }
    review.push(
      { lead: 'A separate reviewer, not another session.', rest: 'Each review starts its own one-off reviewer: read-only, in this project, and nothing is saved as a conversation. It never uses one of your open sessions, and it cannot ask for a review of its own.' },
      opts.claudeReview
        ? { lead: 'You stay in control.', rest: 'Each direction has its own switch in Settings, General, Built-in Tools, and the reviewer accounts are set in Settings, Accounts.' }
        : { lead: 'You stay in control.', rest: 'Codex review has its own switch in Settings, General, Built-in Tools, and the Codex reviewer account is set in Settings, Accounts.' },
    )
  }
  return [
    {
      id: 'hello',
      heading: 'Hello, Codex',
      tagline: opts.claudeOn ? 'Codex now runs beside Claude, in the same window.' : 'Codex now runs in this window.',
      points: [
        { lead: 'Your Codex account is ready.', rest: "It is signed in and it is yours. Codex keeps its sign-in in that account's own folder, and this app never reads it." },
        opts.claudeOn
          ? { lead: 'Sessions side by side.', rest: 'Codex sessions open as tabs next to Claude ones.' }
          : { lead: 'Sessions as tabs.', rest: 'Codex sessions open as tabs, like any other session.' },
        { lead: 'On this computer.', rest: 'In this release, Codex sessions and Codex reviews run on this computer only, not over SSH.' },
      ],
      localNote: 'Local sessions only in this release',
    },
    {
      id: 'accounts',
      heading: 'Accounts',
      tagline: 'Each Codex account keeps its own sign-in.',
      points: [
        { lead: 'One folder per account.', rest: 'Each account has its own sign-in folder, so sessions never mix identities.' },
        { lead: 'A default, and a reviewer default.', rest: 'New sessions use the default account. Code reviews use the reviewer default, or the default if none is set.' },
        { lead: 'An existing sign-in.', rest: 'A sign-in this app did not create (for example `~/.codex`) must be confirmed at each launch, and cannot run reviews.' },
        { lead: 'Sign-in methods.', rest: 'Sign in with ChatGPT, a device code or an API key. The key goes to Codex, and this app never stores it.' },
      ],
      where: 'Settings, Accounts',
    },
    {
      id: 'launch',
      heading: 'Launch and resume',
      tagline: 'Start Codex from the same New saved config dialog.',
      points: [
        { lead: 'Pick Codex.', rest: "In New saved config, choose the Codex card and an account. The project folder is Codex's workspace." },
        { lead: 'Resume where you left off.', rest: 'In a Codex session\'s Restart menu, "Restart and pick a conversation" offers its recent conversations in the terminal: type a number to pick one, n for a new one.' },
        { lead: 'Local only for now.', rest: 'The SSH options are off for Codex, and the dialog says why.' },
      ],
      where: "the sidebar's + New, Config",
    },
    {
      id: 'review',
      heading: 'Code review',
      tagline: 'Ask the other provider for a second opinion.',
      points: review,
      where: opts.claudeOn ? 'any session; Settings, General, Built-in Tools; Settings, Accounts' : 'Settings, Accounts',
    },
    {
      id: 'differences',
      heading: 'How Codex differs',
      tagline: 'The same place to work, with a few differences.',
      points: [
        { lead: 'Instructions.', rest: 'Codex reads `AGENTS.md`; Claude reads `CLAUDE.md`.' },
        { lead: 'Permissions.', rest: "Codex has its own approval and sandbox modes. Choose a preset in the session dialog; Claude's permission settings do not apply to it." },
        { lead: 'Conductor tools.', rest: 'Codex sessions get the Conductor tools that suit them. Vision, the in-app browser and the Agent Canvas stay with Claude sessions for now.' },
        { lead: 'Usage.', rest: "Codex reports tokens per session and review. Claude's rate-limit figures do not apply to Codex." },
      ],
      where: 'Feature Guide, Integrations',
    },
  ]
}

/** The Codex column's code review cell: what a Codex session can ask for. */
function codexReviewCell(opts: HelloCodexCopyInputs): string {
  if (!opts.claudeOn) return 'Needs Claude Code on'
  return opts.claudeReview ? 'Asks Claude' : 'Not yet'
}

/** The comparison table on the last page, as rows of [what, Claude, Codex]. */
export function helloCodexComparison(opts: HelloCodexCopyInputs): Array<[string, string, string]> {
  return [
    ['Instructions file', '`CLAUDE.md`', '`AGENTS.md`'],
    ['Permissions', 'Claude permission settings', 'Read-only, Standard, Auto, Unrestricted'],
    ['Runs over SSH', 'Yes', 'Not in this release'],
    ['Vision, browser, canvas', 'Yes', 'Not yet'],
    ['Code review', 'Asks Codex', codexReviewCell(opts)],
    ['Usage shown', 'Rate limits', 'Tokens, and its limits when it sends them'],
  ]
}
