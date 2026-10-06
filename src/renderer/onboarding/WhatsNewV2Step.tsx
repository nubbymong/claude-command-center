import { useState } from 'react'
import { releaseLine } from '../utils/versionLabel'
import { compareVersions, isPrerelease } from '../../shared/version-order'
import { useAppMetaStore } from '../stores/appMetaStore'
import { useSettingsStore } from '../stores/settingsStore'
import { showcasesFor, ShowcasePage } from './showcase-pages'
import { ShowcaseVignette } from './ShowcaseVignette'
import { RenamePageView } from './RenamePage'
import { usesClaude, usesCodex, claudeWasMissingAtSetup } from './provider-choice'

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
  /** #463: a line that only makes sense against a BEFORE (“the app was
   *  renamed”) — hidden from the fresh-install cohort, who have no before. */
  upgradeOnly?: boolean
  /** Id of a showcase page (showcase-pages.ts). Grows a "See it →" chip that
   *  jumps to that page; an id with no matching page renders no chip. */
  seeIt?: string
  /** P3.4 (row 14): the line is about something that needs Claude Code in
   *  this release, so it is hidden while Claude Code is off (as upgradeOnly
   *  hides a line from a fresh install). The phase that brings the feature
   *  to Codex lifts it (named in that phase's entry of
   *  docs/wp2/completion-plan.md: Agent Canvas P4.1, Ask Conductor and the
   *  guide line P4.3; P4.7 lifted it from Insights; P3.6 lifted it from Switch mid-session,
   *  P3.10 from Session Watchdog). SSH Persistent and Remote Resumable keep it, as the
   *  remote resume page does: the persistent remote session wraps the
   *  remote claude command, and the only agent an SSH session runs in
   *  this release is Claude Code. */
  needsClaude?: boolean
}

export interface WhatsNewSection {
  heading: string
  /** P3.10: the heading while Claude Code is off, for a section that names
   *  Claude and keeps a line that works with Codex (the Watchdog's). */
  headingWithoutClaude?: string
  /** P4.11 (INT-7): the heading while Claude Code and Codex are both on, for
   *  a section whose lines now work for both. */
  headingWithCodex?: string
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
      { title: 'Built-in Tools, your call.', desc: 'Vision, code review, host screenshots and the Agent Canvas each get a real switch.' },
      { title: 'Codex support.', desc: "Run OpenAI's Codex CLI beside Claude, with its own switch and sign-in." },
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
      { title: 'A modern engine.', desc: 'Electron 44, React 19 and xterm.js 6 — fast, on a current security baseline.' },
    ],
  },
]

