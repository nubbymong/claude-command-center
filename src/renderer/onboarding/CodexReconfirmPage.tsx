import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './onboarding.css'
import { ProviderMark } from '../components/sidebar/Badges'
import { OnboardingShell } from './OnboardingShell'
import { otherDialogOpen } from './contain-focus'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderAccountsStore, providerView } from '../stores/providerAccountsStore'
import { usesClaude } from './provider-choice'
import { saveCodexAnswer } from './save-provider-choice'

type Choice = 'yes' | 'no'

/** Why No cannot be chosen when Claude Code is off: said once, on the card. */
export const NO_NEEDS_CLAUDE = 'Claude Code is off, and one assistant always stays on.'

/**
 * "Do you use Codex?" (owner decisions 2026-09-26, approved mockup
 * .ccc-canvas/upgrade-codex-confirm.html, screen 1): the one-time page every
 * user who updates answers, a boot gate (codex-reconfirm-gate.ts). Nothing
 * carries over from the earlier Codex setting, so the user chooses again:
 *
 *   - Yes: Codex is recorded on (and answered), then App hands the user to
 *     the Set up Codex page (the harness's CodexSetupStep, screen 2), then
 *     the app. The sign-in already on this computer is used only if they
 *     choose "Use this sign-in" there.
 *   - No: Codex is recorded off (and answered). Codex configs are then
 *     refused with the usual "Codex is off" sentence.
 *
 * With Claude Code off (a Codex-only install) No cannot be chosen: one
 * assistant always stays on, and the card says so, once.
 *
 * It cannot be left without answering: no close button, and Escape does
 * nothing (it is swallowed here, so nothing behind the page acts on it
 * either). The answer is recorded only by Continue, never by showing the
 * page, so an app closed before it asks again at the next start. Keyboard as
 * the assistants page: the two cards are one radio group (one Tab stop, the
 * arrow keys move the choice), Continue has focus when the page opens, and
 * Tab stays on the page (OnboardingShell).
 */
export function CodexReconfirmPage({ onShown, onAnswered }: {
  /** The page is on screen: from now on only its own answer closes it. */
  onShown?: () => void
  /** The answer is saved. */
  onAnswered: (usesCodex: boolean) => void
}) {
  const claudeOn = useSettingsStore((s) => usesClaude(s.settings))
  const claudeOffInMain = useProviderAccountsStore((s) => providerView(s.snapshot, 'claude')?.enabled === false)
  const claudeOff = !claudeOn || claudeOffInMain
  const [picked, setPicked] = useState<Choice>('yes')
  const choice: Choice = claudeOff ? 'yes' : picked
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Partial<Record<Choice, HTMLButtonElement | null>>>({})
  const continueRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const onShownRef = useRef(onShown)
  onShownRef.current = onShown
  useEffect(() => { onShownRef.current?.() }, [])

  // Escape does nothing while the page is up: swallowed before anything else
  // hears it, unless a dialog opened above the page is the one it is for.
  useEffect(() => {
    const swallow = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (otherDialogOpen(rootRef.current)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', swallow, true)
    return () => window.removeEventListener('keydown', swallow, true)
  }, [])

  const disabled = (c: Choice) => c === 'no' && claudeOff

  const onGroupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy || e.altKey || e.ctrlKey || e.metaKey) return
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const choosable = (['yes', 'no'] as const).filter((c) => !disabled(c))
    e.preventDefault()
    const at = choosable.indexOf(choice)
    const to = at < 0 ? choosable[0] : choosable[(at + step + choosable.length) % choosable.length]
    setPicked(to)
    cardRefs.current[to]?.focus()
  }

  const next = async () => {
    if (busy) return
    const yes = choice === 'yes'
    setBusy(true)
    setError(null)
    const r = await saveCodexAnswer(yes)
    if (!mounted.current) return
    setBusy(false)
    if (r.ok) { onAnswered(yes); return }
    if (r.code === 'last-provider') setError(NO_NEEDS_CLAUDE)
    else if (r.code === 'consumers' && typeof r.consumers === 'number' && r.consumers > 0) {
      setError(`Codex is in use right now (${r.consumers}). Close what is using it, then choose again.`)
    } else setError(r.message)
  }

  // Continue is disabled while it saves, so the focus it had falls to the
  // page body; when the save fails, Continue has it again (the error is
  // announced, role=alert). A control the user moved to keeps it.
  useEffect(() => {
    if (busy || !error) return
    const at = document.activeElement
    if (at && at !== document.body) return
    continueRef.current?.focus()
  }, [busy, error])

  const card = (c: Choice, title: string, sub: string, marks: ReactNode) => {
    const off = disabled(c)
    const on = choice === c
    return (
      <button
        ref={(el) => { cardRefs.current[c] = el }}
        type="button"
        role="radio"
        aria-checked={on}
        tabIndex={on ? 0 : -1}
        disabled={off || busy}
        className={on ? 'as-card sel' : 'as-card'}
        onClick={() => setPicked(c)}
        data-testid={`codex-reconfirm-${c}`}
      >
        <span className="as-radio" aria-hidden />
        <span className="as-marks">{marks}</span>
        <span className="as-t">
          {title}
        </span>
        <span className="as-sub">{sub}</span>
        {off && <span className="as-why" data-testid="codex-reconfirm-no-why">{NO_NEEDS_CLAUDE}</span>}
      </button>
    )
  }

  return (
    <OnboardingShell phase={0} showPhases={false}>
      <>
        <div className="p2" ref={rootRef} data-testid="codex-reconfirm">
          <div className="p2-inner" style={{ width: 'min(720px, 100%)' }}>
            <h2 className="h2">Do you use Codex?</h2>
            <p className="p2-sub">Codex now has accounts of its own in this app. Choose again: your earlier Codex setting does not carry over.</p>
            <div className="as-cards as-cards-2" role="radiogroup" aria-label="Do you use Codex?" data-testid="codex-reconfirm-cards" onKeyDown={onGroupKey}>
              {card('yes', 'Yes, set up Codex', 'Use the Codex sign-in on this computer, or add a Codex account', <ProviderMark providerId="codex" size={26} />)}
              {card('no', "No, I don't use Codex", 'Codex stays off. You can set it up later in Settings, Accounts.', <span className="as-mark-none" />)}
            </div>
            <p className="as-note" data-testid="codex-reconfirm-local-note">Codex sessions run on this computer only in this release.</p>
            {error && <div className="gh-err" role="alert" data-testid="codex-reconfirm-error">{error}</div>}
          </div>
        </div>
        <div className="foot">
          <button ref={continueRef} className="cta" onClick={() => { void next() }} type="button" disabled={busy} autoFocus data-testid="codex-reconfirm-continue">
            {busy ? 'Saving...' : 'Continue'}
          </button>
        </div>
      </>
    </OnboardingShell>
  )
}
