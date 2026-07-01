import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSettingsStore, DEFAULT_STATUS_LINE, type StatusLineSettings } from '../stores/settingsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'

const GEAR = String.fromCodePoint(0x2699)
const SPARK = String.fromCodePoint(0x2733)
const ELBOW = String.fromCodePoint(0x2514)
const DOT = String.fromCodePoint(0x25cf)

// Each switch drives a real settings.statusLine.* flag that the live
// SessionStatusStrip already reads, so every flip here is functional the
// moment it lands — the preview mirrors what a running session would show.
type SlToggle = Exclude<keyof StatusLineSettings, 'font' | 'fontSize'>

interface PreviewElem {
  k: SlToggle
  label: string
  node: (email: string) => ReactNode
}

// Sample values match the mockup; the account element shows the user's real
// signed-in email so the preview reads as THEIR status line, not a stock one.
const ELEMS: PreviewElem[] = [
  { k: 'showModel', label: 'Model', node: () => 'Opus 4.8' },
  { k: 'showEffort', label: 'Effort level', node: () => <span className="mut">xhigh</span> },
  {
    k: 'showAccount',
    label: 'Account',
    node: (email) => (
      <>
        <span className="d" />
        {email}
      </>
    ),
  },
  { k: 'showTokens', label: 'Token usage', node: () => <span className="num">84k / 200k</span> },
  {
    k: 'showContextBar',
    label: 'Context bar',
    node: () => (
      <>
        <span className="bar"><i style={{ width: '42%', background: 'var(--text-muted)' }} /></span>
        <span className="num">42%</span>
      </>
    ),
  },
  { k: 'showCost', label: 'Cost', node: () => <span className="num">API eq $0.1847</span> },
  {
    k: 'showLinesChanged',
    label: 'Lines changed',
    node: () => (
      <>
        <span className="add num">+127</span> <span className="rem num">-23</span>
      </>
    ),
  },
  { k: 'showDuration', label: 'Duration', node: () => <span className="mut num">3m 42s</span> },
  {
    k: 'showRateLimits',
    label: 'Rate limits',
    node: () => (
      <>
        <span className="mut">5h</span>
        <span className="bar"><i style={{ width: '35%', background: 'var(--status-success)' }} /></span>
        <span className="num">35%</span>
      </>
    ),
  },
  { k: 'showResetTime', label: 'Reset time', node: () => <span className="mut num">resets 3:45pm</span> },
  { k: 'showCopilot', label: 'Copilot meter', node: () => <span className="cop num">Copilot 8.1k/20k</span> },
]

