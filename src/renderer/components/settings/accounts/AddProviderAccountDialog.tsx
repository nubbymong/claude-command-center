// WP2 commit 6: the two sign-in dialogs of the Accounts surface.
//
// Add account (design 9.3, 12) follows the main process's own steps:
// beginSetup reserves the account and its folder, signIn runs the
// provider's own sign-in there, completeSetup names it. Leaving before
// completeSetup abandons the setup, so nothing half-made stays behind.
//
// Sign in again re-signs an existing managed account in its own realm,
// after the user confirms it is the same account as before.
//
// Both share one sign-in run (useSignInRun): leaving (Cancel, Escape, the
// close glyph, or the dialog going away) stops a running sign-in, waits for
// anything still in flight, and only then undoes what is left. After every
// await the dialog checks whether it is leaving and stops there: a setup
// created while leaving is abandoned, and a key whose handle arrives while
// leaving is never sent.
//
// The API key: typed into an uncontrolled password field, so it is never in
// React state. It is read and cleared in one step, a handle is issued, and
// the key goes one way through `sendSecret`, bound to that handle. It is not
// logged, not stored, and no other call carries it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AccountView, AccountsFailure, AccountsResult, KnownAuthState, ProviderInstallationView, PendingSetupView, SignInMethod, SignInRequest, SetupIdentityChoice,
} from '../../../../shared/providers'
import { SIGN_IN_METHODS } from '../../../../shared/providers'
import { IDENTITY_COLOR_KEYS, resolveIdentityColor, type IdentityColorKey } from '../../../../shared/identity-colors'
import {
  useProviderAccountsStore, providerAccountActions, accountDisplayName, signInAgainFailureText, signInAgainMethods,
} from '../../../stores/providerAccountsStore'
import { useResolvedTheme } from '../../../hooks/useThemeController'
import {
  DialogHeader, DialogBody, DialogFooter, DialogButton, DialogCallout, useDialogEscape,
  DIALOG_INPUT_CLASS, DIALOG_INPUT_STYLE, DIALOG_LABEL_CLASS, DIALOG_LABEL_STYLE, DIALOG_HINT_CLASS, DIALOG_HINT_STYLE,
} from '../../ui/Dialog'
import { Pill, AccountsModal } from './accounts-ui'

const MAX_LINES = 200
const URL_RE = /https?:\/\/[^\s"'<>]+/g
// A device code as CLIs print it: groups of capitals and digits joined by
// hyphens ("ABCD-EFGH"). Only ever read from the output, never made up.
const CODE_RE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/g

function lastMatch(lines: string[], re: RegExp): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re)
    if (m && m.length) return m[m.length - 1]
  }
  return undefined
}

/** A sign-in method as a choice names it ("Sign in with ChatGPT", "opens
 *  your browser"). Onboarding's Codex setup page offers the same choices. */
export function methodCopy(provider: Pick<ProviderInstallationView, 'providerId' | 'displayName'>, method: SignInMethod): { title: string; sub: string } {
  switch (method) {
    case 'browser': return { title: provider.providerId === 'codex' ? 'Sign in with ChatGPT' : 'Sign in with your browser', sub: 'opens your browser' }
    case 'device': return { title: 'Use a device code', sub: 'for a browser on another device' }
    case 'apiKey': return { title: 'Use an API key', sub: `the key goes to ${provider.displayName}; this app never stores it` }
  }
}

const isSignInMethod = (m: string): m is SignInMethod => (SIGN_IN_METHODS as readonly string[]).includes(m)

// ---------------------------------------------------------------------------
// The shared sign-in run
// ---------------------------------------------------------------------------

type SignInAnswer = AccountsResult<{ state: KnownAuthState }>