const SECTIONS_21: WhatsNewSection[] = [
  {
    heading: 'Sessions',
    items: [
      { title: 'SSH Persistent.', desc: 'A connection kind of its own — the remote session survives a dropped VPN.', needsClaude: true },
      { title: 'Partner terminal.', desc: 'A plain shell beside your session, labelled so you always know which is which.' },
      { title: 'One row.', desc: 'The tools and your command buttons sit in a single row under the terminal.', seeIt: 'oneRow' },
      { title: 'Two-mode panel.', desc: 'Saved configs and Running sessions each get a tab, with Quick Start pins — and the panel resizes.', seeIt: 'panel' },
      { title: 'Multi Spawn.', desc: 'Mark a config to run several copies at once; everything else is safe from a stray double launch.', seeIt: 'multiSpawn' },
      { title: 'Remote Resumable.', desc: 'A persistent SSH session you left running waits at the foot of Running, one click from where you were.', seeIt: 'remoteResume', needsClaude: true },
      { title: 'Marks you can read.', desc: 'Plain SSH, persistent and container sessions each wear their own mark, everywhere they appear.', seeIt: 'sidebarMarks' },
    ],
  },
  {
    heading: 'Working with Claude',
    headingWithoutClaude: 'Working with Codex',
    headingWithCodex: 'Working with Claude and Codex',
    items: [
      // WP2 PR 4, P4.1 (row 51): the canvas works in Codex sessions too.
      { title: 'Agent Canvas.', desc: "Your agent draws a mockup in the app. Mark up what's wrong; it picks the notes up.", seeIt: 'canvas' },
      { title: 'Session Watchdog.', desc: 'Waits out a rate limit and types the retry itself. Off by default.', seeIt: 'watchdog' },
      { title: 'Ask Conductor.', desc: 'A session that has read the docs — and can install a helper skill for the rest.', seeIt: 'askConductor' },
    ],
  },
  {
    heading: 'Accounts & usage',
    items: [
      // P3.6 (row 22): a Codex account switches mid-session too, keeping the
      // conversation; the claude.ai sign-in the line also named stays Claude's.
      { title: 'Switch mid-session.', desc: 'Change a running session\'s account without losing the conversation.', seeIt: 'accounts' },
      { title: 'claude.ai in the app.', desc: 'Sign in to claude.ai in-app, for each account.', needsClaude: true },
      { title: 'Insights.', desc: 'Usage reports across every account at once, not one at a time.' },
    ],
  },
  {
    heading: 'The app itself',
    items: [
      { title: 'New name.', desc: 'Claude Command Center is now AI Code Conductor — nothing else changes.', upgradeOnly: true },
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
 * The rename/roadmap prelude (#525): one page ahead of the summary. Upgraders
 * arriving from a build that predates the rename open on it — they knew the
 * app as Claude Command Center and are owed the why. `RENAME_SHIPPED_IN` is
 * the release whose changelog entry announced the rename; an upgrader whose
 * last-seen version is that or later has lived under the new name for their
 * whole tenure, and re-showing the page on every update would wear it out.
 * Fresh installs see the same page under a "Welcome to" lead-in (owner call,
 * canvas R1: the roadmap is the app's own introduction) — their gate is the
 * `fresh` flag, not this function.
 */
export const RENAME_SHIPPED_IN = '2.1.0-beta.6'

export function showRenamePageFor(
  lastSeenVersion: string | undefined,
  currentVersion: string,
  opts?: {
    /** The update channel in force ('beta' | 'stable'). See the tester arm below. */
    channel?: string
  },
): boolean {
  if (!lastSeenVersion) return false // fresh installs are gated by `fresh`, not by version
  if (releaseLine(currentVersion) === '2.0') return false // the 2.0 line predates the rename
  // Tester arm (owner call, canvas R2 2026-08-27): on the beta channel every
  // PRERELEASE build shows the full What's New content, cohort pages included —
  // "until we hit stable I should be seeing everything". Scoped to prerelease
  // builds on purpose: the moment a final release is running, testers rejoin
  // the ordinary cohort gate below and the page stops re-showing.
  if (opts?.channel === 'beta' && isPrerelease(currentVersion)) return true
  return compareVersions(lastSeenVersion, RENAME_SHIPPED_IN) < 0
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
          {page.mark ? (
            <div className="sc-hgroup">
              <img src={page.mark} alt="" aria-hidden className="sc-mark" draggable={false} />
              <h2 className="sc-h" data-ux-id="showcase-heading">{page.heading}</h2>
            </div>
          ) : (
            <h2 className="sc-h" data-ux-id="showcase-heading">{page.heading}</h2>
          )}
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
  // Subscribed, not getState() (quality note): a stamp landing while the
  // step is mounted must re-derive the prelude instead of stranding pageIx.
  const lastSeen = useAppMetaStore((s) => s.meta.lastSeenVersion)
  const channel = useSettingsStore((s) => s.settings.updateChannel)
  // P3.4 (row 14): with Claude Code off (or setup found no Claude Code and
  // the run goes on with Codex only, as the Welcome page reads it) a line or
  // page about something that needs Claude Code is not shown.
  const withClaude = useSettingsStore((s) => usesClaude(s.settings)) && !claudeWasMissingAtSetup()
  const withCodex = useSettingsStore((s) => usesCodex(s.settings))
  const headingFor = (s: WhatsNewSection): string =>
    !withClaude ? s.headingWithoutClaude ?? s.heading : withCodex ? s.headingWithCodex ?? s.heading : s.heading
  const sections = sectionsFor(lastSeen, LINE_SOURCE)
    .map((s) => ({ ...s, heading: headingFor(s), items: s.items.filter((it) => !(fresh && it.upgradeOnly) && (withClaude || !it.needsClaude)) }))
    .filter((s) => s.items.length > 0)
  const count = sections.reduce((n, s) => n + s.items.length, 0)
  // The showcase (owner design 2026-08-24): the summary is page 0; each
  // flagship feature of the line gets a full page behind it. With no pages
  // authored for a line this collapses to exactly the old single-page step —
  // no dots, no skip, the harness CTA — so nothing regresses.
  // P3.6: a page that shows with Claude Code off leaves out its points that
  // need it. No point needs it in this release: P4.7 lifted the last one,
  // the accounts page's Insights point, as Insights runs for Codex too.
  const showcases = showcasesFor(LINE_SOURCE)
    .filter((p) => withClaude || !p.needsClaude)
    .map((p) => (withClaude ? p : { ...p, points: p.points.filter((pt) => !pt.needsClaude) }))
  // #525: pre-rename upgraders AND fresh installs (owner call, canvas R1)
  // open on the rename/roadmap page — and beta-channel testers on any
  // prerelease build (owner call, canvas R2). Post-rename STABLE upgraders'
  // paging is untouched (prelude 0 keeps every index exactly what it was).
  // The 2.0 line predates both the rename and the roadmap, so it never shows it.
  const prelude =
    releaseLine(LINE_SOURCE) !== '2.0' && (fresh || showRenamePageFor(lastSeen, LINE_SOURCE, { channel })) ? 1 : 0
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
        <RenamePageView fresh={fresh} />
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
