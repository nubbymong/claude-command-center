import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AccountsResult, AccountsSnapshot, AccountView, InstallRecipeView, KnownAuthState, ProviderInstallationView, SignInMethod } from '../../shared/providers'
import { SIGN_IN_METHODS } from '../../shared/providers'
import {
  useProviderAccountsStore, providerAccountActions, providerView, selectProviderAccounts, accountDisplayName, providerAnsweredOn,
} from '../stores/providerAccountsStore'
import { AddProviderAccountDialog, methodCopy } from '../components/settings/accounts/AddProviderAccountDialog'
import { openCommandTerminal } from '../utils/commandTerminal'
import { useSessionStore } from '../stores/sessionStore'

const CHECK = String.fromCodePoint(0x2713)

/** Above the onboarding root (z-index 100), so the add-account dialog it
 *  opens is not painted underneath the page. */
const OVER_ONBOARDING = 'z-[110]'

type Installation =
  | { kind: 'unavailable' }
  | { kind: 'checking' }
  | { kind: 'missing'; text: string }
  | { kind: 'update'; text: string }
  | { kind: 'usable'; version?: string; tooNew: boolean }

/** What the page can say about the Codex CLI, from main's discovery only. The
 *  snapshot does not carry the minimum version, so a too-old CLI is named by
 *  its own version and never by the one it falls short of. */
export function codexInstallation(p: ProviderInstallationView | undefined): Installation {
  if (!p) return { kind: 'unavailable' }
  switch (p.discoveryState) {
    case 'unchecked': return { kind: 'checking' }
    case 'missing': return { kind: 'missing', text: 'Codex CLI not found' }
    case 'invalid': return { kind: 'missing', text: 'Codex was found but did not run as expected' }
    case 'error': return { kind: 'missing', text: 'Codex could not be checked' }
    case 'found':
    default: {
      const named = p.version ? `Codex ${p.version}` : 'Codex'
      switch (p.compatibility) {
        case 'supported': return { kind: 'usable', version: p.version, tooNew: false }
        case 'too-new': return { kind: 'usable', version: p.version, tooNew: true }
        case 'too-old': return { kind: 'update', text: `${named} found; it is too old for this app` }
        case 'unsupported': return { kind: 'update', text: `${named} found; this app does not support it` }
        default: return { kind: 'update', text: 'Codex found, but its version could not be read' }
      }
    }
  }
}

/** Codex accounts that are signed in and usable now. */
export function signedInCodexAccounts(snapshot: AccountsSnapshot | null): AccountView[] {
  return selectProviderAccounts(snapshot, 'codex').filter(
    (a) => a.lifecycle === 'active' && a.lastKnownAuthState === 'signed-in' && a.operationalState !== 'blocked',
  )
}

/**
 * Whether anything stands for this computer's own Codex sign-in (~/.codex).
 * The app never takes it in on its own (owner decision 2026-09-26): only the
 * user's "Use this sign-in" does, which asks Codex for the home's status and
 * registers it only when it is signed in (adoptExternal).
 *
 *   - absent: the snapshot names no such sign-in (no account list yet).
 *   - in-use: an account stands for it now, or a setup of it is pending.
 *   - free: nothing does. The page asks Codex whether it is signed in,
 *     without taking it in (probeExternal), before it offers it; and it asks
 *     whatever an earlier answer recorded. That answer is history (the home
 *     may be signed out since, its account archived), and the page says
 *     "already signed in" only when Codex says so now (U2).
 */
export type ThisComputerSignIn = { kind: 'absent' } | { kind: 'in-use' } | { kind: 'free' }

export function thisComputerSignIn(snapshot: AccountsSnapshot | null): ThisComputerSignIn {
  const ext = snapshot?.externalDefaults.find((e) => e.providerId === 'codex')
  if (!snapshot || !ext) return { kind: 'absent' }
  const standsFor = snapshot.accounts.some((a) => a.providerId === 'codex' && a.external && a.lifecycle !== 'archived')
  if (standsFor || snapshot.pendingSetups.some((s) => s.providerId === 'codex' && s.external)) return { kind: 'in-use' }
  return { kind: 'free' }
}

