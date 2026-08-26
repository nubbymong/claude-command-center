import { useState } from 'react'
import { releaseLine } from '../utils/versionLabel'
import { compareVersions } from '../../shared/version-order'
import { useAppMetaStore } from '../stores/appMetaStore'
import { showcasesFor, ShowcasePage, ShowcasePoint } from './showcase-pages'
import { ShowcaseVignette, RenameVignette } from './ShowcaseVignette'

declare const __APP_VERSION__: string

// The release line this build belongs to ("2.1"), not a hard-coded number: the
// heading used to say "What's new in 2.0" on every 2.1 beta.
const LINE_SOURCE = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
const LINE = releaseLine(LINE_SOURCE)

export interface WhatsNewItem {
  /** Three or four words, ending in a full stop — it runs inline with `desc`. */
  title: string
  /** ONE line. If it needs two sentences, it belongs in the Feature Guide. */
  desc: string
  beta?: boolean
  /** #463: a line that only makes sense against a BEFORE (“the app was
   *  renamed”) — hidden from the fresh-install cohort, who have no before. */
  upgradeOnly?: boolean
  /** Id of a showcase page (showcase-pages.ts). Grows a "See it →" chip that
   *  jumps to that page; an id with no matching page renders no chip. */
  seeIt?: string
}

export interface WhatsNewSection {
  heading: string
  items: WhatsNewItem[]
}

// Upgrade-cohort opener (registry step 0, when(): lastSeenVersion exists).
// Curated highlights only — the flow's own pages do the actual setup, and the
// full history stays in the Feature Guide. Fresh installs skip this page
// entirely (nothing is "new" to them).
//
// SHAPE (user call 2026-08-21, replacing seven equal paragraph cards): named
// sections, one line per item. The card grid was rejected as "a horrible wall
// of text — people wont read that"; the fix is not smaller type but less of it,
// grouped so the eye can pick the part it cares about. If a line needs a second
// sentence to make sense, the line is wrong — link the Feature Guide instead.
//
// WHICH set a user sees depends on where they came from; see sectionsFor.
const SECTIONS_20: WhatsNewSection[] = [
  {
    heading: 'Setup & privacy',
    items: [
      { title: 'Guided setup.', desc: 'Every feature asks before it turns on, and stays yours to change in Settings.' },
      { title: 'A privacy pass.', desc: 'The status line and built-in tools are delivered per session; your global Claude config is never written.' },
    ],
  },
  {
    heading: 'Tools',
    items: [
      { title: 'Built-in tools, your call.', desc: 'Vision, code review, host screenshots and the Agent Canvas each get a real switch.' },
      { title: 'Codex support.', desc: "Run OpenAI's Codex CLI beside Claude, with its own switch and sign-in.", beta: true },
    ],
  },
  {
    heading: 'Help',
    items: [
      { title: 'A guide that answers back.', desc: 'The ? button opens a searchable guide, and a session that has read the docs.' },
    ],
  },
  {
    heading: 'Under the hood',
    items: [
      { title: 'A modern engine.', desc: 'Electron 43, React 19 and xterm.js 6 — fast, on a current security baseline.' },
    ],
  },
]

const SECTIONS_21: WhatsNewSection[] = [
  {
    heading: 'Sessions',
    items: [
      { title: 'Detachable SSH.', desc: 'Runs under tmux, so the work survives a dropped VPN.' },
      { title: 'Partner terminal.', desc: 'A plain shell beside Claude, labelled so you always know which is which.' },
      { title: 'One row.', desc: 'The tools and your command buttons sit in a single row under the terminal.', seeIt: 'oneRow' },
      { title: 'Two-mode panel.', desc: 'Saved configs and Running sessions each get a tab, with Quick Start pins — and the panel resizes.', seeIt: 'panel' },
    ],
  },
  {
    heading: 'Working with Claude',
    items: [
      { title: 'Agent Canvas.', desc: "Claude draws a mockup in the app. Mark up what's wrong; it picks the notes up.", seeIt: 'canvas' },
      { title: 'Session Watchdog.', desc: 'Waits out a rate limit and types the retry itself. Off by default.', seeIt: 'watchdog' },
      { title: 'Ask Conductor.', desc: 'A session that has read the docs. Docked at the bottom of the sidebar.' },
    ],
  },
  {
    heading: 'Accounts & usage',
    items: [
      { title: 'Switch mid-session.', desc: 'Sign in to claude.ai in-app, change account without losing the session.', seeIt: 'accounts' },
      { title: 'Insights.', desc: 'Usage reports across every account at once, not one at a time.' },
    ],
  },
  {
    heading: 'The app itself',
    items: [
      { title: 'New name.', desc: 'Claude Command Center is now AI Code Conductor. Same data, same settings.', upgradeOnly: true },
      { title: 'Signed and notarised.', desc: 'Windows signed, macOS notarised, every update SHA-256 checked.' },
    ],
  },
]

