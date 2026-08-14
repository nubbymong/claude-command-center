import { releaseLine } from '../utils/versionLabel'

declare const __APP_VERSION__: string

// The release line this build belongs to ("2.1"), not a hard-coded number: the
// heading used to say "What's new in 2.0" on every 2.1 beta.
const LINE = releaseLine(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '')

const SPARKLES = String.fromCodePoint(0x2728)
const LOCK = String.fromCodePoint(0x1f512)
const GEAR = String.fromCodePoint(0x2699)
const MAG = String.fromCodePoint(0x1f50d)
const BOLT = String.fromCodePoint(0x26a1)
const ROCKET = String.fromCodePoint(0x1f680)

// Upgrade-cohort opener (registry step 0, when(): lastSeenVersion exists).
// Curated 2.0 highlights only — the flow's own pages do the actual setup, and
// the full changelog stays reachable in Settings → About. Fresh installs skip
// this page entirely (nothing is "new" to them).
const CARDS: { icon: string; title: string; desc: string; beta?: boolean }[] = [
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
    desc: 'Vision, code review and host screenshots each get a real switch, enforced for local, SSH and Codex sessions.',
  },
  {
    icon: ROCKET,
    title: 'Codex support',
    beta: true,
    desc: "Run OpenAI's Codex CLI beside Claude, with its own master switch and sign-in.",
  },
  {
    icon: MAG,
    title: 'Ask Conductor',
    desc: 'The ? button in the sidebar opens a searchable guide, or a Claude session that knows the app.',
  },
  {
    icon: BOLT,
    title: 'A newer engine',
    desc: 'Electron 43, React 19 and xterm.js 6 under the hood: a faster renderer on a current security baseline.',
  },
]

export function WhatsNewV2Step({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(880px, 95vw)' }}>
          <h2 className="h2">What's new in {LINE}</h2>
          <p className="p2-sub">
            AI Code Conductor {LINE} is a big release. The short version, before we set it up together:
          </p>

          <div className="gh-grid">
            {CARDS.map((c) => (
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
        <span className="hint">The next pages set these up, one at a time.</span>
        <button className="cta" onClick={onNext} type="button">
          Set it up →
        </button>
      </div>
    </>
  )
}