/** What the page's read-only check found (probeExternal), as the page acts
 *  on it: signed-in and signed-out are Codex's answer; no-home, there is no
 *  Codex sign-in folder there at all; overlap, the folder overlaps this app's
 *  own account folders, so it cannot be used here; unusable, Codex cannot
 *  check or use it here (the check is not enabled, Codex is not on or not
 *  set up, the app could not read whether it is on, or it has no such
 *  sign-in: "Use this sign-in" would be refused too); unknown, no answer (it timed out, did not start, or
 *  Codex could not say), so the page offers it without the claim. */
export type ThisComputerCheck = 'signed-in' | 'signed-out' | 'no-home' | 'overlap' | 'unusable' | 'unknown'

export function thisComputerCheck(r: AccountsResult<{ state: KnownAuthState }>): ThisComputerCheck {
  if (r.ok) return r.state === 'signed-in' ? 'signed-in' : r.state === 'signed-out' || r.state === 'expired' ? 'signed-out' : 'unknown'
  switch (r.code) {
    case 'realm-unavailable': return 'no-home'
    case 'external-overlap': return 'overlap'
    case 'capability-disabled':
    case 'provider-disabled':
    case 'provider-not-set-up':
    case 'provider-state-unknown':
    case 'unsupported': return 'unusable'
    default: return 'unknown'
  }
}

/** Said when the check finds the folder overlaps this app's own: the words
 *  Settings, Accounts uses for it. */
const OVERLAP_NOTE = "This computer's Codex folder overlaps this app's own account folders, so it cannot be used here."

/** The newer of two answers for the same provider: main pushes a snapshot
 *  after each check, but the check's own answer can arrive first. */
function newer(a: ProviderInstallationView | undefined, b: ProviderInstallationView | undefined): ProviderInstallationView | undefined {
  if (!a) return b
  if (!b) return a
  return (b.lastCheckedAt ?? 0) > (a.lastCheckedAt ?? 0) ? b : a
}

function CheckRow({ tone, children, testId }: { tone: 'ok' | 'warn' | 'pending'; children: ReactNode; testId?: string }) {
  return (
    <div className="checkrow" data-testid={testId}>
      <div className={tone === 'ok' ? 'badge ok' : tone === 'warn' ? 'badge warn' : 'badge pending'}>{tone === 'ok' ? CHECK : '!'}</div>
      <div className="nm">{children}</div>
    </div>
  )
}

function sourceLine(r: InstallRecipeView): string {
  return /readme/i.test(r.sourceUrl) ? `From ${r.publisher}'s README` : `From ${r.publisher}`
}

const SCRIPT_NOTE = 'Shown for you to review and run yourself; the app does not run it.'

/** The terminal tab this page last opened for a recipe. Held for the
 *  renderer's lifetime, not the page's, so a page shown again (Back, then
 *  Next) still knows that install is running while its tab is open. */
let openedTab: { id: string; label: string } | null = null

/**
 * One recipe. Whether it may run is main's decision, not this page's: main
 * sends `runLine` only for a recipe it allows to run, built for this
 * computer's terminal shell, and "Run in a terminal" types exactly that line.
 * Without it the recipe is Copy only. What is shown and copied is always the
 * provider's documented command, verbatim.
 */
