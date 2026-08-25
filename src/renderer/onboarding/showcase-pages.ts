import { releaseLine } from '../utils/versionLabel'

/**
 * The What's New feature showcase (owner-approved design, 2026-08-24; scope
 * revised 2026-08-25, #463): after the one-line summary page, each flagship
 * gets a full page of its own — heading, tagline, a few one-liner points, a
 * "where to find it" locator, and a drawn vignette (ShowcaseVignette).
 *
 * The set tours EVERYTHING the 2.1 line added over 2.0 — the Agent Canvas is
 * completely new since 2.0, and the pages say so — because the showcase has
 * two audiences (#463): a 2.0 user deciding what the update gave them, and a
 * first-run user meeting these features for the first time. Copy must read
 * for both: name what the feature IS before what it replaced, and keep
 * upgrade-only framing ("three rows became one") out of headings.
 *
 * Curated HERE, not in changelog.ts, for the same reason WhatsNewV2Step's
 * SECTIONS are: changelog.ts is a fragile pure-data literal that
 * scripts/gen-changelog.js extracts by bracket-matching, and the showcase is
 * editorial content for the upgrade flow, not part of the release record. By
 * construction nothing in this file can break `npm run changelog` or the
 * "Changelog in sync" CI.
 *
 * The summary page links here: a WhatsNewItem carrying `seeIt: '<page id>'`
 * grows a "See it →" chip that jumps to that page. An id with no matching page
 * renders no chip, so the two files cannot drift into a dead button.
 */

export type ShowcaseArtKind = 'canvas' | 'watchdog' | 'oneRow' | 'panel' | 'accounts'

export interface ShowcasePoint {
  /** Bold lead-in, ending in a full stop unless the rest continues the sentence. */
  lead: string
  rest: string
}

export interface ShowcasePage {
  id: string
  heading: string
  tagline: string
  /** Three or four; more is a wall and belongs in the Feature Guide. */
  points: ShowcasePoint[]
  /** The muted locator under the points: pre + emphasised + post. */
  where: { pre: string; em: string; post: string }
  art: ShowcaseArtKind
}

export const SHOWCASES_21: ShowcasePage[] = [
  {
    id: 'canvas',
    heading: 'The Agent Canvas — new to this line',
    tagline: "Claude renders its work as a real page inside the app. You point at what's wrong; it reads every note and fixes it all in one pass.",
    points: [
      { lead: 'Mockups, plans, your build.', rest: 'Ask for something visual and it appears on the canvas, versioned.' },
      { lead: 'Review needed, counted.', rest: 'The button turns amber with one number for every round owed.' },
      { lead: 'A note can offer choices.', rest: 'A/B/C chips — your click picks the winner, or name it in chat.' },
      { lead: 'Nothing is overwritten.', rest: 'History picks the artifact; a stepper walks its versions.' },
    ],
    where: { pre: 'Where: the ', em: 'Canvas', post: ' button in the session toolbar, beside Snap.' },
    art: 'canvas',
  },
  {
    id: 'oneRow',
    heading: 'One row runs the session',
    tagline: "Tools first, then your Global buttons, then this config's Session buttons — under every terminal, in a single row.",
    points: [
      { lead: 'It knows its session.', rest: 'A Codex session says Codex; on SSH, buttons say which computer runs them.' },
      { lead: 'Overflow folds', rest: 'into a per-band "N more" pill instead of wrapping under the terminal.' },
      { lead: 'Your buttons are reviewed, never changed.', rest: 'A clash carries a small amber mark until you look at it.' },
    ],
    where: { pre: 'Where: ', em: "under every session's terminal", post: '.' },
    art: 'oneRow',
  },
  {
    id: 'panel',
    heading: 'The left panel has two modes',
    tagline: 'Saved configs are the launcher; Running sessions are the work. Quick Start keeps your pinned configs one click away.',
    points: [
      { lead: 'Saved ⇄ Running.', rest: 'Two tabs, so launching and tending sessions stop sharing one crowded list.' },
      { lead: 'A config is a template.', rest: 'A running one shows a count pill and can Start another instance any time.' },
      { lead: 'Sized by you.', rest: 'Drag the panel edge; the width sticks. Double-click resets it.' },
    ],
    where: { pre: 'Where: the ', em: 'left panel', post: ' — the two tabs sit at its top.' },
    art: 'panel',
  },
  {
    id: 'accounts',
    heading: 'Every account, one app',
    tagline: 'Sign in to more than one Claude account and switch mid-session — usage, costs and insights follow each account separately.',
    points: [
      { lead: 'Switch without losing work.', rest: 'Change the account under a session; the conversation stays put.' },
      { lead: 'Usage at a glance.', rest: "The footer meters each account's window while you work." },
      { lead: 'Insights across accounts.', rest: 'Reports read every account at once, not one at a time.' },
    ],
    where: { pre: 'Where: the ', em: 'account strip', post: ' in the footer, and Insights in the sidebar.' },
    art: 'accounts',
  },
  {
    id: 'watchdog',
    heading: "The Watchdog waits so you don't have to",
    tagline: 'A rate limit used to end your evening. Now the session reads the banner, waits out the reset, and types the retry itself.',
    points: [
      { lead: 'Off by default.', rest: 'One switch in Settings turns it on.' },
      { lead: 'Careful hands.', rest: 'It never types over your draft or an open prompt.' },
      { lead: 'It watches the screen you see', rest: '— the rendered pane, not a stale log.' },
    ],
    where: { pre: 'Where: ', em: 'Settings → General → Session Watchdog', post: '.' },
    art: 'watchdog',
  },
]

/**
 * Which showcase pages a build shows. Same fallback rule as sectionsFor: a
 * line with no set of its own (2.2 before anyone authors one) gets the NEWEST
 * set, never nothing-with-a-heading; the 2.0 line predates the showcase and
 * gets none. Unlike sectionsFor this does not depend on where the user came
 * FROM — the showcase presents the current line's flagships, and stacking a
 * second line's pages behind them is exactly the wall the one-line summary
 * exists to avoid. (First-run users see the same pages via the fresh-install
 * step, #463 — the flagships ARE the app's introduction.)
 */
export function showcasesFor(currentVersion: string): ShowcasePage[] {
  return releaseLine(currentVersion) === '2.0' ? [] : SHOWCASES_21
}