/**
 * Which highlights to show, based on the line the user is arriving FROM.
 *
 * Someone moving 2.0 → 2.1 wants the 2.1 story; they already lived through 2.0.
 * Someone arriving from 1.x — or from a version we cannot read — has missed
 * both, and gets both, oldest first, because that is the order the app changed
 * in. Fresh installs never reach this page at all.
 */
export function sectionsFor(lastSeenVersion: string | undefined, currentVersion: string): WhatsNewSection[] {
  const line = releaseLine(currentVersion)
  // A line with no set of its own — 2.2 before anyone writes one — falls back to
  // the NEWEST set, not the oldest: greeting a 2.2 user with 2.0 content under a
  // "What's new in 2.2" heading is the exact bug this page already had once.
  // When a 2.2 set is written, add it here.
  if (line === '2.0') return SECTIONS_20
  const from = releaseLine(lastSeenVersion ?? '')
  return from === '2.0' || from === '2.1' ? SECTIONS_21 : [...SECTIONS_20, ...SECTIONS_21]
}

/**
 * The rename prelude (#525): one page, ahead of the summary, ONLY for people
 * arriving from a build that predates the rename — they knew the app as
 * Claude Command Center and are owed the why. `RENAME_SHIPPED_IN` is the
 * release whose changelog entry announced it; anyone whose last-seen version
 * is that or later has lived under the new name for their whole tenure, and
 * re-showing the page on every update would wear it out.
 *
 * The why the page leads with is the real one: 2.2 is widening the app from
 * conducting one CLI to conducting many, and the old name had no room for
 * that. Fresh installs never see it — they never knew the old name.
 */
export const RENAME_SHIPPED_IN = '2.1.0-beta.6'

export function showRenamePageFor(lastSeenVersion: string | undefined, currentVersion: string): boolean {
  if (!lastSeenVersion) return false // a fresh install has no before
  if (releaseLine(currentVersion) === '2.0') return false // the 2.0 line predates the rename
  return compareVersions(lastSeenVersion, RENAME_SHIPPED_IN) < 0
}

const RENAME_POINTS: ShowcasePoint[] = [
  {
    lead: 'Nothing to redo.',
    rest: 'Your sessions, saved configs, accounts, history and settings are exactly where you left them — the update installs over the top.',
  },
  {
    lead: 'The name grew because the app is growing.',
    rest: 'Version 2.2 is already in the works, and its whole point is conducting more than one coding agent.',
  },
  {
    lead: 'On the 2.2 roadmap:',
    rest: 'GitHub Copilot CLI, Google Antigravity, Qwen Code and OpenCode join Claude Code and Codex — with local models through Ollama.',
  },
]

