import React from 'react'
import { useTipsStore, countUnseenTips } from '../stores/tipsStore'
import type { ViewType } from '../types/views'
import { resolveBody, resolveFocusHint } from '../tips-library'
import { BrandMark } from './BrandMark'
import { LightbulbMark } from './ui/LightbulbMark'
import { launchAskConductor } from '../lib/askConductor'
import { isContextMenuGesture } from '../lib/pointer'
import {
  DialogBody,
  DialogFooter,
  DialogButton,
  DialogCallout,
  useDialogEscape,
} from './ui/Dialog'

/**
 * The tip card (#361) — owner's pick C: a card anchored to the dock pill, not
 * a dialog over the app.
 *
 * The previous shape was a centred modal with a dimmed backdrop, which made a
 * TIP block the whole app: reading "you can Ctrl+wheel the canvas" cost the
 * user their terminal until they dismissed it. This card floats up from the
 * "Tip of the day" pill that opened it, the app stays live behind it, and the
 * ways out are Escape, the close glyph, or any of the three actions. There is
 * deliberately NO outside-click dismiss: with no backdrop the old
 * click-eats-dialog trap (Ctrl+C in a terminal fires click events) cannot
 * exist, and a card that survives a stray click is the point of a card.
 *
 * Layout decisions that carry over from the modal, because the bugs they fixed
 * would come straight back:
 *
 *  - **Three footer actions, nowrap.** Five peers on one row wrapped every
 *    label. The flow actions (Next / Discuss / Got-it) stay as buttons; the
 *    two "stop showing me this" actions live under the ⋯ in the HEADER now,
 *    which is where the mock put them once the footer no longer had a spare
 *    corner.
 *  - **Next advances IN PLACE.** The modal closed on "Next tip", which read
 *    as the button not working — the next tip appeared only in the dock row.
 *    A non-blocking card can just show it; when the rotation runs out the
 *    card closes itself (`currentTipId` goes null).
 *  - **The card stamps `markTipShown`.** The stamp belongs to whatever draws
 *    the tip. The dock row stamps the one it renders; tips the user pages
 *    through HERE are equally shown, and the stamp is idempotent.
 *
 * Anchoring: the pill is found by its `data-ux-id`, which both sidebar
 * variants carry — the expanded row and the collapsed icon rail — so the same
 * math covers both, and a ResizeObserver on the pill re-anchors the card when
 * the sidebar collapses or expands under it. If the pill cannot be found or
 * has no layout yet (dock hidden mid-session, jsdom), the card falls back to
 * the bottom-left corner rather than rendering at 0,0 over the sidebar.
 *
 * Colour: tips are peach (`--accent-tip`), Ask Conductor is `--brand`; the
 * Discuss button stays brand-coloured because it IS the Ask action, and the
 * primary is the standard E5 brand fill.
 */

interface Props {
  onClose: () => void
  onNavigate?: (view: ViewType) => void
}

/** Three dots, drawn. The project bans emoji and `\u{...}` escapes in JSX. */
function OverflowMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  )
}

/** Render a tip body with **bold** markdown segments and line breaks */
function renderBody(body: string): React.ReactNode {
  return body.split('\n').map((line, i) => {
    if (line.trim() === '') return <div key={i} className="h-2" />
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    return (
      <p key={i} className="text-[12.5px] leading-relaxed mb-2" style={{ color: 'var(--text-secondary)' }}>
        {parts.map((part, j) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={j} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{part.slice(2, -2)}</strong>
          }
          if (part.startsWith('`') && part.endsWith('`')) {
            return (
              <code
                key={j}
                className="px-1 py-0.5 rounded text-[0.82rem]"
                style={{ color: 'var(--text-primary)', background: 'var(--surface-overlay)' }}
              >
                {part.slice(1, -1)}
              </code>
            )
          }
          return <span key={j}>{part}</span>
        })}
      </p>
    )
  })
}

const PILL_SELECTOR = '[data-ux-id="sidebar-tip-pill"]'
const CARD_WIDTH = 400
const PILL_GAP = 10
const EDGE_MARGIN = 12

/** Where the card sits: right of the pill, bottom-aligned with it, clamped to
 *  the window. Both sidebar variants (expanded row, collapsed icon) match the
 *  selector, so collapse/expand is just a different rect. No pill → the
 *  bottom-left corner. */
