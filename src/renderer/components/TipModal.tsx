import React from 'react'
import { useTipsStore } from '../stores/tipsStore'
import type { ViewType } from '../types/views'
import { resolveBody, resolveFocusHint } from '../tips-library'
import { BrandMark } from './BrandMark'
import { LightbulbMark } from './ui/LightbulbMark'
import { launchAskConductor } from '../lib/askConductor'
import { isContextMenuGesture } from '../lib/pointer'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DialogCallout,
  useDialogEscape,
} from './ui/Dialog'

/**
 * The tip dialog (#361).
 *
 * Rebuilt on the E5 primitives. Three things it gets wrong before are worth
 * naming, because each is a shape that recurs:
 *
 *  - **Five actions on one row.** Silence / Don't-show / Next / Discuss /
 *    Got-it all shared a 512px footer with nothing marked nowrap, so every
 *    label folded in half. The layout here is the mock's option A: the three
 *    flow actions stay as buttons, the two "stop showing me this" actions move
 *    into an overflow menu, and every visible label is nowrap. (A/B/C is still
 *    the owner's pick -- B was two tiers, C a card anchored to the dock pill.)
 *  - **`bg-mauve … text-base`.** Tailwind resolves `text-*` as a font SIZE
 *    first, so the primary button's "colour" was silently 16px text in the
 *    inherited colour. The E5 primary button sets its colour from
 *    `--text-on-brand`, which is the whole reason that token exists.
 *  - **A backdrop that closed on click.** Ctrl+C in a terminal fires click
 *    events. Dismissal is on MOUSEDOWN, via `DialogOverlay`'s opt-in, with the
 *    context-menu gesture guarded (`lib/pointer.ts`); Escape and the close
 *    glyph are the other two ways out.
 *
 * Colour: tips are peach (`--accent-tip`) and Ask Conductor is `--brand` -- the
 * two dock rows read as a pair, and this dialog carries the same accent as the
 * row that opened it. The Discuss button stays brand-coloured because it IS the
 * Ask action, and the primary button is the standard E5 brand fill so the
 * dialog's main affirmative looks like every other dialog's.
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

export default function TipModal({ onClose, onNavigate }: Props) {
  // Subscribe to currentTipId so the modal re-renders when it changes
  const currentTipId = useTipsStore((s) => s.currentTipId)
  const dismissTip = useTipsStore((s) => s.dismissTip)
  const markTipActed = useTipsStore((s) => s.markTipActed)
  const pickNextTip = useTipsStore((s) => s.pickNextTip)
  const silenceUntilRestart = useTipsStore((s) => s.silenceUntilRestart)

  const [overflowOpen, setOverflowOpen] = React.useState(false)

  // Escape closes. The dialog holds no user input, so there is nothing to lose
  // -- see the hook's own warning about dialogs that do.
  useDialogEscape(onClose)

  const current = useTipsStore.getState().getCurrentTip()
  if (!current) return null
  const { tip, content } = current
  const isMac = typeof window !== 'undefined' && window.electronPlatform === 'darwin'
  const body = resolveBody(content, isMac)
  const focusHint = resolveFocusHint(content, isMac)

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

  const handleNext = () => {
    pickNextTip()
    onClose()
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

  return (
    <DialogOverlay onBackdropDismiss={onClose} testId="tip-modal-overlay">
      <DialogPanel width="w-[512px]" labelledBy="tip-modal-title" testId="tip-modal">
        <DialogHeader
          title={content.title}
          titleId="tip-modal-title"
          subtitle={`${tip.category} - ${tip.complexity}`}
          glyph={<LightbulbMark className="w-[18px] h-[18px]" />}
          glyphAccent="var(--accent-tip)"
          onClose={onClose}
          closeTestId="tip-modal-close"
        />

        <DialogBody testId="tip-modal-body">
          {renderBody(body)}

          {focusHint && (
            <DialogCallout tone="tip" title="Where to look" className="mt-3" testId="tip-modal-focus-hint">
              {focusHint}
            </DialogCallout>
          )}
        </DialogBody>

        <DialogFooter
          testId="tip-modal-footer"
          left={
            <div className="relative">
              <DialogButton
                variant="ghost"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="More tip options"
                title="More tip options"
                testId="tip-modal-overflow"
              >
                <OverflowMark />
              </DialogButton>
              {overflowOpen && (
                <>
                  {/* Mousedown, not click, and a right-click dismisses inertly --
                      the same rule as the command bar's popovers (#386). */}
                  <div
                    className="fixed inset-0 z-50"
                    onMouseDown={(e) => { if (!isContextMenuGesture(e)) setOverflowOpen(false) }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOverflowOpen(false) }}
                    data-testid="tip-modal-overflow-backdrop"
                  />
                  <div
                    role="menu"
                    className="absolute bottom-full left-0 mb-1.5 z-[51] min-w-[188px] rounded-[9px] py-1 px-1 shadow-2xl"
                    style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
                    data-testid="tip-modal-overflow-menu"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleSilence}
                      className={`${overflowItem} hover:bg-[color-mix(in_srgb,var(--text-primary)_9%,transparent)]`}
                      style={{ color: 'var(--text-secondary)' }}
                      title="Don't show tips again until the next app restart"
                      data-testid="tip-modal-silence"
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
                      data-testid="tip-modal-never"
                    >
                      Don't show this again
                    </button>
                  </div>
                </>
              )}
            </div>
          }
        >
          <DialogButton variant="ghost" onClick={handleNext} testId="tip-modal-next">
            Next tip
          </DialogButton>
          <DialogButton
            data-ux-id="tip-ask-conductor"
            onClick={handleDiscuss}
            title="Ask Conductor about this tip"
            testId="tip-modal-discuss"
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
            <DialogButton variant="primary" onClick={handleAction} testId="tip-modal-primary">
              {content.actionLabel}
            </DialogButton>
          ) : (
            <DialogButton
              variant="primary"
              onClick={() => { markTipActed(tip.id); onClose() }}
              testId="tip-modal-primary"
            >
              Got it
            </DialogButton>
          )}
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
