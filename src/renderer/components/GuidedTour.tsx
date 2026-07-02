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
    body: 'Command Center runs your Claude (and Codex) sessions side by side. A quick look at where things live, then we’ll start your first session.',
  },
  {
    selector: '[data-tour="nav-rail"]',
    title: 'Everything has a home',
    body: 'Agent Hub, Insights, Tokenomics, Memory, Logs and the built-in tools (Conductor MCP) all live on this rail. Each opens a full page.',
  },
  {
    selector: '[data-tour="new-config"]',
    title: 'Start a session here',
    body: 'This is where you create a saved config and launch a Claude or Codex session, local or over SSH.',
  },
  {
    selector: '[aria-label="Settings"]',
    title: 'Change anything, anytime',
    body: 'Everything you just set up (accounts, GitHub, status line, tools, Codex) lives in Settings.',
  },
  {
    selector: '[aria-label="Feature Guide"]',
    title: 'Help lives here',
    body: 'The Feature Guide explains every feature in depth whenever you want it, and can hand your question to a Claude session that knows the app.',
  },
  {
    selector: null,
    title: 'Ready to go',
    body: 'Let’s set up your first session. The New Saved Config dialog opens so you can pick a name, model and account.',
    cta: 'Create your first session',
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

  const next = () => {
    if (last) {
      onClose()
      onCreateConfig()
    } else {
      setI((n) => Math.min(n + 1, STEPS.length - 1))
    }
  }

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
            boxShadow: '0 0 0 9999px rgba(6,9,13,0.68), 0 0 0 2px var(--ob, #e8915c)',
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
          <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #6a7480)' }}>
            {i + 1} of {STEPS.length}
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
            style={{ background: 'none', border: 0, color: 'var(--text-muted, #6a7480)', fontSize: 12, cursor: 'pointer', padding: '8px 4px' }}
          >
            Skip tour
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {i > 0 && (
              <button
                onClick={() => setI((n) => Math.max(0, n - 1))}
                type="button"
                style={{ background: 'transparent', border: '1px solid var(--border-strong, #33404f)', color: 'var(--text-secondary, #a8b2c0)', borderRadius: 9, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              type="button"
              style={{ border: 0, borderRadius: 9, padding: '8px 18px', fontSize: 13, fontWeight: 670, cursor: 'pointer', background: 'linear-gradient(135deg, var(--ob-bright, #f0a06a), var(--ob-deep, #c47b4a))', color: '#1a0d05' }}
            >
              {step.cta ?? 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
