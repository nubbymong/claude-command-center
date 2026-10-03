import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'
import { OnboardingShell } from './OnboardingShell'
import { otherDialogOpen } from './contain-focus'
import { ProviderMark } from '../components/sidebar/Badges'
import { DialogOverlay, useDialogEscape } from '../components/ui/Dialog'
import { useProviderAccountsStore } from '../stores/providerAccountsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { usePaneOcclusionStore } from '../stores/paneOcclusionStore'
import {
  CLAUDE_REVIEW_SHIPS, HELLO_CODEX_ARM_MS, HELLO_CODEX_PAGE_COUNT, claudeCodeOn, helloCodexPages, helloCodexComparison,
  helloCodexDue, helloCodexTakeoverReady, markHelloCodexSeen, useHelloCodexStore,
  type HelloCodexCopyInputs, type HelloCodexOpen, type HelloCodexPage, type HelloCodexPageId,
} from './hello-codex'

/**
 * Hello Codex, the Codex introduction (WP2 commit 6f). Five pages in the
 * approved What's New showcase anatomy: an eyebrow ("Codex - N of 5"), a
 * heading, a tagline, points with bold lead-ins, a "Where:" locator, and a
 * drawn vignette in pure CSS and JSX (styles in onboarding.css under `.hc-*`).
 * The footer has page dots (24px hit targets), Skip, Back and Next; the last
 * page has "Start a Codex session" (primary) and Done.
 *
 * One component, three places: the onboarding page after Codex setup
 * (HelloCodexStep), the one-time takeover outside onboarding, and a replay
 * from the Feature Guide or Settings, Accounts (HelloCodexTakeover, hosted by
 * HelloCodexHost in App). The first two write the seen stamp; a replay writes
 * it only when the page was still due (it was the showing).
 *
 * Keyboard: Left and Right move between pages, Enter activates the focused
 * button, Escape is Skip. Auto-repeated keys are ignored, and so is every key
 * for a short while after the takeover opens (HELLO_CODEX_ARM_MS) and while
 * another dialog is open above it: that dialog gets them. Focus lands on the
 * primary button on entry, and the primary button stays the same element on
 * every page so focus stays on it. Tab stays inside the page: all three
 * places render it in OnboardingShell, which keeps Tab in (contain-focus.ts),
 * and App makes the app behind the takeover and a replay inert. With reduced
 * motion, pages cut instead of slide.
 */

export type HelloCodexOutcome = 'done' | 'skip' | 'start'

const HEADING_ID = 'hello-codex-heading'

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** `backticks` in the copy become code. */
function rich(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))
}

/** The copy's inputs, live: the build's claude_review, and whether Claude
 *  Code is on (the saved setting and main's switch). */
function useCopyInputs(claudeReview: boolean): HelloCodexCopyInputs {
  const settings = useSettingsStore((s) => s.settings)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  return { claudeReview, claudeOn: claudeCodeOn(settings, snapshot) }
}

// -- Vignettes: pictures OF the features, decorative (aria-hidden) -----------

function Tab({ provider, name, on = false }: { provider: 'claude' | 'codex'; name: string; on?: boolean }) {
  return (
    <div className={`hc-tab${on ? ' on' : ''}`}>
      <ProviderMark providerId={provider} size={14} />
      {name}
    </div>
  )
}

function HelloArt({ claudeOn }: { claudeOn: boolean }) {
  return (
    <div className="hc-vig" aria-hidden data-testid="hc-art-hello" data-ux-id="hc-art-hello">
      <div className="hc-tabs">
        {claudeOn
          ? <><Tab provider="claude" name="api-server" /><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="claude" name="docs" /></>
          : <><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="codex" name="docs (Codex)" /></>}
      </div>
      <div className="hc-term">
        <div className="dim">&gt;_ OpenAI Codex  model gpt-5.5  account work@example</div>
        <div className="dim">workspace ~/projects/api-server</div>
        <div className="hc-gap" />
        <div><span className="p">&gt;</span> <span className="hl">add a retry to the upload client and a test for it</span></div>
        <div className="dim">  reading src/upload/client.ts</div>
        <div className="dim">  editing src/upload/client.ts</div>
        <div className="ok">  tests passed (12)</div>
      </div>
    </div>
  )
}

