import { releaseLine } from '../utils/versionLabel'

/**
 * The What's New feature showcase (owner-approved design, 2026-08-24): after
 * the one-line summary page, each flagship feature of the release line gets a
 * full page of its own — heading, tagline, a few one-liner points, a "where to
 * find it" locator, and a drawn vignette (ShowcaseVignette).
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

export type ShowcaseArtKind = 'canvas' | 'watchdog' | 'oneRow'

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
    heading: 'The Agent Canvas grew a real review flow',
    tagline: "Claude renders the work in the app. You point at what's wrong; it fixes everything in one pass.",
    points: [
      { lead: 'Review needed, counted.', rest: 'The button turns amber with one number for every round owed.' },
      { lead: 'Drafts stay private.', rest: 'You only ever see versions the agent marks ready.' },
      { lead: 'A note can offer choices.', rest: 'A/B/C chips — your click picks the winner, or name it in chat.' },
      { lead: 'Nothing is overwritten.', rest: 'History picks the artifact; a stepper walks its versions.' },
    ],
    where: { pre: 'Where: the ', em: 'Canvas', post: ' button in the session toolbar, beside Snap.' },
    art: 'canvas',
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
  {
    id: 'oneRow',
    heading: 'Three rows became one',
    tagline: "Tools first, then your Global buttons, then this config's Session buttons. The bar knows what kind of session it's in.",
    points: [
      { lead: 'Nothing you had is changed without asking', rest: '— clashes carry a small amber mark until you look.' },
      { lead: 'Overflow folds', rest: 'into a per-band "N more" pill instead of wrapping.' },
      { lead: 'Two terminal lines come back', rest: 'to every session.' },
    ],
    where: { pre: 'Where: ', em: "under every session's terminal", post: '.' },
    art: 'oneRow',
  },
]

/**
 * Which showcase pages a build shows. Same fallback rule as sectionsFor: a
 * line with no set of its own (2.2 before anyone authors one) gets the NEWEST
 * set, never nothing-with-a-heading; the 2.0 line predates the showcase and
 * gets none. Unlike sectionsFor this does not depend on where the user came
 * FROM — the showcase presents the current line's flagships, and stacking a
 * second line's pages behind them is exactly the wall the one-line summary
 * exists to avoid.
 */
export function showcasesFor(currentVersion: string): ShowcasePage[] {
  return releaseLine(currentVersion) === '2.0' ? [] : SHOWCASES_21
}
