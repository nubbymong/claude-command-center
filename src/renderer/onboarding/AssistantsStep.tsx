import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ProviderMark } from '../components/sidebar/Badges'
import { useSettingsStore } from '../stores/settingsStore'
import { claudeWasMissingAtSetup, savedChoice, type AssistantsChoice } from './provider-choice'
import { saveAssistantsChoice } from './save-provider-choice'

const NOT_INSTALLED = 'Claude Code is not installed'

interface Card {
  choice: AssistantsChoice
  title: string
  sub?: string
  beta?: boolean
  marks: Array<'claude' | 'codex'>
}

const CARDS: Card[] = [
  { choice: 'claude', title: 'Claude Code', sub: "Anthropic's coding agent", marks: ['claude'] },
  { choice: 'codex', title: 'Codex', sub: "OpenAI's coding agent", beta: true, marks: ['codex'] },
  { choice: 'both', title: 'Both', marks: ['claude', 'codex'] },
]

/**
 * "Which assistants will you use?" (WP2 commit 6e, canvas F1). Fresh installs
 * only; the harness skips it for anyone who ran the app before.
 *
 * Both is the default. Someone who came through first-run setup's "Use Codex
 * only" (the Claude Code CLI was not there) gets Codex, with the Claude and
 * Both cards disabled and the reason on them. Going Back to this page shows
 * the choice already saved.
 *
 * Continue saves both keys the way the Providers switch does (main first,
 * then the saved setting), and only then moves on, so the pages that follow
 * are decided by the choice just made.
 *
 * Keyboard (the ARIA radio group pattern): the cards are one Tab stop, the
 * selected card; the arrow keys move the selection, and focus with it, to the
 * next or previous card that can be chosen, round the ends. Continue has
 * focus when the page opens.
 */
export function AssistantsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [claudeMissing] = useState(() => claudeWasMissingAtSetup())
  const [choice, setChoice] = useState<AssistantsChoice>(() => {
    if (claudeMissing) return 'codex'
    return savedChoice(useSettingsStore.getState().settings) ?? 'both'
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disabled = (c: AssistantsChoice) => claudeMissing && c !== 'codex'
  const cardRefs = useRef<Partial<Record<AssistantsChoice, HTMLButtonElement | null>>>({})

  const onGroupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy || e.altKey || e.ctrlKey || e.metaKey) return
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const choosable = CARDS.map((c) => c.choice).filter((c) => !disabled(c))
    if (choosable.length === 0) return
    e.preventDefault()
    const at = choosable.indexOf(choice)
    const to = at < 0 ? choosable[0] : choosable[(at + step + choosable.length) % choosable.length]
    setChoice(to)
    cardRefs.current[to]?.focus()
  }

  const next = async () => {
    setBusy(true)
    setError(null)
    const r = await saveAssistantsChoice(choice)
    setBusy(false)
    if (r.ok) { onNext(); return }
    if (r.code === 'consumers' && typeof r.consumers === 'number' && r.consumers > 0) {
      setError(`An assistant you turned off is in use right now (${r.consumers}). Keep it on, or close what is using it first.`)
    } else setError(r.message)
  }

  // Continue is disabled while it saves, so the focus it had falls to the
  // page body; when the save fails, Continue has it again (the error is
  // announced, role=alert). A control the user moved to keeps it.
  const continueRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (busy || !error) return
    const at = document.activeElement
    if (at && at !== document.body) return
    continueRef.current?.focus()
  }, [busy, error])

  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(820px, 100%)' }}>
          <h2 className="h2">Which assistants will you use?</h2>
          <p className="p2-sub">You can change this later in Settings, Accounts.</p>
          <div className="as-cards" role="radiogroup" aria-label="Assistants" data-testid="assistants-cards" onKeyDown={onGroupKey}>
            {CARDS.map((c) => {
              const off = disabled(c.choice)
              const on = choice === c.choice
              return (
                <button
                  key={c.choice}
                  ref={(el) => { cardRefs.current[c.choice] = el }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  disabled={off || busy}
                  className={on ? 'as-card sel' : 'as-card'}
                  onClick={() => setChoice(c.choice)}
                  data-testid={`assistants-card-${c.choice}`}
                >
                  <span className="as-radio" aria-hidden />
                  <span className="as-marks">
                    {c.marks.map((m) => <ProviderMark key={m} providerId={m} size={26} />)}
                  </span>
                  <span className="as-t">
                    {c.title}
                    {c.beta && <span className="as-beta">Beta</span>}
                  </span>
                  {c.sub && <span className="as-sub">{c.sub}</span>}
                  {off && <span className="as-why" data-testid={`assistants-why-${c.choice}`}>{NOT_INSTALLED}</span>}
                </button>
              )
            })}
          </div>
          <p className="as-note" data-testid="assistants-local-note">Codex sessions run on this computer only in this release.</p>
          {error && <div className="gh-err" role="alert" data-testid="assistants-error">{error}</div>}
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button" disabled={busy}>← Back</button>
        <button ref={continueRef} className="cta" onClick={() => { void next() }} type="button" disabled={busy} autoFocus data-testid="assistants-continue">
          {busy ? 'Saving...' : 'Continue →'}
        </button>
      </div>
    </>
  )
}