export function StatusLineStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const sl = useSettingsStore((s) => s.settings.statusLine) || DEFAULT_STATUS_LINE
  const master = useSettingsStore((s) => s.settings.statusLineEnabled ?? true)
  // The Copilot meter element only exists in a real strip once the GitHub
  // AI-credits meter is enabled — previewing it before GitHub is introduced
  // in the flow would advertise an element the user won't get.
  const aiMeter = useSettingsStore((s) => !!s.settings.githubAiUsageEnabled)
  const elems = aiMeter ? ELEMS : ELEMS.filter((e) => e.k !== 'showCopilot')
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const [globalEmail, setGlobalEmail] = useState<string | null>(null)
  const elsRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [centers, setCenters] = useState<number[]>([])
  // At large fonts (mono/16) or with a long account email the 11 elements can
  // outgrow the strip; the scene clips overflow, which would strand the outer
  // switches. When measurement detects overflow the strip wrapper turns into a
  // horizontal scroller (switch columns are anchored inside the strip, so they
  // scroll with their elements and stay aligned).
  const [overflowing, setOverflowing] = useState(false)

  const email =
    profiles.find((p) => p.isPrimary)?.accountEmail || profiles[0]?.accountEmail || globalEmail || 'you@example.com'

  // Switch columns hover above the strip, each centred on the element it
  // controls (the mockup's signature). Centres are measured off the rendered
  // spans — offsetLeft is relative to .sl-strip, the positioned ancestor the
  // switch layer is anchored to. Off elements keep their slot (opacity only),
  // so toggling never shifts columns; only font/size/email changes re-measure.
  const measure = () => {
    const els = elsRef.current
    if (!els) return
    const spans = Array.from(els.querySelectorAll<HTMLElement>('[data-elx]'))
    setCenters(spans.map((el) => el.offsetLeft + el.offsetWidth / 2))
    const scroll = scrollRef.current
    if (scroll) setOverflowing(scroll.scrollWidth > scroll.clientWidth + 1)
  }
  useLayoutEffect(measure, [sl.font, sl.fontSize, email, aiMeter])
  useEffect(() => {
    void useAccountProfilesStore.getState().hydrate()
    void window.electronAPI.accountProfiles.globalEmail().then(setGlobalEmail).catch(() => {})
    // JetBrains Mono can finish loading after first paint and shift widths.
    void document.fonts.ready.then(() => measure())
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const patchSl = (patch: Partial<StatusLineSettings>) => {
    void useSettingsStore.getState().updateSettings({ statusLine: { ...sl, ...patch } })
  }
  const flip = (k: SlToggle) => {
    const patch: Partial<StatusLineSettings> = {}
    patch[k] = !sl[k]
    patchSl(patch)
  }
  const setMaster = (on: boolean) => {
    void useSettingsStore.getState().updateSettings({ statusLineEnabled: on })
  }

  return (
    <>
      <div className="sl-stage">
        <div className="sl-inner">
          <h2 className="h2" style={{ textAlign: 'center', marginBottom: 6 }}>
            Want a status line in your sessions?
          </h2>
          <p className="sl-sub">
            Command Center can show a live status line beneath every Claude session — usage, cost and limits at a
            glance. Flip the switches to build yours.
          </p>

          {/* inert makes Off real for keyboard/AT too — pointer-events:none in
              the CSS only blocks the mouse, but the dimmed switches would stay
              tabbable and still write settings. */}
          <div className={master ? 'sl-detail' : 'sl-detail off'} inert={!master}>
            <div className="sl-scene">
              <div className="sl-spot" />
              <div className="term">
                <div className="term-body">
                  <div className="mut">~/projects/myapp&nbsp;&nbsp;(main)</div>
                  <div className="u">&gt; refactor the login flow to use the new token helper</div>
                  <div className="c">{SPARK} I'll update the login flow.</div>
                  <div className="box">{ELBOW} Read src/auth/login.ts (142 lines)</div>
                  <div>
                    <span className="g">{DOT}</span> Done — <span className="u">login()</span> now uses{' '}
                    <span className="u">tokenHelper.refresh()</span>.
                  </div>
                </div>
              </div>
              <div className="sl-annot">
                <div className={overflowing ? 'sl-scroll scrolling' : 'sl-scroll'} ref={scrollRef}>
                <div className="sl-strip">
                  <div className="sl-switches">
                    {centers.length === elems.length &&
                      elems.map((e, i) => (
                        <div key={e.k} className={sl[e.k] ? 'swcol on' : 'swcol'} style={{ left: centers[i] }}>
                          <button
                            className="sw"
                            onClick={() => flip(e.k)}
                            type="button"
                            title={e.label}
                            aria-label={`${sl[e.k] ? 'Hide' : 'Show'} ${e.label.toLowerCase()}`}
                          />
                          <div className="ln" />
                        </div>
                      ))}
                  </div>
                  <div
                    className="sl-els"
                    ref={elsRef}
                    style={{
                      fontSize: `${sl.fontSize}px`,
                      fontFamily: sl.font === 'mono' ? "'JetBrains Mono', monospace" : undefined,
                    }}
                  >
                    {elems.map((e) => (
                      <span key={e.k} data-elx className={sl[e.k] ? 'elx' : 'elx off'}>
                        {e.node(email)}
                      </span>
                    ))}
                  </div>
                </div>
                </div>
              </div>
            </div>
            <div className="sl-cap">Each switch lines up with the part of the status line it controls.</div>
            <div className="sl-fontrow">
              <span>Font:</span>
              <button
                className={sl.font === 'sans' ? 'fbtn on' : 'fbtn'}
                onClick={() => patchSl({ font: 'sans' })}
                type="button"
              >
                Sans (Inter)
              </button>
              <button
                className={sl.font === 'mono' ? 'fbtn on' : 'fbtn'}
                onClick={() => patchSl({ font: 'mono' })}
                type="button"
              >
                Mono
              </button>
              <span style={{ marginLeft: 8 }}>Size:</span>
              <input
                type="range"
                min={10}
                max={16}
                value={sl.fontSize}
                onChange={(e) => patchSl({ fontSize: Number(e.target.value) })}
              />
              <span className="sl-mut">{sl.fontSize}px</span>
            </div>
            <div className="how" style={{ margin: '20px auto 0', maxWidth: 760 }}>
              <div className="how-ic">{GEAR}</div>
              <div>
                <b>How it works</b>
                <span>
                  Command Center adds one setting (<code>statusLine</code>) to each session it launches — it runs a
                  small local script that reads the session's tokens, cost and limits. Sessions launched anywhere else
                  and your global Claude config are untouched. Turn this off and new sessions launch without it.
                </span>
              </div>
            </div>
          </div>
          {!master && (
            <div className="sl-offnote">
              <div className="off-ic">{GEAR}</div>
              <div>
                <b>Status line is off.</b>
                <span>
                  Switch it on anytime in <b>Settings → Status line</b>.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="foot" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
        <button className="back" onClick={onBack} type="button" style={{ justifySelf: 'start' }}>
          ← Back
        </button>
        <div className="feat-onoff">
          <span className="oo-lbl">Status line</span>
          <button className={master ? 'oo-btn on' : 'oo-btn'} onClick={() => setMaster(true)} type="button">
            On
          </button>
          <button
            className={master ? 'oo-btn oo-off' : 'oo-btn oo-off on'}
            onClick={() => setMaster(false)}
            type="button"
          >
            Off
          </button>
        </div>
        <button className="cta" onClick={onNext} type="button" style={{ justifySelf: 'end', marginLeft: 0 }}>
          Next →
        </button>
      </div>
    </>
  )
}