function AccountsArt() {
  return (
    <div className="hc-vig" aria-hidden data-testid="hc-art-accounts" data-ux-id="hc-art-accounts">
      <div className="hc-row hc-head">
        <ProviderMark providerId="codex" size={16} />
        <b>Codex accounts</b>
        <span className="hc-spacer" />
        <span className="hc-mini-btn">Add account</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">W</span>
        <div><div>work@example</div><div className="hc-muted">ChatGPT sign-in</div></div>
        <span className="hc-spacer" />
        <span className="hc-badge def">Default</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">R</span>
        <div><div>review-bot key</div><div className="hc-muted">API key</div></div>
        <span className="hc-spacer" />
        <span className="hc-badge rev">Reviewer</span>
      </div>
      <div className="hc-row">
        <span className="hc-avatar">~</span>
        <div><div>This computer&apos;s Codex (~/.codex)</div><div className="hc-muted">Existing sign-in</div></div>
        <span className="hc-spacer" />
        <span className="hc-badge warn">Confirm each launch</span>
      </div>
    </div>
  )
}

function LaunchArt() {
  return (
    <div className="hc-stack" aria-hidden data-testid="hc-art-launch" data-ux-id="hc-art-launch">
      <div className="hc-vig">
        <div className="hc-row hc-head"><b>New saved config</b></div>
        <div className="hc-cards">
          <div className="hc-card"><ProviderMark providerId="claude" size={18} /><div>Claude Code<div className="hc-muted">Anthropic</div></div></div>
          <div className="hc-card on"><ProviderMark providerId="codex" size={18} /><div>Codex<div className="hc-muted">OpenAI</div></div></div>
        </div>
        <div className="hc-field"><span>Account</span><span>work@example</span></div>
        <div className="hc-field"><span>Permissions</span><span>Standard</span></div>
        <div className="hc-field off"><span>SSH</span><span>Not available for Codex in this release</span></div>
      </div>
      <div className="hc-vig">
        <div className="hc-tui">
          <div className="hc-tbox">
            <span className="hc-tt">Resume Codex Conversation</span>
            <div className="hc-trow"><span className="n">1</span><span className="hl">retry for the upload client</span><span className="dim">2h ago</span></div>
            <div className="hc-trow"><span className="n">2</span><span>pagination bug in /orders</span><span className="dim">Yesterday</span></div>
            <div className="hc-trow"><span className="n">3</span><span>update the README examples</span><span className="dim">3d ago</span></div>
            <div className="hc-trow"><span className="new">n</span><span>New conversation</span><span /></div>
          </div>
          <div className="hc-prompt">&gt; 1</div>
        </div>
      </div>
    </div>
  )
}

