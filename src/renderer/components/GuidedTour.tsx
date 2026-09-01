import { useEffect, useLayoutEffect, useState } from 'react'

// Anchored coach-mark tour over the LIVE app (not a modal wizard). Each step
// spotlights a real element by a data-tour selector and floats a callout beside
// it; the final step hands off to first-config creation. Dependency-free:
// getBoundingClientRect + a light rAF re-measure so the spotlight tracks layout.

interface TourStep {
  selector: string | null // null => centered welcome/handoff card
  title: string
  body: string
  cta?: string // overrides "Next" on this step
}

const STEPS: TourStep[] = [
  {
    selector: null,
    title: 'This is your workbench',
    body: 'AI Code Conductor runs your Claude (and Codex) sessions side by side. A quick look at where things live, then we’ll start your first session.',
  },
  {
    selector: '[data-tour="nav-rail"]',
    title: 'Everything has a home',
    body: 'Cloud Agents, Insights, Tokenomics, Memory, Logs and the built-in tools (Conductor MCP) all live on this rail. Each opens a full page.',
  },
  {
    // Anchored on the always-mounted Saved TAB, not the "+ New" button
    // inside it: the panel defaults to the Running tab, so a selector into the
    // Saved body would be unresolvable at tour time and available() would
    // silently skip the step that explains the app's core concept.
    selector: '[data-tour="new-config"]',
    title: 'Saved configs live here',
    body: 'The left panel has two modes — Saved is your launcher, Running is your live sessions. A saved config is a reusable launcher: project folder, model, account. Open the Saved tab, press "+ New" and pick Config to create one, then start a session from it whenever you want (Claude or Codex, running here or on another machine over SSH — plain, or persistent so a dropped link does not kill it).',
  },
  {
    // The Agent Canvas had no step at all, which made the app's second-largest
    // surface invisible to a new user. Its button lives in a session's command
    // bar, so on a first run (no session yet) the anchor is unmounted and
    // available() skips this step -- the same graceful degradation every
    // anchored step relies on. It earns its place the moment a session exists.
    selector: '[data-tour="canvas-button"]',
    title: 'Review what your agent builds',
    body: 'Every session has a Canvas button beside Snap. Your agent renders a mockup, a plan, or the site it just built, and you review it by pointing: click an element to leave a note, draw over it, then decide — approve that version, or send it back for another round. Testing mode goes further — click through a running build and every note saves the screen, the page state and how you got there. A small dot on the button means there is unfinished canvas work anyone here can pick up.',
  },
  {
    // Anchored on data-tour, not aria-label: the nav button's label is dynamic
    // (collapsed state, logs-disabled, running jobs), so an aria-label selector
    // silently missed and the tour skipped this step with no visible error.
    selector: '[data-tour="nav-settings"]',
    title: 'Change anything, anytime',
    body: 'Everything you just set up (accounts, GitHub, status line, tools, Codex) lives in Settings.',
  },
  {
    selector: '[data-tour="help-button"]',
    title: 'Help lives here',
    body: 'The Feature Guide explains every feature in depth whenever you want it, and can hand your question to a Claude session that knows the app.',
  },
  {
    selector: null,
    title: 'Ready to go',
    body: 'Let’s create your first saved config: pick a name, model and account. Saving it launches your first session, and the config stays in the sidebar so you can come back to it anytime.',
    cta: 'Create your first config',
  },
]

const PAD = 8
const CARD_W = 340

function useAnchorRect(selector: string | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    if (!selector) {
      setRect(null)
      return
    }
    let raf = 0
    const measure = () => {
      const el = document.querySelector(selector)
      setRect(el ? el.getBoundingClientRect() : null)
      raf = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(raf)
  }, [selector])
  return rect
}

export default function GuidedTour({ onCreateConfig, onClose }: { onCreateConfig: () => void; onClose: () => void }) {
  const [i, setI] = useState(0)
  const step = STEPS[i]
  const rect = useAnchorRect(step.selector)
  const last = i === STEPS.length - 1

  // Esc dismisses the tour (same affordance as the app's modals).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A step whose anchor isn't mounted (e.g. the new-config button while the
  // sidebar is collapsed) would degrade to a centered card pointing at nothing,
  // so navigation skips it. Centered steps (selector: null) are always available.
  const available = (s: TourStep) => !s.selector || !!document.querySelector(s.selector)

  const next = () => {
    if (last) {
      onClose()
      onCreateConfig()
      return
    }
    for (let n = i + 1; n < STEPS.length; n++) {
      if (available(STEPS[n])) return setI(n)
    }
  }

  const back = () => {
    for (let n = i - 1; n >= 0; n--) {
      if (available(STEPS[n])) return setI(n)
    }
  }

  // The counter must describe the tour that will actually run: next()/back()
  // skip steps whose anchor isn't mounted, so STEPS.length over-promised (a
  // collapsed sidebar made it "4 of 6" and then finish). Count what is
  // reachable right now, always including the step on screen.
  const reachable = STEPS.filter((s, n) => n === i || available(s))
  const position = reachable.indexOf(step) + 1

  // Callout placement: beside the anchor when there is one, else centered.
  let cardStyle: React.CSSProperties
  if (rect) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const below = rect.bottom + 12
    const placeBelow = below + 160 < vh
    const top = placeBelow ? below : Math.max(12, rect.top - 12 - 160)
    let left = rect.left + rect.width / 2 - CARD_W / 2
    left = Math.max(12, Math.min(left, vw - CARD_W - 12))
    cardStyle = { position: 'fixed', top, left, width: CARD_W }
  } else {
    cardStyle = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: CARD_W }
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="App tour"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
    >
      {/* Dim + spotlight. When an anchor exists, a transparent box over it with a
          huge outset shadow dims everything else and rings the target. */}
      {rect ? (
        <div
          style={{
            position: 'fixed',
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 12,
            boxShadow: '0 0 0 9999px rgba(6,9,13,0.68), 0 0 0 2px var(--ob, #2f9bff)',
            transition: 'top .18s, left .18s, width .18s, height .18s',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(6,9,13,0.68)' }} />
      )}

      <div
        style={{
          ...cardStyle,
          background: 'var(--surface-raised, #1c2430)',
          border: '1px solid var(--border-strong, #33404f)',
          borderRadius: 14,
          padding: '16px 18px',
          boxShadow: '0 18px 50px rgba(0,0,0,.5)',
          color: 'var(--text-primary, #eef2f7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #8c949d)' }}>
            {position} of {reachable.length}
          </span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>{step.title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary, #a8b2c0)', marginBottom: 14 }}>
          {step.body}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onClose}
            type="button"
            style={{ background: 'none', border: 0, color: 'var(--text-muted, #8c949d)', fontSize: 12, cursor: 'pointer', padding: '8px 4px' }}
          >
            Skip tour
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {i > 0 && (
              <button
                onClick={back}
                type="button"
                style={{ background: 'transparent', border: '1px solid var(--border-strong, #33404f)', color: 'var(--text-secondary, #a8b2c0)', borderRadius: 9, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              type="button"
              style={{ border: 0, borderRadius: 9, padding: '8px 18px', fontSize: 13, fontWeight: 670, cursor: 'pointer', background: 'linear-gradient(135deg, var(--ob-bright, #5cb0ff), var(--ob-deep, #1b7fd9))', color: 'var(--ob-on, #04121f)' }}
            >
              {step.cta ?? 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