interface SignInRun {
  /** The account being signed in; set as soon as the main process names it. */
  accountIdRef: React.MutableRefObject<string | null>
  lines: string[]
  /** True once leaving has begun or the dialog is gone: stop, whatever
   *  the answer was. */
  closing: () => boolean
  /** The dialog is leaving (for its "Stopping..." state). */
  leaving: boolean
  /** Register an operation that leaving must wait for. */
  track: <T>(op: Promise<T>) => Promise<T>
  /** Run the sign-in; null when leaving by the time it answers. */
  start: (method: SignInMethod, secretHandle?: string) => Promise<SignInAnswer | null>
  /** Read and clear the key field, get a handle, send the key one way.
   *  Null when there is nothing to send or the dialog is leaving: the key is
   *  then dropped, never sent. */
  sendKey: (input: HTMLInputElement | null) => Promise<{ ok: true; handle: string } | AccountsFailure | null>
  /** Leave: stop, wait, undo, then close. */
  exit: () => Promise<void>
  /** The work is done (nothing to undo): close. */
  done: () => void
}

function useSignInRun(opts: {
  initialAccountId: string | null
  run: (req: SignInRequest) => Promise<SignInAnswer>
  /** Undo what leaving before completion leaves behind (a new setup). */
  abandon?: (accountId: string) => Promise<unknown>
  onClose: () => void
}): SignInRun {
  const accountIdRef = useRef<string | null>(opts.initialAccountId)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const [lines, setLines] = useState<string[]>([])
  const [leaving, setLeaving] = useState(false)
  const closingRef = useRef(false)
  const completedRef = useRef(false)
  const runningRef = useRef<Promise<unknown> | null>(null)
  const pendingRef = useRef(new Set<Promise<unknown>>())
  const mountedRef = useRef(false)

  // Sign-in output for this account only: the output is for whoever
  // started the sign-in, and nobody else shows it.
  useEffect(() => {
    const off = window.electronAPI.providerAccounts.onSignInOutput((ev) => {
      if (ev.accountId !== accountIdRef.current) return
      setLines((prev) => [...prev, ...ev.text.split(/\r?\n/).filter((l) => l.trim() !== '')].slice(-MAX_LINES))
    })
    return () => { off() }
  }, [])

  // Leaving, or no longer mounted (the page went away without Cancel; the
  // deferred cleanup below has not run yet): either way, stop.
  const gone = useCallback(() => closingRef.current || !mountedRef.current, [])
  const closing = gone

  const track = useCallback(<T,>(op: Promise<T>): Promise<T> => {
    pendingRef.current.add(op)
    void op.finally(() => { pendingRef.current.delete(op) })
    return op
  }, [])

  const cleanup = useCallback(async () => {
    const running = runningRef.current
    if (running && accountIdRef.current) {
      await providerAccountActions.cancelSignIn(accountIdRef.current)
      await running.catch(() => undefined)
    }
    // Whatever was in flight answers first (a setup it created is named in
    // accountIdRef by its caller before this continues).
    await Promise.allSettled([...pendingRef.current])
    const id = accountIdRef.current
    const abandon = optsRef.current.abandon
    if (abandon && id && !completedRef.current) await abandon(id)
  }, [])

  const start = useCallback(async (method: SignInMethod, secretHandle?: string): Promise<SignInAnswer | null> => {
    const accountId = accountIdRef.current
    if (!accountId || gone()) return null
    setLines([])
    const running = optsRef.current.run(secretHandle !== undefined ? { accountId, method, secretHandle } : { accountId, method })
    runningRef.current = running
    const r = await running
    if (runningRef.current === running) runningRef.current = null
    return gone() ? null : r
  }, [gone])

  const sendKey = useCallback(async (input: HTMLInputElement | null) => {
    const accountId = accountIdRef.current
    if (!input || !accountId || gone()) return null
    // Read and clear at once: from here the field is empty and the key
    // lives only in this function until it is sent.
    const secret = input.value
    input.value = ''
    if (!secret) return null
    const h = await track(providerAccountActions.issueSecretHandle(accountId))
    if (gone()) return null
    if (!h.ok) return h
    window.electronAPI.providerAccounts.sendSecret({ handle: h.handle, secret })
    return h
  }, [track, gone])

  const exit = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    setLeaving(true)
    await cleanup()
    optsRef.current.onClose()
  }, [cleanup])

  const done = useCallback(() => {
    completedRef.current = true
    if (closingRef.current) return // leaving already: it closes
    closingRef.current = true
    optsRef.current.onClose()
  }, [])

  // The dialog going away without an explicit exit (the page went away)
  // cleans up too. Deferred a tick so StrictMode's simulated remount in
  // development, which sets mountedRef again at once, never does.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      setTimeout(() => {
        if (mountedRef.current || closingRef.current) return
        closingRef.current = true
        void cleanup()
      }, 0)
    }
  }, [cleanup])

  return { accountIdRef, lines, closing, leaving, track, start, sendKey, exit, done }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The API key field. Uncontrolled: the key is never React state; the run
 *  reads and clears it through `inputRef` in one step. */