function ReviewFlow({ from, to, ask, findings }: { from: 'claude' | 'codex'; to: 'Claude' | 'Codex'; ask: string; findings: number }) {
  const who = from === 'claude' ? 'Claude' : 'Codex'
  return (
    <div data-testid={`hc-flow-${from}`} data-ux-id={`hc-flow-${from}`}>
      <div className="hc-flow-lbl">From a {who} session</div>
      <div className="hc-flow">
        <div className="hc-vig hc-vig-mini">
          <div className="hc-tabs">
            {from === 'claude'
              ? <><Tab provider="claude" name="api-server" on /><Tab provider="claude" name="docs" /></>
              : <><Tab provider="codex" name="api-server (Codex)" on /><Tab provider="claude" name="api-server" /></>}
          </div>
          <div className="hc-term hc-term-mini"><span className="p">&gt;</span> <span className="hl">{ask}</span></div>
        </div>
        <span className="hc-arrow" />
        <div className="hc-revbox">separate {to} reviewer - read-only</div>
        <span className="hc-arrow" />
        <div className="hc-finds">
          <div className="hc-fh">{findings} findings</div>
          {Array.from({ length: findings }, (_, i) => (
            <div className="hc-fi" key={i}>{i + 1}. <span className="hc-sk" style={{ flex: 1 - i * 0.2 }} /></div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The review drawing is an illustration of the feature as the build ships
 *  it: with Claude Code off it still shows both directions, and the points
 *  say what review needs. */
function ReviewArt({ claudeReview }: { claudeReview: boolean }) {
  return (
    <div className="hc-flows" aria-hidden data-testid="hc-art-review" data-ux-id="hc-art-review">
      <ReviewFlow from="claude" to="Codex" ask="ask for a Codex review" findings={3} />
      {claudeReview && <ReviewFlow from="codex" to="Claude" ask="ask for a Claude review" findings={2} />}
    </div>
  )
}

function DifferencesArt({ inputs }: { inputs: HelloCodexCopyInputs }) {
  return (
    <div className="hc-vig" aria-hidden data-testid="hc-art-differences" data-ux-id="hc-art-differences">
      <table className="hc-cmp" data-testid="hc-compare">
        <thead>
          <tr>
            <th />
            <th><span className="hc-th"><ProviderMark providerId="claude" size={14} />Claude</span></th>
            <th><span className="hc-th"><ProviderMark providerId="codex" size={14} />Codex</span></th>
          </tr>
        </thead>
        <tbody>
          {helloCodexComparison(inputs).map(([what, claude, codex]) => (
            <tr key={what} data-row={what}>
              <td>{what}</td>
              <td>{rich(claude)}</td>
              <td data-cell="codex">{rich(codex)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Art({ id, inputs }: { id: HelloCodexPageId; inputs: HelloCodexCopyInputs }) {
  if (id === 'hello') return <HelloArt claudeOn={inputs.claudeOn} />
  if (id === 'accounts') return <AccountsArt />
  if (id === 'launch') return <LaunchArt />
  if (id === 'review') return <ReviewArt claudeReview={inputs.claudeReview} />
  return <DifferencesArt inputs={inputs} />
}

// -- The pages and their footer ---------------------------------------------

function PageView({ page, n, inputs }: { page: HelloCodexPage; n: number; inputs: HelloCodexCopyInputs }) {
  return (
    <>
      <div className="sc-copy hc-copy">
        <div className="sc-eyebrow" data-testid="hc-eyebrow" data-ux-id="hc-eyebrow">Codex - {n} of {HELLO_CODEX_PAGE_COUNT}</div>
        <h1 className="sc-h" id={HEADING_ID} data-testid="hc-heading" data-ux-id="hc-heading">{page.heading}</h1>
        <p className="sc-tagline" data-testid="hc-tagline" data-ux-id="hc-tagline">{page.tagline}</p>
        <div className="sc-points" data-testid="hc-points" data-ux-id="hc-points">
          {page.points.map((pt) => (
            <div className="sc-pt hc-pt" key={pt.lead} data-point={pt.lead}>
              <span className="wn-dot sc-dot" />
              <div><b>{pt.lead}</b> {rich(pt.rest)}</div>
            </div>
          ))}
        </div>
        {page.where && <p className="sc-where" data-testid="hc-where" data-ux-id="hc-where">Where: {page.where}</p>}
        {page.localNote && <span className="hc-local" data-testid="hc-local-note" data-ux-id="hc-local-note"><i />{page.localNote}</span>}
      </div>
      <div className="sc-art" data-ux-id="hc-art"><Art id={page.id} inputs={inputs} /></div>
    </>
  )
}

export function HelloCodex({
  onFinish,
  onBackOut,
  claudeReview = CLAUDE_REVIEW_SHIPS,
  armDelayMs = 0,
  dialog = false,
}: {
  onFinish: (outcome: HelloCodexOutcome) => void
  /** Page 1's Back, out of the introduction without finishing it (the
   *  onboarding page: back to the page before). Absent, page 1 has no Back. */
  onBackOut?: () => void
  /** Whether `claude_review` ships in this build: always CLAUDE_REVIEW_SHIPS
   *  in the app. A test passes false to see the build without it. */
  claudeReview?: boolean
  /** Keys are ignored for this long after it opens (the takeover). */
  armDelayMs?: number
  /** Rendered as a modal dialog (the takeover and a replay). */
  dialog?: boolean
}) {
  const inputs = useCopyInputs(claudeReview)
  const pages = helloCodexPages(inputs)
  const [ix, setIx] = useState(0)
  const [move, setMove] = useState<{ dir: 'next' | 'prev'; cut: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const finished = useRef(false)
  const armed = useRef(armDelayMs <= 0)
  const last = ix === pages.length - 1

  const go = (to: number) => {
    if (to < 0 || to >= pages.length || to === ix) return
    setMove({ dir: to > ix ? 'next' : 'prev', cut: prefersReducedMotion() })
    setIx(to)
  }
  const finish = (outcome: HelloCodexOutcome) => {
    if (finished.current) return
    finished.current = true
    onFinish(outcome)
  }

  // Focus on the primary button on entry.
  useEffect(() => { primaryRef.current?.focus() }, [])

  // Arming: keys count only after the delay.
  useEffect(() => {
    if (armed.current) return
    const t = setTimeout(() => { armed.current = true }, armDelayMs)
    return () => clearTimeout(t)
  }, [armDelayMs])

  // The guard, registered FIRST (capture, before the Escape handler below):
  // while not armed, and for an auto-repeated key, the key is swallowed, so a
  // held key or a keystroke meant for something else never pages, presses the
  // focused button or dismisses the page. While another dialog is open above,
  // it is left alone for that dialog.
  useEffect(() => {
    const guard = (e: KeyboardEvent) => {
      if (otherDialogOpen(rootRef.current)) return
      if (armed.current && !e.repeat) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', guard, true)
    window.addEventListener('keyup', guard, true)
    return () => {
      window.removeEventListener('keydown', guard, true)
      window.removeEventListener('keyup', guard, true)
    }
  }, [])

  // Escape is Skip, unless another dialog is open above: then it is that
  // dialog's (it registered later, so it would otherwise never hear it).
  useDialogEscape(() => finish('skip'), true, () => !otherDialogOpen(rootRef.current))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (otherDialogOpen(rootRef.current)) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'ArrowRight') { e.preventDefault(); go(ix + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(ix - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const transition = move ? (move.cut ? 'cut' : 'slide') : 'none'
  const slideClass = move && !move.cut ? ` hc-slide-${move.dir}` : ''

  return (
    <div
      ref={rootRef}
      className="hc-root"
      data-testid="hello-codex"
      data-ux-id="hello-codex"
      data-page={pages[ix].id}
      {...(dialog ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': HEADING_ID } : {})}
    >
      <div className="p2">
        <div
          key={ix}
          className={`p2-inner sc-page hc-page${slideClass}`}
          style={{ width: 'min(1060px, 100%)' }}
          data-testid="hc-page"
          data-ux-id={`hc-page-${pages[ix].id}`}
          data-transition={transition}
        >
          <PageView page={pages[ix]} n={ix + 1} inputs={inputs} />
        </div>
      </div>
      <div className="foot">
        <div className="wn-foot-dots hc-dots" role="group" aria-label="Codex introduction pages" data-testid="hc-dots" data-ux-id="hc-dots">
          {pages.map((p, i) => (
            <button
              type="button"
              key={p.id}
              className={`wn-fdot${i === ix ? ' on' : ''}`}
              onClick={() => go(i)}
              aria-label={p.heading}
              aria-current={i === ix ? 'page' : undefined}
              data-testid={`hc-dot-${i + 1}`}
              data-ux-id={`hc-dot-${p.id}`}
            >
              <i />
            </button>
          ))}
        </div>
        <span className="hint" data-testid="hc-hint" data-ux-id="hc-hint">Page {ix + 1} of {pages.length}</span>
        <div className="cx-foot-actions">
          {!last && <button type="button" className="skip wn-skip" onClick={() => finish('skip')} data-testid="hc-skip" data-ux-id="hc-skip">Skip</button>}
          {(ix > 0 || onBackOut) && (
            <button type="button" className="back" onClick={() => (ix > 0 ? go(ix - 1) : onBackOut?.())} data-testid="hc-back" data-ux-id="hc-back">Back</button>
          )}
          {last && <button type="button" className="back" onClick={() => finish('done')} data-testid="hc-done" data-ux-id="hc-done">Done</button>}
          <button
            type="button"
            ref={primaryRef}
            className="cta"
            onClick={() => (last ? finish('start') : go(ix + 1))}
            data-testid="hc-primary"
            data-ux-id="hc-primary"
          >
            {last ? 'Start a Codex session' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -- Onboarding: the page after Codex setup ---------------------------------

/** The onboarding page. Every way out stamps the page seen; "Start a Codex
 *  session" also asks the harness to open New saved config with Codex chosen
 *  once the run ends (the harness covers the window until then). Back from
 *  page 1 returns to the page before, and stamps nothing. */
export function HelloCodexStep({ onNext, onBack, onStartSession }: {
  onNext: () => void
  onBack?: () => void
  onStartSession: () => void
}) {
  return (
    <HelloCodex
      onBackOut={onBack}
      onFinish={(outcome) => {
        markHelloCodexSeen()
        if (outcome === 'start') onStartSession()
        onNext()
      }}
    />
  )
}

// -- Outside onboarding: the one-time takeover and a replay -----------------

/** The takeover over the whole app: the MultiSpawnStartupPage pattern and
 *  layering, an opaque DialogOverlay over --surface-base at the shared z-50
 *  (the app is not dimmed, it is replaced; the close dialogs, rendered after
 *  it, paint above it), with the onboarding frame and a real <h1>. A replay is
 *  the same page; it writes the stamp only when the page was still due, since
 *  then it was the showing and the takeover must not follow it. */
export function HelloCodexTakeover({ replay = false, onClose, onStartSession }: {
  replay?: boolean
  onClose: () => void
  onStartSession: () => void
}) {
  const finish = (outcome: HelloCodexOutcome) => {
    if (!replay || helloCodexDue(useProviderAccountsStore.getState().snapshot, useAppMetaStore.getState().meta)) markHelloCodexSeen()
    onClose()
    if (outcome === 'start') onStartSession()
  }
  return (
    <DialogOverlay style={{ background: 'var(--surface-base)' }} testId={replay ? 'hello-codex-replay' : 'hello-codex-takeover'}>
      <OnboardingShell phase={0} showPhases={false}>
        <HelloCodex dialog armDelayMs={replay ? 0 : HELLO_CODEX_ARM_MS} onFinish={finish} />
      </OnboardingShell>
    </DialogOverlay>
  )
}

/**
 * App's host for the introduction outside onboarding. It opens the takeover
 * once, on the first snapshot that makes it due, when every boot gate has had
 * its turn (`gatesClear`, from bootChain) and no dialog or other overlay is
 * up. It shows a replay whenever one is asked for. `takeoverTurn` is
 * bootChain's answer too: the takeover renders on its own turn in the boot
 * chain, like every other gate.
 */
export function HelloCodexHost({ gatesClear, takeoverTurn, onStartSession }: {
  gatesClear: boolean
  takeoverTurn: boolean
  onStartSession: () => void
}) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const seen = useAppMetaStore((s) => s.meta.helloCodexSeenVersion)
  const overlays = usePaneOcclusionStore((s) => s.overlays)
  const open = useHelloCodexStore((s) => s.open)
  const due = helloCodexDue(snapshot, { helloCodexSeenVersion: seen })

  useEffect(() => {
    if (helloCodexTakeoverReady({ due, open, gatesClear, overlays })) useHelloCodexStore.getState().openTakeover()
  }, [due, open, gatesClear, overlays])

  const close = () => useHelloCodexStore.getState().close()
  if (!helloCodexShowing(open, takeoverTurn)) return null
  if (open === 'replay') return <HelloCodexTakeover replay onClose={close} onStartSession={onStartSession} />
  return <HelloCodexTakeover onClose={close} onStartSession={onStartSession} />
}

/** Is the takeover or a replay on screen? HelloCodexHost's render rule: a
 *  replay whenever one is open, the takeover on its turn in the boot chain.
 *  App makes the app behind it inert on exactly this, so the two can never
 *  disagree. */
export function helloCodexShowing(open: HelloCodexOpen, takeoverTurn: boolean): boolean {
  return open === 'replay' || (open === 'takeover' && takeoverTurn)
}

/**
 * "Start a Codex session" from any of the three places, held while the
 * resume prompt waits for an answer: New saved config outranks the resume
 * prompt in the boot chain, and a launch would autosave over the restore set
 * the user has not answered yet (the upgrader's hand-off run can end with
 * saved sessions waiting). Returns the request; `start` runs once the prompt
 * is answered or dismissed.
 */
export function useHeldCodexSessionStart(resumePending: boolean, start: () => void): () => void {
  const [held, setHeld] = useState(false)
  const startRef = useRef(start)
  startRef.current = start
  const pendingRef = useRef(resumePending)
  pendingRef.current = resumePending
  useEffect(() => {
    if (held && !resumePending) {
      setHeld(false)
      startRef.current()
    }
  }, [held, resumePending])
  return useCallback(() => {
    if (pendingRef.current) setHeld(true)
    else startRef.current()
  }, [])
}
