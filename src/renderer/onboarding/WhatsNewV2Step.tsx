import { releaseLine } from '../utils/versionLabel'
import { useAppMetaStore } from '../stores/appMetaStore'

declare const __APP_VERSION__: string

// The release line this build belongs to ("2.1"), not a hard-coded number: the
// heading used to say "What's new in 2.0" on every 2.1 beta.
const LINE_SOURCE = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
const LINE = releaseLine(LINE_SOURCE)

const SPARKLES = String.fromCodePoint(0x2728)
const LOCK = String.fromCodePoint(0x1f512)
const GEAR = String.fromCodePoint(0x2699)
const MAG = String.fromCodePoint(0x1f50d)
const BOLT = String.fromCodePoint(0x26a1)
const ROCKET = String.fromCodePoint(0x1f680)
const BADGE = String.fromCodePoint(0x1f3f7)
const PLUG = String.fromCodePoint(0x1f50c)
const PALETTE = String.fromCodePoint(0x1f3a8)
const PEOPLE = String.fromCodePoint(0x1f465)
const CHART = String.fromCodePoint(0x1f4c8)
const SHIELD = String.fromCodePoint(0x1f6e1)

interface Card {
  icon: string
  title: string
  desc: string
  beta?: boolean
}

// Upgrade-cohort opener (registry step 0, when(): lastSeenVersion exists).
// Curated highlights only — the flow's own pages do the actual setup, and the
// full changelog stays reachable in Settings → About. Fresh installs skip this
// page entirely (nothing is "new" to them).
//
// WHICH set a user sees depends on where they came from; see cardsFor. The
// heading has been derived from the build since the day it greeted 2.1 testers
// with "What's new in 2.0" — but the cards under it stayed 2.0 content, so the
// page announced 2.1 and then described the release before it.
const CARDS_20: Card[] = [
  {
    icon: SPARKLES,
    title: 'This guided setup',
    desc: 'Every feature now asks before it turns on. What you pick here is yours, and yours to change later in Settings.',
  },
  {
    icon: LOCK,
    title: 'A privacy pass',
    desc: 'The status line and built-in tools are delivered per session. Your global Claude config is never written, and old global entries are cleaned up.',
  },
  {
    icon: GEAR,
    title: 'Built-in tools, your call',
    desc: 'Vision, code review, host screenshots and the Agent Canvas each get a real switch, enforced for local, SSH and Codex sessions.',
  },
  {
    icon: ROCKET,
    title: 'Codex support',
    beta: true,
    desc: "Run OpenAI's Codex CLI beside Claude, with its own master switch and sign-in.",
  },
  {
    icon: MAG,
    title: 'A guide that answers back',
    desc: 'The ? button opens a searchable guide of every feature, and a Claude session that has read the app documentation.',
  },
  {
    icon: BOLT,
    title: 'A newer engine',
    desc: 'Electron 43, React 19 and xterm.js 6 under the hood: a faster renderer on a current security baseline.',
  },
]

const CARDS_21: Card[] = [
  {
    icon: BADGE,
    title: 'A new name',
    desc: 'Claude Command Center is now AI Code Conductor. Same app, same data, same settings — updates carry across on their own.',
  },
  {
    icon: PLUG,
    title: 'Remote sessions that survive the link',
    desc: 'Mark an SSH config Detachable and it runs under tmux, so a dropped VPN or a closed lid no longer kills the work. Reconnecting puts you back where you were.',
  },
  {
    icon: PALETTE,
    title: 'The Agent Canvas',
    desc: 'Claude renders a mockup, or your real built site, into the app. Mark it up where it is wrong and it picks the notes up anchored to the elements you pointed at.',
  },
  {
    icon: PEOPLE,
    title: 'Accounts, properly',
    desc: 'Sign in to claude.ai inside the app, switch account mid-session without losing it, and park the ones you are not using.',
  },
  {
    icon: CHART,
    title: 'Insights across every account',
    desc: 'Reports over your own usage that run across all of your accounts at once, rather than one at a time.',
  },
  {
    icon: SHIELD,
    title: 'Signed, notarised, verified',
    desc: 'Windows installers are code-signed and macOS builds are notarised, and the updater checks the SHA-256 of everything it installs.',
  },
  {
    icon: MAG,
    title: 'Ask Conductor, in its own place',
    desc: 'Ask about the app, or about Claude Code, and get an answer instead of a search. It docks at the bottom of the sidebar, opens as a real session you can come back to, and no longer leaves a config behind in your sidebar.',
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
export function cardsFor(lastSeenVersion: string | undefined, currentVersion: string): Card[] {
  const line = releaseLine(currentVersion)
  // A line with no card set of its own — 2.2 before anyone writes one — falls
  // back to the NEWEST set, not the oldest: greeting a 2.2 user with 2.0
  // content under a "What's new in 2.2" heading is the exact bug this page
  // already had once. When a 2.2 set is written, add it here.
  if (line === '2.0') return CARDS_20
  const from = releaseLine(lastSeenVersion ?? '')
  return from === '2.0' || from === '2.1' ? CARDS_21 : [...CARDS_20, ...CARDS_21]
}

export function WhatsNewV2Step({
  onNext,
  ctaLabel = 'Set it up →',
  hint = 'The next pages set these up, one at a time.',
}: {
  onNext: () => void
  /** Footer CTA. The harness passes "Continue" when this page ends the run —
   *  on an ordinary upgrade there is usually nothing left to set up. */
  ctaLabel?: string
  hint?: string
}) {
  const cards = cardsFor(useAppMetaStore.getState().meta.lastSeenVersion, LINE_SOURCE)
  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(880px, 95vw)' }}>
          <h2 className="h2">What's new in {LINE}</h2>
          <p className="p2-sub">
            AI Code Conductor {LINE} is a big release. The short version, before we set it up together:
          </p>

          <div className="gh-grid">
            {cards.map((c) => (
              <div className="gh-card" key={c.title}>
                <div className="gh-ic">{c.icon}</div>
                <div>
                  <div className="gh-t">
                    {c.title}
                    {c.beta && <span className="gh-tag">Beta</span>}
                  </div>
                  <div className="gh-d">{c.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <p className="gh-freebie">
            The full changelog is always in <b>Settings → About</b>.
          </p>
        </div>
      </div>
      <div className="foot">
        <span className="hint">{hint}</span>
        <button className="cta" onClick={onNext} type="button">
          {ctaLabel}
        </button>
      </div>
    </>
  )
}