function KeyField({ prefix, inputRef, providerName, onHasKey, onSubmit }: {
  prefix: string
  inputRef: React.RefObject<HTMLInputElement | null>
  providerName: string
  onHasKey: (has: boolean) => void
  onSubmit: () => void
}) {
  return (
    <div data-testid={`${prefix}-step-key`}>
      <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE} htmlFor={`${prefix}-key`}>API key</label>
      <input
        id={`${prefix}-key`}
        ref={inputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className={DIALOG_INPUT_CLASS}
        style={DIALOG_INPUT_STYLE}
        onInput={(e) => onHasKey((e.currentTarget as HTMLInputElement).value.length > 0)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit() } }}
        data-autofocus=""
        data-testid={`${prefix}-key`}
      />
      <p className={DIALOG_HINT_CLASS} style={DIALOG_HINT_STYLE}>The key goes straight to {providerName}. This app never stores it.</p>
    </div>
  )
}

/** A running sign-in: the login URL and device code when the output carries
 *  them, and the output itself. */
function SignInProgress({ prefix, lines, method, providerName }: { prefix: string; lines: string[]; method: SignInMethod | null; providerName: string }) {
  const url = lastMatch(lines, URL_RE)
  const code = method === 'device' ? lastMatch(lines, CODE_RE) : undefined
  return (
    <div className="space-y-3" data-testid={`${prefix}-step-signing-in`}>
      <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Waiting for the sign-in to finish...</div>
      {(url || code) && (
        <div className="rounded-[9px] border px-3 py-2.5 space-y-1.5" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-base)' }} data-testid={`${prefix}-prompt`}>
          {url && (
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Open <span className="font-mono select-all break-all" style={{ color: 'var(--text-primary)' }} data-testid={`${prefix}-url`}>{url}</span>
            </div>
          )}
          {code && (
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              and enter <span className="font-mono text-[16px] font-semibold tracking-wider select-all" style={{ color: 'var(--text-primary)' }} data-testid={`${prefix}-code`}>{code}</span>
            </div>
          )}
        </div>
      )}
      <pre
        className="max-h-40 overflow-auto rounded-[8px] border px-2.5 py-2 text-[11px] leading-snug whitespace-pre-wrap break-words font-mono"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-sunken)', color: 'var(--text-secondary)' }}
        data-testid={`${prefix}-log`}
      >
        {lines.length ? lines.join('\n') : `Starting ${providerName}...`}
      </pre>
    </div>
  )
}