function anchorToPill(): { left: number; bottom: number } {
  const rect = document.querySelector(PILL_SELECTOR)?.getBoundingClientRect()
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return {
      left: Math.max(EDGE_MARGIN, Math.min(rect.right + PILL_GAP, window.innerWidth - CARD_WIDTH - EDGE_MARGIN)),
      bottom: Math.max(EDGE_MARGIN, window.innerHeight - rect.bottom),
    }
  }
  return { left: EDGE_MARGIN, bottom: EDGE_MARGIN }
}

export default function TipCard({ onClose, onNavigate }: Props) {
  // Subscribe to currentTipId so the card re-renders when Next advances it
  const currentTipId = useTipsStore((s) => s.currentTipId)
  const tracking = useTipsStore((s) => s.tracking)
  const dismissTip = useTipsStore((s) => s.dismissTip)
  const markTipActed = useTipsStore((s) => s.markTipActed)
  const pickNextTip = useTipsStore((s) => s.pickNextTip)
  const silenceUntilRestart = useTipsStore((s) => s.silenceUntilRestart)

  const [overflowOpen, setOverflowOpen] = React.useState(false)
  const [anchor, setAnchor] = React.useState(anchorToPill)

  // Escape closes. The card holds no user input, so there is nothing to lose
  // -- see the hook's own warning about dialogs that do.
  useDialogEscape(onClose)

  // Keep the card pinned to the pill: window resizes move the bottom edge, and
  // collapsing the sidebar swaps the wide row for the icon rail (the observer
  // sees the pill's size change and re-reads its rect).
  React.useEffect(() => {
    const update = () =>
      setAnchor((prev) => {
        const next = anchorToPill()
        return next.left === prev.left && next.bottom === prev.bottom ? prev : next
      })
    update()
    window.addEventListener('resize', update)
    const pill = document.querySelector(PILL_SELECTOR)
    let observer: ResizeObserver | null = null
    if (pill && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(pill)
    }
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])

  // The card draws the tip, so the card stamps it shown (idempotent — the
  // store keeps the FIRST timestamp; see markTipShown).
  React.useEffect(() => {
    if (currentTipId) useTipsStore.getState().markTipShown(currentTipId)
  }, [currentTipId])

  // When the rotation runs dry (Next past the last eligible tip) or an action
  // clears the current tip, there is nothing left to anchor a card to.
  React.useEffect(() => {
    if (!currentTipId) onClose()
  }, [currentTipId, onClose])

  // Derived OUTSIDE the selector on purpose: getCurrentTip() builds a fresh
  // object every call, which would fail zustand's Object.is check and
  // re-render for ever (same rule as AskConductorDock).
  const current = React.useMemo(
    () => (currentTipId ? useTipsStore.getState().getCurrentTip() : null),
    [currentTipId, tracking],
  )
  if (!current) return null
  const { tip, content } = current
  const isMac = typeof window !== 'undefined' && window.electronPlatform === 'darwin'
  const body = resolveBody(content, isMac)
  const focusHint = resolveFocusHint(content, isMac)
  const unseen = countUnseenTips(tracking)

  const handleAction = () => {
    markTipActed(tip.id)
    if (content.actionTarget && onNavigate) {
      onNavigate(content.actionTarget as ViewType)
    }
    onClose()
  }

  const handleDismiss = () => {
    dismissTip(tip.id)
    pickNextTip()
    onClose()
  }

  // In place, not close-and-reopen: the whole point of a non-blocking card.
  const handleNext = () => {
    setOverflowOpen(false)
    pickNextTip()
  }

  const handleSilence = () => {
    silenceUntilRestart()
    onClose()
  }

  // A tip card is written once and then ages. Handing it to Ask Conductor turns
  // it into an answer against the version actually running -- which is the whole
  // reason the help session knows the app's own docs.
  const handleDiscuss = () => {
    markTipActed(tip.id)
    void launchAskConductor(
      `A tip in AI Code Conductor says: "${content.title}" -- ${body}. ` +
      'Explain what this does in the version I am running, and how to use it.',
    ).then((id) => { if (id && onNavigate) onNavigate('sessions') })
    onClose()
  }

  const overflowItem = 'w-full text-left px-2.5 py-1.5 rounded-md text-[12px] whitespace-nowrap transition-colors focus-ring'
  const headerGlyphButton = 'shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center focus-ring transition-colors hover:bg-[var(--surface-overlay)]'

  return (
    <div
      role="dialog"
      aria-labelledby="tip-card-title"
      className="fixed z-40 w-[400px] max-w-[calc(100vw-24px)] max-h-[70vh] rounded-[14px] shadow-2xl flex flex-col min-h-0"
      style={{
        left: anchor.left,
        bottom: anchor.bottom,
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
      data-testid="tip-card"
    >
      <div
        className="px-4 pt-3 pb-2.5 shrink-0 flex items-start gap-2.5"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
        data-testid="tip-card-header"
      >
        <div
          className="shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center mt-px"
          style={{ background: 'color-mix(in srgb, var(--accent-tip) 14%, transparent)', color: 'var(--accent-tip)' }}
          aria-hidden
        >
          <LightbulbMark className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          {unseen > 0 && (
            <p className="text-[10px] leading-none mb-0.5" style={{ color: 'var(--text-muted)' }} data-testid="tip-card-unseen">
              {unseen} more you have not seen
            </p>
          )}
          <h2 id="tip-card-title" className="text-[13.5px] font-semibold leading-snug">
            {content.title}
          </h2>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            className={headerGlyphButton}
            style={{ color: 'var(--text-muted)' }}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label="Tip options"
            title="Tip options"
            data-testid="tip-card-overflow"
          >
            <OverflowMark />
          </button>
          {overflowOpen && (
            <>
              {/* Mousedown, not click, and a right-click dismisses inertly --
                  the same rule as the command bar's popovers (#386). */}
              <div
                className="fixed inset-0 z-[45]"
                onMouseDown={(e) => { if (!isContextMenuGesture(e)) setOverflowOpen(false) }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOverflowOpen(false) }}
                data-testid="tip-card-overflow-backdrop"
              />
              <div
                role="menu"
                className="absolute top-full right-0 mt-1.5 z-[46] min-w-[188px] rounded-[9px] py-1 px-1 shadow-2xl"
                style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
                data-testid="tip-card-overflow-menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSilence}
                  className={`${overflowItem} hover:bg-[color-mix(in_srgb,var(--text-primary)_9%,transparent)]`}
                  style={{ color: 'var(--text-secondary)' }}
                  title="Don't show tips again until the next app restart"
                  data-testid="tip-card-silence"
                >
                  Silence until restart
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleDismiss}
                  className={`${overflowItem} hover:bg-[color-mix(in_srgb,var(--status-danger)_12%,transparent)]`}
                  style={{ color: 'var(--status-danger)' }}
                  title="Never show this specific tip again"
                  data-testid="tip-card-never"
                >
                  Don't show this again
                </button>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className={headerGlyphButton}
          style={{ color: 'var(--text-muted)' }}
          aria-label="Close"
          title="Close"
          data-testid="tip-card-close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>

      <DialogBody testId="tip-card-body">
        {renderBody(body)}

        {focusHint && (
          <DialogCallout tone="tip" title="Where to look" className="mt-3" testId="tip-card-focus-hint">
            {focusHint}
          </DialogCallout>
        )}
      </DialogBody>

      <DialogFooter testId="tip-card-footer">
        <DialogButton variant="ghost" onClick={handleNext} testId="tip-card-next">
          Next tip
        </DialogButton>
        <DialogButton
          data-ux-id="tip-ask-conductor"
          onClick={handleDiscuss}
          title="Ask Conductor about this tip"
          testId="tip-card-discuss"
          style={{
            color: 'var(--brand)',
            background: 'color-mix(in srgb, var(--brand) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--brand) 42%, transparent)',
          }}
        >
          <BrandMark className="w-3 h-3 shrink-0" />
          Discuss
        </DialogButton>
        {content.actionLabel ? (
          <DialogButton variant="primary" onClick={handleAction} testId="tip-card-primary">
            {content.actionLabel}
          </DialogButton>
        ) : (
          <DialogButton
            variant="primary"
            onClick={() => { markTipActed(tip.id); onClose() }}
            testId="tip-card-primary"
          >
            Got it
          </DialogButton>
        )}
      </DialogFooter>
    </div>
  )
}