function RenamePageView() {
  return (
    <div className="p2">
      <div className="p2-inner sc-page" style={{ width: 'min(1000px, 95vw)' }} data-ux-id="rename-page">
        <div className="sc-copy">
          <div className="sc-eyebrow" data-ux-id="rename-eyebrow">Before the new features</div>
          <h2 className="sc-h" data-ux-id="rename-heading">Claude Command Center is now AI Code Conductor</h2>
          <p className="sc-tagline" data-ux-id="rename-tagline">
            Same app, same home. The new name makes room for where it&apos;s going: one conductor&apos;s stand for every coding agent you run.
          </p>
          <div className="sc-points" data-ux-id="rename-points">
            {RENAME_POINTS.map((pt) => (
              <div className="sc-pt" key={pt.lead}>
                <span className="wn-dot sc-dot" />
                <div><b>{pt.lead}</b> {pt.rest}</div>
              </div>
            ))}
          </div>
          <p className="sc-where" data-ux-id="rename-where">
            Plans can shift, but the direction won&apos;t — each agent lands in <b>What&apos;s New</b> as it arrives.
          </p>
        </div>
        <div className="sc-art" data-ux-id="rename-art">
          <RenameVignette />
        </div>
      </div>
    </div>
  )
}

function ShowcasePageView({ page, index, ofShowcases }: { page: ShowcasePage; index: number; ofShowcases: number }) {
  return (
    <div className="p2">
      <div className="p2-inner sc-page" style={{ width: 'min(1000px, 95vw)' }} data-ux-id={`showcase-page-${page.id}`}>
        <div className="sc-copy">
          {/* Counts SHOWCASES (1 of 3), not run pages — the footer's "Page 2 of
              4" includes the summary. Named apart so the two denominators are
              never confused for each other. */}
          <div className="sc-eyebrow" data-ux-id="showcase-eyebrow">Feature showcase · {index} of {ofShowcases}</div>
          <h2 className="sc-h" data-ux-id="showcase-heading">{page.heading}</h2>
          <p className="sc-tagline" data-ux-id="showcase-tagline">{page.tagline}</p>
          <div className="sc-points" data-ux-id="showcase-points">
            {page.points.map((pt) => (
              <div className="sc-pt" key={pt.lead}>
                <span className="wn-dot sc-dot" />
                <div><b>{pt.lead}</b> {pt.rest}</div>
              </div>
            ))}
          </div>
          <p className="sc-where" data-ux-id="showcase-where">
            {page.where.pre}<b>{page.where.em}</b>{page.where.post}
          </p>
        </div>
        <div className="sc-art" data-ux-id="showcase-art">
          <ShowcaseVignette kind={page.art} />
        </div>
      </div>
    </div>
  )
}