function MethodChoice({ provider, method, testId, onClick, selected, disabled, autoFocus, recorded }: {
  provider: ProviderInstallationView
  method: SignInMethod
  testId: string
  onClick: () => void
  /** Present when the choice is a radio (Sign in again); absent for a button. */
  selected?: boolean
  disabled?: boolean
  autoFocus?: boolean
  recorded?: boolean
}) {
  const copy = methodCopy(provider, method)
  const radio = selected !== undefined
  return (
    <button
      type="button"
      role={radio ? 'radio' : undefined}
      aria-checked={radio ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      className="w-full text-left rounded-[9px] border px-3.5 py-2 flex flex-col gap-px focus-ring transition-colors hover:bg-[var(--surface-overlay)] disabled:opacity-40"
      style={{
        borderColor: selected ? 'var(--brand)' : 'var(--border-strong)',
        background: selected ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'transparent',
        color: 'var(--text-primary)',
      }}
      data-autofocus={autoFocus ? '' : undefined}
      data-testid={testId}
    >
      <span className="text-[13px] font-semibold inline-flex items-center gap-2">
        {copy.title}
        {provider.signInMethods[method].labelExperimental && <Pill tone="warn">Experimental</Pill>}
        {recorded && <Pill tone="muted">Used before</Pill>}
      </span>
      <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{copy.sub}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------

export interface AddProviderAccountDialogProps {
  provider: ProviderInstallationView
  /** Continue an interrupted setup instead of starting a new one. */
  resume?: PendingSetupView
  /** Start straight away with this method, chosen on the page that opened
   *  the dialog (onboarding's Codex setup). */
  initialMethod?: SignInMethod
  /** The overlay's stacking class, over a surface above the usual dialogs. */
  overlayZ?: string
  onClose: () => void
}

type Step = 'method' | 'key' | 'signing-in' | 'failed' | 'name'

export function AddProviderAccountDialog({ provider, resume, initialMethod, overlayZ, onClose }: AddProviderAccountDialogProps) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const theme = useResolvedTheme()
  const resumeMethod = resume && isSignInMethod(resume.method) ? resume.method : null

  const initialStep: Step = !resume ? 'method' : resume.state === 'credentials-written' ? 'name' : resumeMethod === 'apiKey' ? 'key' : 'signing-in'
  const [step, setStep] = useState<Step>(initialStep)
  const [method, setMethod] = useState<SignInMethod | null>(resumeMethod)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [identityMode, setIdentityMode] = useState<'new' | 'link'>('new')
  const [name, setName] = useState('')
  const [linkId, setLinkId] = useState('')
  const keyRef = useRef<HTMLInputElement>(null)
  const autoStartedRef = useRef(false)

  const runner = useSignInRun({
    initialAccountId: resume?.accountId ?? null,
    run: providerAccountActions.signIn,
    abandon: providerAccountActions.abandonSetup,
    onClose,
  })

  const identities = snapshot?.identities ?? []
  const usedColours = useMemo(() => new Set(identities.map((i) => i.colourKey)), [identities])
  const [colour, setColour] = useState<IdentityColorKey>(() => IDENTITY_COLOR_KEYS.find((k) => !usedColours.has(k)) ?? IDENTITY_COLOR_KEYS[0])

  // Identities a new account may join: those of vouched-for, non-archived
  // accounts (an unverified or external sign-in keeps its own identity).
  const linkable = useMemo(() => {
    const accounts = snapshot?.accounts ?? []
    return identities
      .map((i) => {
        const holders = accounts.filter((a) => a.identityId === i.id && a.lifecycle !== 'archived' && !a.unverified && !a.external)
        if (holders.length === 0) return null
        return { id: i.id, label: accountDisplayName(snapshot, holders[0]) }
      })
      .filter((x): x is { id: string; label: string } => x !== null)
  }, [identities, snapshot])

  const startSignIn = useCallback(async (m: SignInMethod, secretHandle?: string) => {
    setError(null)
    setStep('signing-in')
    const r = await runner.start(m, secretHandle)
    if (!r) return
    if (r.ok && r.state === 'signed-in') { setStep('name'); return }
    setError(r.ok ? 'The sign-in did not finish. Try again, or cancel.' : r.message)
    setStep('failed')
  }, [runner.start])

  // Resuming a browser or device sign-in starts it straight away (once:
  // StrictMode runs effects twice in development).
  useEffect(() => {
    if (autoStartedRef.current) return
    autoStartedRef.current = true
    if (resume && resume.state !== 'credentials-written' && resumeMethod && resumeMethod !== 'apiKey') void startSignIn(resumeMethod)
  }, [resume, resumeMethod, startSignIn])

  useDialogEscape(() => { void runner.exit() }, !runner.leaving)

  const chooseMethod = async (m: SignInMethod) => {
    setBusy(true)
    setError(null)
    const r = await runner.track(providerAccountActions.beginSetup({ providerId: provider.providerId, method: m }))
    // Named at once, so leaving can abandon a setup created meanwhile.
    if (r.ok) runner.accountIdRef.current = r.accountId
    if (runner.closing()) return
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setMethod(m)
    if (m === 'apiKey') setStep('key')
    else void startSignIn(m)
  }

  const submitKey = async () => {
    setHasKey(false)
    setBusy(true)
    setError(null)
    const h = await runner.sendKey(keyRef.current)
    if (runner.closing()) return
    setBusy(false)
    if (!h) return
    if (!h.ok) { setError(`${h.message} Enter the key again.`); return }
    void startSignIn('apiKey', h.handle)
  }

  const retry = () => {
    if (!method) return
    if (method === 'apiKey') { setError(null); setStep('key') }
    else void startSignIn(method)
  }

  const finish = async () => {
    const accountId = runner.accountIdRef.current
    if (!accountId) return
    const identity: SetupIdentityChoice = identityMode === 'link' && linkId
      ? { mode: 'link', identityId: linkId }
      : { mode: 'new', colourKey: colour, ...(name.trim() ? { friendlyName: name.trim() } : {}) }
    setBusy(true)
    setError(null)
    const r = await runner.track(providerAccountActions.completeSetup({ accountId, identity }))
    if (r.ok) { runner.done(); return }
    if (runner.closing()) return
    setBusy(false)
    setError(r.message)
  }

  const methods = SIGN_IN_METHODS.filter((m) => provider.signInMethods[m]?.enabled)

  // A method chosen on the page that opened the dialog starts at once (once:
  // StrictMode runs effects twice in development). Only an enabled method.
  const initialStartedRef = useRef(false)
  useEffect(() => {
    if (initialStartedRef.current || resume || !initialMethod) return
    initialStartedRef.current = true
    if (provider.signInMethods[initialMethod]?.enabled) void chooseMethod(initialMethod)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AccountsModal labelledBy="add-account-title" width="w-[520px]" testId="add-account-dialog" overlayTestId="add-account-overlay" focusKey={runner.leaving ? 'leaving' : step} z={overlayZ}>
      <DialogHeader title={`Add ${provider.displayName} account`} titleId="add-account-title" onClose={() => { void runner.exit() }} closeTestId="add-account-close" />
      <DialogBody>
        {runner.leaving ? (
          <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Stopping...</div>
        ) : (
          <>
            {step === 'method' && (
              <div className="space-y-2" data-testid="add-account-step-method">
                <div className="text-[12.5px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Sign in to a new {provider.displayName} account</div>
                {methods.length === 0 && <DialogCallout tone="warning">No sign-in method is available for {provider.displayName} here.</DialogCallout>}
                {methods.map((m, i) => (
                  <MethodChoice key={m} provider={provider} method={m} testId={`add-account-method-${m}`} disabled={busy} autoFocus={i === 0} onClick={() => { void chooseMethod(m) }} />
                ))}
              </div>
            )}

            {step === 'key' && (
              <KeyField prefix="add-account" inputRef={keyRef} providerName={provider.displayName} onHasKey={setHasKey} onSubmit={() => { void submitKey() }} />
            )}

            {step === 'signing-in' && <SignInProgress prefix="add-account" lines={runner.lines} method={method} providerName={provider.displayName} />}

            {step === 'failed' && (
              <div data-testid="add-account-step-failed">
                <DialogCallout tone="warning">{error ?? 'The sign-in did not finish.'}</DialogCallout>
              </div>
            )}

            {step === 'name' && (
              <div className="space-y-3" data-testid="add-account-step-name">
                <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Signed in. Name this account so you can tell it apart.</div>
                <label className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
                  <input type="radio" name="add-account-identity" checked={identityMode === 'new'} onChange={() => setIdentityMode('new')} data-testid="add-account-identity-new" />
                  A new name
                </label>
                {identityMode === 'new' && (
                  <div className="pl-6 space-y-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="For example, Work"
                      maxLength={120}
                      className={DIALOG_INPUT_CLASS}
                      style={DIALOG_INPUT_STYLE}
                      aria-label="Account name"
                      data-autofocus=""
                      data-testid="add-account-name"
                    />
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
                      {IDENTITY_COLOR_KEYS.map((k) => {
                        const hex = resolveIdentityColor(k, theme)
                        const on = k === colour
                        return (
                          <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={`Colour ${k}`}
                            title={k}
                            onClick={() => setColour(k)}
                            className="w-4 h-4 rounded-full focus-ring"
                            style={{ backgroundColor: hex, outline: on ? `2px solid ${hex}` : undefined, outlineOffset: on ? '2px' : undefined }}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}
                {linkable.length > 0 && (
                  <>
                    <label className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
                      <input type="radio" name="add-account-identity" checked={identityMode === 'link'} onChange={() => { setIdentityMode('link'); if (!linkId) setLinkId(linkable[0].id) }} data-testid="add-account-identity-link" />
                      The same person as an existing account
                    </label>
                    {identityMode === 'link' && (
                      <div className="pl-6">
                        <select
                          value={linkId}
                          onChange={(e) => setLinkId(e.target.value)}
                          className={DIALOG_INPUT_CLASS}
                          style={DIALOG_INPUT_STYLE}
                          aria-label="Existing account"
                          data-testid="add-account-link-select"
                        >
                          {linkable.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {error && step !== 'failed' && <div className="mt-3"><DialogCallout tone="danger" role="alert" testId="add-account-error">{error}</DialogCallout></div>}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={() => { void runner.exit() }} disabled={runner.leaving} testId="add-account-cancel" data-autofocus={step === 'signing-in' ? '' : undefined}>Cancel</DialogButton>
        {!runner.leaving && step === 'key' && (
          <DialogButton variant="primary" onClick={() => { void submitKey() }} disabled={busy || !hasKey} testId="add-account-key-continue">Continue</DialogButton>
        )}
        {!runner.leaving && step === 'failed' && method && (
          <DialogButton variant="primary" onClick={retry} testId="add-account-retry" data-autofocus="">Try again</DialogButton>
        )}
        {!runner.leaving && step === 'name' && (
          <DialogButton variant="primary" onClick={() => { void finish() }} disabled={busy || (identityMode === 'link' && !linkId)} testId="add-account-finish">Add account</DialogButton>
        )}
      </DialogFooter>
    </AccountsModal>
  )
}

// ---------------------------------------------------------------------------
// Sign in again
// ---------------------------------------------------------------------------

export interface SignInAgainDialogProps {
  provider: ProviderInstallationView
  account: AccountView
  /** The account's name as its row shows it. */
  name: string
  onClose: () => void
}

type AgainStep = 'method' | 'key' | 'signing-in' | 'failed'

/**
 * "Sign in again" for an existing managed account (signed out, expired, or
 * not checked): its recorded method family only, in the account's own
 * realm, after the user confirms it is the same account as before. Nothing
 * runs and no key is taken until that box is ticked. On success the dialog
 * closes and the pushed snapshot updates the row; an answer that blocked
 * the account (a different sign-in) does not close as a success.
 */
export function SignInAgainDialog({ provider, account, name, onClose }: SignInAgainDialogProps) {
  const { methods, preselected } = signInAgainMethods(provider, account)
  const [step, setStep] = useState<AgainStep>('method')
  const [method, setMethod] = useState<SignInMethod | null>(preselected)
  // The user's explicit yes that this is the same account as before: no
  // sign-in runs, and no key is taken, until it is given (a different
  // account signing in here would block this one until it is confirmed).
  const [sameAccount, setSameAccount] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const keyRef = useRef<HTMLInputElement>(null)

  const runner = useSignInRun({ initialAccountId: account.id, run: providerAccountActions.signInAgain, onClose })

  useDialogEscape(() => { void runner.exit() }, !runner.leaving)

  const start = async (m: SignInMethod, secretHandle?: string) => {
    if (!sameAccount) return
    setError(null)
    setStep('signing-in')
    const r = await runner.start(m, secretHandle)
    if (!r) return
    if (r.ok && r.state === 'signed-in') { runner.done(); return }
    setError(r.ok ? 'Still not signed in. Try again, or cancel.' : signInAgainFailureText(r))
    setStep('failed')
  }

  const proceed = () => {
    if (!method || !sameAccount) return
    if (method === 'apiKey') { setError(null); setStep('key') }
    else void start(method)
  }

  const submitKey = async () => {
    if (!sameAccount) return
    setHasKey(false)
    setBusy(true)
    setError(null)
    const h = await runner.sendKey(keyRef.current)
    if (runner.closing()) return
    setBusy(false)
    if (!h) return
    if (!h.ok) { setError(`${signInAgainFailureText(h)} Enter the key again.`); return }
    void start('apiKey', h.handle)
  }

  return (
    <AccountsModal labelledBy="sign-in-again-title" width="w-[520px]" testId="sign-in-again-dialog" overlayTestId="sign-in-again-overlay" focusKey={runner.leaving ? 'leaving' : step}>
      <DialogHeader title={`Sign in to ${name} again`} titleId="sign-in-again-title" onClose={() => { void runner.exit() }} closeTestId="sign-in-again-close" />
      <DialogBody>
        {runner.leaving ? (
          <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>Stopping...</div>
        ) : (
          <>
            {step === 'method' && (
              <div className="space-y-2" data-testid="sign-in-again-step-method">
                <div className="rounded-[9px] border px-3 py-2.5 mb-1" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-base)' }} data-testid="sign-in-again-who">
                  <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{name}</div>
                  {account.providerLabel && <div className="font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>{account.providerLabel}</div>}
                  <label className="flex items-start gap-2 mt-2.5 text-[12.5px] cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                    <input
                      type="checkbox"
                      checked={sameAccount}
                      onChange={(e) => setSameAccount(e.target.checked)}
                      className="mt-0.5"
                      data-autofocus=""
                      data-testid="sign-in-again-confirm"
                    />
                    <span>
                      <span data-testid="sign-in-again-confirm-label">{account.providerLabel ? `Sign in to the same account as before (${account.providerLabel}).` : 'Sign in to the same account as before.'}</span>
                      <span className="block text-[11.5px] mt-0.5" style={{ color: 'var(--text-muted)' }}>A different account is blocked until you confirm it in Accounts.</span>
                    </span>
                  </label>
                </div>
                {methods.length === 0 && <DialogCallout tone="warning">No sign-in method for this account is available here.</DialogCallout>}
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Sign-in method">
                  {methods.map((m) => (
                    <MethodChoice
                      key={m}
                      provider={provider}
                      method={m}
                      testId={`sign-in-again-method-${m}`}
                      selected={m === method}
                      recorded={m === account.authMethod}
                      onClick={() => setMethod(m)}
                    />
                  ))}
                </div>
              </div>
            )}
            {step === 'key' && (
              <KeyField prefix="sign-in-again" inputRef={keyRef} providerName={provider.displayName} onHasKey={setHasKey} onSubmit={() => { void submitKey() }} />
            )}
            {step === 'signing-in' && <SignInProgress prefix="sign-in-again" lines={runner.lines} method={method} providerName={provider.displayName} />}
            {step === 'failed' && <DialogCallout tone="warning" role="alert" testId="sign-in-again-error">{error ?? 'The sign-in did not finish.'}</DialogCallout>}
            {error && step !== 'failed' && <div className="mt-3"><DialogCallout tone="danger" role="alert" testId="sign-in-again-error">{error}</DialogCallout></div>}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={() => { void runner.exit() }} disabled={runner.leaving} testId="sign-in-again-cancel" data-autofocus={step === 'signing-in' ? '' : undefined}>Cancel</DialogButton>
        {!runner.leaving && step === 'method' && (
          <DialogButton variant="primary" onClick={proceed} disabled={!method || !sameAccount} testId="sign-in-again-continue">{method === 'apiKey' ? 'Continue' : 'Sign in'}</DialogButton>
        )}
        {!runner.leaving && step === 'key' && (
          <DialogButton variant="primary" onClick={() => { void submitKey() }} disabled={busy || !hasKey} testId="sign-in-again-key-continue">Continue</DialogButton>
        )}
        {!runner.leaving && step === 'failed' && (
          <DialogButton variant="primary" onClick={() => setStep('method')} testId="sign-in-again-retry" data-autofocus="">Try again</DialogButton>
        )}
      </DialogFooter>
    </AccountsModal>
  )
}