function Recipe({ recipe, onRun, busyReason }: {
  recipe: InstallRecipeView
  onRun: (r: InstallRecipeView & { runLine: string }) => void
  /** Why Run is unavailable right now (a tab this page opened is still open). */
  busyReason?: string
}) {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const runLine = recipe.runLine
  const runnable = typeof runLine === 'string' && runLine.length > 0
  const note = recipe.note ?? (runnable ? undefined : SCRIPT_NOTE)
  const copy = () => {
    void navigator.clipboard?.writeText(recipe.displayCommand).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* clipboard blocked: the command is selectable */ })
  }
  return (
    <div className="cx-recipe" data-testid={`codex-recipe-${recipe.id}`}>
      <div className="cx-cmd">
        <code className="select-all" data-testid={`codex-recipe-command-${recipe.id}`}>{recipe.displayCommand}</code>
        {runnable ? (
          <button
            className="cx-btn"
            type="button"
            onClick={() => setConfirming(true)}
            disabled={confirming || !!busyReason}
            title={busyReason}
            data-autofocus=""
            data-testid={`codex-recipe-run-${recipe.id}`}
          >
            Run in a terminal
          </button>
        ) : (
          <button className="cx-btn" type="button" onClick={copy} data-autofocus="" data-testid={`codex-recipe-copy-${recipe.id}`}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {note && <div className="cx-note" data-testid={`codex-recipe-note-${recipe.id}`}>{note}</div>}
      {runnable && busyReason && !confirming && (
        <div className="cx-note" data-testid={`codex-recipe-busy-${recipe.id}`}>{busyReason}</div>
      )}
      {runnable && confirming && (
        <div className="cx-confirm" role="group" aria-label="Run this command?" data-testid={`codex-recipe-confirm-${recipe.id}`}>
          <span>
            Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.
            <code className="cx-run-line" data-testid={`codex-recipe-run-line-${recipe.id}`}>{runLine}</code>
          </span>
          <span className="cx-confirm-btns">
            <button className="cx-btn" type="button" onClick={() => setConfirming(false)} data-testid={`codex-recipe-cancel-${recipe.id}`}>Cancel</button>
            <button
              className="cx-btn primary"
              type="button"
              disabled={!!busyReason}
              onClick={() => { setConfirming(false); onRun({ ...recipe, runLine }) }}
              data-testid={`codex-recipe-confirm-run-${recipe.id}`}
            >
              Run it
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function Recipes({ purpose, recipes, onRun, busyReason }: {
  purpose: 'install' | 'update'
  recipes: InstallRecipeView[] | null | undefined
  onRun: (r: InstallRecipeView & { runLine: string }) => void
  busyReason?: string
}) {
  if (recipes === undefined) return null
  const mine = (recipes ?? []).filter((r) => r.purpose === purpose)
  return (
    <div className="cx-recipes" data-testid={`codex-recipes-${purpose}`}>
      <div className="cx-recipes-h">
        <b>{purpose === 'install' ? 'Install Codex' : 'Update Codex'}</b>
        {mine[0] && <span className="cx-muted" title={mine[0].sourceUrl}>{sourceLine(mine[0])}</span>}
      </div>
      {mine.length === 0 && (
        <div className="cx-muted" data-testid="codex-recipes-none">
          {recipes === null
            ? `The ${purpose} commands could not be read.`
            : `No ${purpose} command is known for this computer.`}
        </div>
      )}
      {mine.map((r) => <Recipe key={r.id} recipe={r} onRun={onRun} busyReason={busyReason} />)}
    </div>
  )
}

/**
 * "Set up Codex" (WP2 commit 6e, canvas F2). Shown when the user chose Codex
 * on the assistants page, or answered Yes on the one-time "Do you use
 * Codex?" page after an update. Everything it says comes from main: the
 * discovery in the accounts snapshot (checked again on entry), the install
 * recipes, and what is known about this computer's own Codex sign-in.
 *
 *   - Not found: the install recipes, verbatim. A recipe main allows to run
 *     (it sends the line to type, `runLine`) runs in a visible terminal tab
 *     after the user confirms that line, one at a time; any other is shown
 *     and copied, never run. "Check again" looks again.
 *   - Too old: the version found and the update recipe.
 *   - Ready, and nothing stands for this computer's own sign-in (canvas
 *     F2 d, approved again for the update page on 2026-09-26): the page asks
 *     Codex, read-only, whether that sign-in is signed in, then offers "Use
 *     this sign-in" (as signed in only when Codex said so), or a new account
 *     of its own (Recommended). The page never registers that sign-in on its
 *     own: "Use this sign-in" asks Codex for its status and registers it only
 *     when it is signed in (owner decision 2026-09-26: the sign-in already on
 *     the computer is only ever taken in by an explicit choice). Found signed
 *     out, not there, or there but not usable here: sign in to a new Codex
 *     account through the Accounts surface's own add-account dialog, started
 *     at the chosen method, with what was found as a note.
 *   - Signed in: done, and Next continues. When the only sign-in is this
 *     computer's own (the user chose to use it), the settled canvas F2 d:
 *     it is in use, confirmed at each launch, and a new account of its own
 *     is still Recommended.
 */
export function CodexSetupStep({ onNext, onBack, stepAside, returns }: {
  onNext: () => void
  /** Absent when no page comes before this one (an upgrader handed only this
   *  page): there is then no Back button. */
  onBack?: () => void
  /** Let the terminal the page opened be seen (the harness steps aside). */
  stepAside: () => void
  /** Counts the user's returns from that terminal: each one checks again. */
  returns: number
}) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [answer, setAnswer] = useState<ProviderInstallationView | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  const [dialog, setDialog] = useState<null | { method?: SignInMethod }>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  // What the user's own "Use this sign-in" found, when it answered without
  // registering anything: the sign-in there is signed out. The page then
  // offers the new-account sign-in, with that as a note.
  const [adoptAnswer, setAdoptAnswer] = useState<'signed-out' | null>(null)
  // What the page's own read-only check of this computer's sign-in found
  // (probeExternal, thisComputerCheck): asked once when nothing stands for
  // it, and again from "Check this computer's sign-in again" once it was
  // found signed out (a new round).
  const [probe, setProbe] = useState<'idle' | 'running' | ThisComputerCheck>('idle')
  const probeAsked = useRef(false)
  const [probeRound, setProbeRound] = useState(0)
  // Set in setup as well as cleared in cleanup: StrictMode (development)
  // runs cleanup then setup again with the same refs, and a ref only ever
  // cleared would leave the page believing it had gone away.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const provider = newer(providerView(snapshot, 'codex'), answer)
  const install = codexInstallation(provider)
  const signedIn = signedInCodexAccounts(snapshot)
  const thisComputer = thisComputerSignIn(snapshot)

  const checkAgain = async () => {
    setChecking(true)
    setError(null)
    const r = await providerAccountActions.discover('codex')
    setChecking(false)
    if (r.ok) setAnswer(r.installation)
    else setError({ code: r.code, message: r.message })
  }

  // On entry, and on every return from the terminal: look again, the user
  // may have installed or updated Codex since.
  useEffect(() => {
    void checkAgain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returns])

  useEffect(() => {
    let live = true
    void providerAccountActions.installRecipes('codex').then((r) => { if (live) setRecipes(r) })
    return () => { live = false }
  }, [])

  // This computer's own Codex sign-in, when nothing stands for it: asked
  // once per round, READ-ONLY (probeExternal: Codex's status there, and
  // nothing kept), so the page can say "already signed in" only when it is,
  // and does not offer a sign-in that is not there or cannot be used. It is
  // taken in only by the user's "Use this sign-in" (owner decision
  // 2026-09-26). Only once Codex is on, as the user answered, and its CLI is
  // usable (the check runs it), and only when no Codex account is signed in
  // yet (the page is done then, and has nothing to offer).
  const canProbe = install.kind === 'usable' && providerAnsweredOn(provider)
    && thisComputer.kind === 'free' && signedIn.length === 0
  useEffect(() => {
    // The ref, read here: StrictMode runs this effect twice with the same
    // render's values, and the check must run once.
    if (!canProbe || probeAsked.current) return
    probeAsked.current = true
    setProbe('running')
    void (async () => {
      const r = await providerAccountActions.probeExternal('codex')
      // The check reserved, then released, a record for that folder: wait for
      // the snapshot that no longer carries it, so the page does not show it
      // as in use for a moment.
      await useProviderAccountsStore.getState().hydrate()
      if (!mounted.current) return
      setProbe(thisComputerCheck(r))
    })()
  }, [canProbe, probeRound])

  // One install at a time: while the tab this page opened is still open, Run
  // is off for the whole page and says where it is running.
  const [tab, setTab] = useState(openedTab)
  const tabOpen = useSessionStore((s) => !!tab && s.sessions.some((x) => x.id === tab.id))
  const busyReason = tab && tabOpen ? `Already running in the ${tab.label} tab` : undefined

  // Types main's line, exactly: the page never builds or picks what runs.
  const run = (recipe: InstallRecipeView & { runLine: string }) => {
    // Read live, not from this render: a second click that lands before the
    // page re-renders must not open a second install.
    const last = openedTab
    if (last && useSessionStore.getState().sessions.some((x) => x.id === last.id)) return
    const label = recipe.purpose === 'update' ? 'Update Codex' : 'Install Codex'
    const id = openCommandTerminal({ label, command: recipe.runLine })
    openedTab = { id, label }
    setTab(openedTab)
    stepAside()
  }

  // "Use this sign-in": the explicit adoption. Main asks Codex for the home's
  // status first, and registers it only when it is signed in
  // (adoptExternalDefault). Signed out: the page moves to the new-account
  // sign-in, saying so. Any other failure is said, and the offer stays to try
  // again.
  const adopt = async () => {
    setBusy(true)
    setError(null)
    const r = await providerAccountActions.adoptExternal('codex')
    if (!mounted.current) return
    setBusy(false)
    if (r.ok) return
    if (r.code === 'not-signed-in') { setAdoptAnswer('signed-out'); return }
    setError({ code: r.code, message: r.message })
  }

  // "Check this computer's sign-in again", once it was found signed out.
  // After the user's own "Use this sign-in" found it so, it is that choice,
  // asked again. After the page's own check found it so, it is that check,
  // asked again, read-only: a link that says "check" never takes the
  // sign-in in.
  const checkThisComputerAgain = () => {
    if (adoptAnswer === 'signed-out') { void adopt(); return }
    probeAsked.current = false
    setProbe('idle')
    setProbeRound((n) => n + 1)
  }

  const done = install.kind === 'usable' && signedIn.length > 0
  // Only this computer's shared sign-in so far: a new account of its own is
  // still the better choice, and the only one that can review code.
  const onlyShared = done && signedIn.every((a) => a.external || a.unverified)
  const methods = provider ? SIGN_IN_METHODS.filter((m) => provider.signInMethods[m]?.enabled) : []

  const addNew = (testId: string, primary: boolean) => (
    <button className="cx-opt" type="button" onClick={() => setDialog({})} disabled={busy} data-autofocus={primary ? '' : undefined} data-testid={testId}>
      <span>
        <span className="cx-opt-t">Add a new Codex account <span className="cx-rec">Recommended</span></span>
        <span className="cx-opt-d">Its own sign-in folder; can be your reviewer</span>
      </span>
      <span className="cx-chev" aria-hidden />
    </button>
  )

  let body: ReactNode
  // Which of the page's states is showing: the page's primary control (the
  // one marked data-autofocus) differs by state, so focus follows it.
  let view: string = install.kind
  if (install.kind === 'unavailable') {
    body = <p className="cx-muted" data-testid="codex-setup-unavailable">The account list is not available right now. You can set up Codex later in Settings, Accounts.</p>
  } else if (install.kind === 'checking') {
    body = <CheckRow tone="pending" testId="codex-setup-checking">Checking for the Codex CLI...</CheckRow>
  } else if (install.kind === 'missing') {
    body = (
      <div data-testid="codex-setup-missing">
        <CheckRow tone="pending" testId="codex-setup-check">{install.text}</CheckRow>
        <Recipes purpose="install" recipes={recipes} onRun={run} busyReason={busyReason} />
      </div>
    )
  } else if (install.kind === 'update') {
    body = (
      <div data-testid="codex-setup-update">
        <CheckRow tone="warn" testId="codex-setup-check">{install.text}</CheckRow>
        <Recipes purpose="update" recipes={recipes} onRun={run} busyReason={busyReason} />
      </div>
    )
  } else {
    const versionRow = (
      <>
        <CheckRow tone="ok" testId="codex-setup-found">{install.version ? `Codex ${install.version} found` : 'Codex found'}</CheckRow>
        <CheckRow tone={install.tooNew ? 'warn' : 'ok'} testId="codex-setup-version">
          {install.tooNew ? 'Newer than the versions this app was tested with; it will still be used' : 'Version supported'}
        </CheckRow>
      </>
    )
    // Canvas F2 d: the callout naming this computer's sign-in, then its use
    // (offered, or settled once an account stands for it) and a new account
    // of its own, Recommended: the better choice, and the only one that can
    // review code. `verified`: known to be signed in (an account stands for
    // it, or the page's check just found it so); otherwise it is offered
    // without that claim. The email is not shown:
    // `codex login status` does not report one, and this app never reads
    // Codex's sign-in files.
    const thisComputerCallout = (verified: boolean, label?: string) => (
      <div className="cx-callout" data-testid="codex-setup-adopt-callout">
        <span className="cx-callout-i" aria-hidden>i</span>
        <span>
          {verified
            ? `Codex is already signed in on this computer (~/.codex${label ? `, ${label}` : ''})`
            : 'The app could not check whether Codex is signed in on this computer (~/.codex). Use this sign-in checks it again.'}
        </span>
      </div>
    )
    const SHARED_NOTE = 'You confirm it at each launch, and it cannot run code reviews'
    // Offered: Codex is on as the user answered, nothing stands for this
    // computer's sign-in, the page's check just found it signed in (or got no
    // answer either way), and the user has not just found it signed out.
    const offerThisComputer = providerAnsweredOn(provider) && adoptAnswer === null
      && thisComputer.kind === 'free' && (probe === 'signed-in' || probe === 'unknown')
    // The page's check is running, or about to (it starts after this render).
    const probing = !done && (probe === 'running' || (probe === 'idle' && canProbe))
    if (done && onlyShared) {
      const shared = signedIn[0]
      view = 'done-shared'
      body = (
        <div data-testid="codex-setup-done">
          {thisComputerCallout(true, shared.providerLabel)}
          <div className="cx-opt cx-opt-done" data-testid={`codex-setup-signed-in-${shared.id}`}>
            <span>
              <span className="cx-opt-t"><span className="cx-done-mark" aria-hidden>{CHECK}</span>Using this sign-in</span>
              <span className="cx-opt-d">{SHARED_NOTE}</span>
            </span>
          </div>
          {addNew('codex-setup-add-new', false)}
        </div>
      )
    } else if (done) {
      view = 'done'
      body = (
        <div data-testid="codex-setup-done">
          {versionRow}
          {signedIn.map((a) => (
            <CheckRow key={a.id} tone="ok" testId={`codex-setup-signed-in-${a.id}`}>Signed in: {accountDisplayName(snapshot, a)}</CheckRow>
          ))}
        </div>
      )
    } else if (probing) {
      view = 'checking-this-computer'
      body = (
        <div data-testid="codex-setup-checking-this-computer">
          {versionRow}
          <CheckRow tone="pending" testId="codex-setup-this-computer-check">Checking this computer's Codex sign-in...</CheckRow>
        </div>
      )
    } else if (offerThisComputer) {
      view = 'adopt'
      body = (
        <div data-testid="codex-setup-adopt">
          <CheckRow tone="ok" testId="codex-setup-found">{install.version ? `Codex ${install.version} found` : 'Codex found'}</CheckRow>
          {thisComputerCallout(probe === 'signed-in')}
          <button className="cx-opt" type="button" onClick={() => { void adopt() }} disabled={busy} data-testid="codex-setup-use-existing">
            <span>
              <span className="cx-opt-t">{busy ? 'Checking this sign-in...' : 'Use this sign-in'}</span>
              <span className="cx-opt-d">{SHARED_NOTE}</span>
            </span>
            <span className="cx-chev" aria-hidden />
          </button>
          {addNew('codex-setup-add-new', true)}
        </div>
      )
    } else {
      // State c: sign in to a new account, with what was found about this
      // computer's own sign-in as a note: signed out just now (the page's
      // check or the user's "Use this sign-in"), with the way to ask again;
      // or a folder that overlaps this app's own, which cannot be used here.
      // No Codex sign-in folder there at all, or one Codex cannot check here:
      // nothing to say, and nothing offered.
      const signedOutNow = adoptAnswer === 'signed-out' || probe === 'signed-out'
      const note = signedOutNow
        ? 'This computer\'s Codex sign-in (~/.codex) is signed out.'
        : probe === 'overlap' ? OVERLAP_NOTE : null
      const lookAgain = providerAnsweredOn(provider) && signedOutNow
      view = 'sign-in'
      body = (
        <div data-testid="codex-setup-sign-in">
          {versionRow}
          {note && <p className="cx-muted" data-testid="codex-setup-adoption-note">{note}</p>}
          {lookAgain && (
            <button className="cx-link" type="button" onClick={checkThisComputerAgain} disabled={busy} data-testid="codex-setup-check-this-computer">
              {busy ? 'Checking...' : 'Check this computer\'s sign-in again'}
            </button>
          )}
          <div className="cx-h3">Sign in to a new Codex account</div>
          {methods.length === 0 && <p className="cx-muted">No sign-in method is available for Codex here.</p>}
          {provider && methods.map((m, i) => {
            const copy = methodCopy(provider, m)
            return (
              <button
                key={m}
                className={i === 0 ? 'cx-choice primary' : 'cx-choice'}
                type="button"
                onClick={() => setDialog({ method: m })}
                data-autofocus={i === 0 ? '' : undefined}
                data-testid={`codex-setup-method-${m}`}
              >
                <b>{copy.title}</b>
                <span>{copy.sub}</span>
              </button>
            )
          })}
        </div>
      )
    }
  }

  const needsCli = install.kind === 'missing' || install.kind === 'update'

  // Focus goes to the page's primary control, the first enabled one marked
  // data-autofocus (an install or update command's button, else Check again;
  // the first sign-in method; the Recommended new account; Next; Skip for now
  // when the account list is not there), when the page opens, when its state
  // moves on (a check finished, a sign-in landed), when the add-account dialog
  // closes and when the user comes back from the terminal. Only while nothing
  // has focus (the page body): a control the user is on keeps it, and nothing
  // is taken from under the add-account dialog.
  const pageRef = useRef<HTMLDivElement>(null)
  const recipesLoaded = recipes !== undefined
  useEffect(() => {
    if (dialog) return
    // Not found or too old: the commands are the primary, so wait for them
    // rather than settle on Check again a moment before they arrive.
    if (needsCli && !recipesLoaded) return
    const at = document.activeElement
    if (at && at !== document.body) return
    // The page's own section: this page's body and its footer.
    const scope = pageRef.current?.parentElement
    const primary = Array.from(scope?.querySelectorAll<HTMLButtonElement>('[data-autofocus]') ?? []).find((el) => !el.disabled)
    primary?.focus()
  }, [view, needsCli, recipesLoaded, dialog, returns])

  return (
    <>
      <div className="p2" ref={pageRef}>
        <div className="p2-inner" data-testid="codex-setup">
          <h2 className="h2">Set up Codex</h2>
          {body}
          {/* The body already says the account list is not available: say it once. */}
          {error && !(install.kind === 'unavailable' && error.code === 'registry-unavailable') && (
            <div className="gh-err" role="alert" data-testid="codex-setup-error">{error.message}</div>
          )}
        </div>
      </div>
      <div className="foot">
        {onBack && <button className="back" onClick={onBack} type="button" data-testid="codex-setup-back">← Back</button>}
        <span className="cx-foot-actions">
          {needsCli && (
            <button className="back" type="button" onClick={() => { void checkAgain() }} disabled={checking} data-autofocus="" data-testid="codex-setup-check-again">
              {checking ? 'Checking...' : 'Check again'}
            </button>
          )}
          {done ? (
            <button className="cta" onClick={onNext} type="button" data-autofocus="" data-testid="codex-setup-next">Next →</button>
          ) : (
            <button className="skip" onClick={onNext} type="button" data-autofocus={install.kind === 'unavailable' ? '' : undefined} data-testid="codex-setup-skip">Skip for now →</button>
          )}
        </span>
      </div>
      {dialog && provider && (
        <AddProviderAccountDialog provider={provider} initialMethod={dialog.method} overlayZ={OVER_ONBOARDING} onClose={() => setDialog(null)} />
      )}
    </>
  )
}