export function WhatsNewV2Step({
  onNext,
  ctaLabel = 'Set it up →',
  hint = 'The next pages set these up, one at a time.',
  fresh = false,
}: {
  onNext: () => void
  /** Footer CTA. The harness passes "Continue" when this page ends the run —
   *  on an ordinary upgrade there is usually nothing left to set up. */
  ctaLabel?: string
  hint?: string
  /** #463: first-run cohort — nothing is "new" to them, so the heading
   *  introduces the app instead of diffing it. sectionsFor already returns
   *  the full 2.0+2.1 story when there is no lastSeenVersion. */
  fresh?: boolean
}) {
  const lastSeen = useAppMetaStore.getState().meta.lastSeenVersion
  const sections = sectionsFor(lastSeen, LINE_SOURCE)
    .map((s) => (fresh ? { ...s, items: s.items.filter((it) => !it.upgradeOnly) } : s))
    .filter((s) => s.items.length > 0)
  const count = sections.reduce((n, s) => n + s.items.length, 0)
  // The showcase (owner design 2026-08-24): the summary is page 0; each
  // flagship feature of the line gets a full page behind it. With no pages
  // authored for a line this collapses to exactly the old single-page step —
  // no dots, no skip, the harness CTA — so nothing regresses.
  const showcases = showcasesFor(LINE_SOURCE)
  // #525: pre-rename upgraders get the rename page FIRST; everyone else's
  // paging is untouched (prelude 0 keeps every index exactly what it was).
  const prelude = !fresh && showRenamePageFor(lastSeen, LINE_SOURCE) ? 1 : 0
  const summaryIx = prelude
  const [pageIx, setPageIx] = useState(0)
  const total = prelude + 1 + showcases.length
  const isLast = pageIx === total - 1
  const jumpTo = (id: string) => {
    const ix = showcases.findIndex((p) => p.id === id)
    if (ix >= 0) setPageIx(summaryIx + 1 + ix)
  }
  return (
    <>
      {prelude === 1 && pageIx === 0 ? (
        <RenamePageView />
      ) : pageIx === summaryIx ? (
        <div className="p2">
          <div className="p2-inner" style={{ width: 'min(920px, 95vw)' }}>
            <h2 className="h2" data-ux-id="whatsnew-heading">{fresh ? <>What you&apos;re getting</> : <>What&apos;s new in {LINE}</>}</h2>
            <p className="p2-sub" data-ux-id="whatsnew-sub">
              {count} things worth knowing, in one line each{showcases.length > 0 ? ` — and ${showcases.length} of them have a page of their own, just behind this one` : ''}.
            </p>

            <div className="wn-sections" data-ux-id="whatsnew-sections">
              {sections.map((s) => (
                <section key={s.heading} data-ux-id={`section-${s.heading.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
                  <h3 className="wn-sec-h">{s.heading}</h3>
                  {s.items.map((it) => (
                    <div className="wn-item" key={it.title}>
                      <span className="wn-dot" />
                      <div>
                        <span className="wn-t">{it.title}</span>{' '}
                        <span className="wn-d">{it.desc}</span>
                        {it.beta && <span className="gh-tag">Beta</span>}
                        {it.seeIt && showcases.some((p) => p.id === it.seeIt) && (
                          <button
                            type="button"
                            className="wn-see"
                            onClick={() => jumpTo(it.seeIt!)}
                            data-ux-id={`see-${it.seeIt}`}
                          >
                            See it &rarr;
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>

            <p className="gh-freebie" data-ux-id="whatsnew-pointer">
              The detail for any of these lives in <b>Feature Guide &rarr; What&apos;s New</b>, any time.
            </p>
          </div>
        </div>
      ) : (
        <ShowcasePageView page={showcases[pageIx - summaryIx - 1]} index={pageIx - summaryIx} ofShowcases={showcases.length} />
      )}
      <div className="foot">
        <span className="hint" data-ux-id="whatsnew-hint">
          {/* Only the last page may promise what comes next — that is the
              harness-supplied `hint`, which knows whether anything follows.
              Earlier pages say only where you are: a hard-coded "the tour
              continues" is a lie on the common notes-only upgrade, the exact
              bug the hint plumbing exists to prevent (see OnboardingHarness). */}
          {isLast ? hint : `Page ${pageIx + 1} of ${total}.`}
        </span>
        {total > 1 && (
          <div className="wn-foot-dots" data-ux-id="whatsnew-dots" role="group" aria-label="Showcase pages">
            {prelude === 1 && (
              <button type="button" className={`wn-fdot${pageIx === 0 ? ' on' : ''}`} onClick={() => setPageIx(0)} aria-label="The new name" aria-current={pageIx === 0 ? 'page' : undefined} data-ux-id="whatsnew-dot-rename"><i /></button>
            )}
            <button type="button" className={`wn-fdot${pageIx === summaryIx ? ' on' : ''}`} onClick={() => setPageIx(summaryIx)} aria-label="Summary" aria-current={pageIx === summaryIx ? 'page' : undefined} data-ux-id="whatsnew-dot-summary"><i /></button>
            {showcases.map((p, ix) => (
              <button type="button" key={p.id} className={`wn-fdot${pageIx === summaryIx + 1 + ix ? ' on' : ''}`} onClick={() => setPageIx(summaryIx + 1 + ix)} aria-label={p.heading} aria-current={pageIx === summaryIx + 1 + ix ? 'page' : undefined} data-ux-id={`whatsnew-dot-${p.id}`}><i /></button>
            ))}
          </div>
        )}
        {!isLast && (
          <button type="button" className="skip wn-skip" onClick={onNext} data-ux-id="whatsnew-skip">
            Skip the showcase
          </button>
        )}
        <button
          className="cta"
          onClick={() => (isLast ? onNext() : setPageIx(pageIx + 1))}
          type="button"
          data-ux-id="whatsnew-cta"
        >
          {isLast ? ctaLabel : 'Next →'}
        </button>
      </div>
    </>
  )
}
