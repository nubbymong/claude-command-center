/**
 * AccountWebSession.tsx — both halves of one account's authentication (#216).
 *
 * They are shown together on purpose. A CCC account has two credentials that
 * look like one thing to a user: the Claude Code CLI's OAuth token, and a
 * claude.ai WEB session. They are genuinely separate — the OAuth token is
 * rejected by claude.ai's web API — and the failures they cause look nothing
 * alike, so a panel that showed only one would leave the other's symptoms
 * unexplained.
 *
 * The web sign-in opens a window: an in-app window for most accounts (no
 * launched browser, no debug port — claude.ai's bot-detection flags that port),
 * and the user's OWN browser for SSO accounts, whose identity provider may need a
 * policy-installed extension an in-app window cannot load. Doing the web sign-in
 * first means the CLI's hop is a consent click rather than a second credential
 * entry.
 */

import React, { useCallback, useEffect, useState } from 'react'
import {
  AUTH_BROWSERS,
  AUTH_BROWSER_LABELS,
  CLI_AUTH_METHODS,
  CLI_AUTH_METHOD_LABELS,
  DEFAULT_AUTH_BROWSER,
  DEFAULT_CLI_AUTH_METHOD,
  DEFAULT_WEB_SIGN_IN_MODE,
  WEB_SIGN_IN_MODES,
  WEB_SIGN_IN_MODE_LABELS,
  type AuthBrowser,
  type CliAuthMethod,
  type WebSignInMode,
} from '../../../shared/account-web-session'
import { useSessionStore } from '../../stores/sessionStore'

interface Props {
  profileId: string
  accountName: string
}

type Web = { status: 'none' | 'active' | 'expired'; accountEmail?: string | null; acquiredAt?: number; expiresAt?: number | null }
type Cli = { authenticated: boolean; subscriptionType?: string; expiresAt?: number; email?: string; orgName?: string; error?: string }

const fmt = (ms?: number | null): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toLocaleString() : 'unknown'

export function AccountWebSession({ profileId, accountName }: Props) {
  const api = window.electronAPI.accountWeb
  const [web, setWeb] = useState<Web>({ status: 'none' })
  const [cli, setCli] = useState<Cli>({ authenticated: false })
  const [authCommand, setAuthCommand] = useState('claude auth login')
  const [authMethod, setAuthMethod] = useState<CliAuthMethod>(DEFAULT_CLI_AUTH_METHOD)
  const [authBrowser, setAuthBrowser] = useState<AuthBrowser>(DEFAULT_AUTH_BROWSER)
  const [signInMode, setSignInMode] = useState<WebSignInMode>(DEFAULT_WEB_SIGN_IN_MODE)
  const [detectedBrowsers, setDetectedBrowsers] = useState<AuthBrowser[]>([])
  const [phase, setPhase] = useState<string>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Non-fatal, e.g. the chosen browser was missing and the other one was used. */
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    const r = await api.status(profileId)
    if (r.ok) {
      setWeb(r.web); setCli(r.cli); setAuthCommand(r.authCommand)
      if (r.authMethod) setAuthMethod(r.authMethod)
      if (r.authBrowser) setAuthBrowser(r.authBrowser)
      if (r.webSignInMode) setSignInMode(r.webSignInMode)
      if (Array.isArray(r.detectedBrowsers)) setDetectedBrowsers(r.detectedBrowsers)
    }
    else setError(r.error)
  }, [profileId])

  useEffect(() => { void refresh() }, [refresh])

  // A pane-hosted sign-in (#439) completes outside this panel: main pushes the
  // account surface's auth state, and a signed-in push for THIS account is the
  // moment the promised "this panel updates itself" happens.
  useEffect(() => {
    return window.electronAPI.accountWeb?.onPaneState?.((st) => {
      if (st.profileId === profileId && st.authed === true) void refresh()
    })
  }, [profileId, refresh])

  // A sign-in is human-paced (SSO, MFA), so the phase is polled while it runs.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(async () => {
      const r = await api.signInState()
      if (r.ok) {
        setPhase(r.state.phase)
        // Mirror the live notice (e.g. a Cloudflare challenge in progress) while
        // the sign-in runs, not only on the final result — and clear it once the
        // challenge is gone, so a stale "verifying you" banner does not linger. #269.
        setNotice(typeof r.state.notice === 'string' ? r.state.notice : '')
      }
    }, 1000)
    return () => clearInterval(t)
  }, [busy])

  const changeAuthMethod = async (m: CliAuthMethod): Promise<void> => {
    setAuthMethod(m)   // optimistic: the picker should not lag the click
    const r = await api.setAuthMethod({ profileId, method: m })
    if (!r.ok) setError(r.error)
    await refresh()    // re-read so the shown command matches what was stored
  }

  const changeAuthBrowser = async (b: AuthBrowser): Promise<void> => {
    setAuthBrowser(b)   // optimistic: the picker should not lag the click
    const r = await api.setAuthBrowser({ profileId, browser: b })
    if (!r.ok) setError(r.error)
    await refresh()     // re-read so the picker shows what was actually stored
  }

  const changeSignInMode = async (m: WebSignInMode): Promise<void> => {
    setSignInMode(m)    // optimistic: the picker should not lag the click
    const r = await api.setSignInMode({ profileId, mode: m })
    if (!r.ok) setError(r.error)
    await refresh()
  }

  const signIn = async (): Promise<void> => {
    // #439: "Internal browser pane" routes the sign-in into a session's baked-in
    // browser — a claude.ai-only view on THIS account's partition — instead of
    // the dedicated window. It needs a session to host the pane; with none open,
    // the default window flow runs so the button never dead-ends.
    let fallbackNotice = ''
    if (signInMode === 'internal-pane') {
      const sessions = useSessionStore.getState()
      const host = sessions.sessions.find((s) => s.id === sessions.activeSessionId) ?? sessions.sessions[0]
      if (host) {
        window.dispatchEvent(new CustomEvent('app:openAccountPane', { detail: { sessionId: host.id, profileId } }))
        setError('')
        setNotice('The sign-in opened in that session’s browser pane — sign in there once, and this panel updates itself.')
        return
      }
      fallbackNotice = 'No session is open to host the browser pane, so the sign-in window was used instead.'
    }
    setBusy(true); setError(''); setNotice(''); setPhase('launching')
    const r = await api.signIn(profileId)
    setBusy(false)
    if (!r.ok) setError(r.error)
    else if (r.state.phase === 'failed') setError(r.state.error ?? 'Sign-in failed.')
    // Shown whether the sign-in succeeded or not: a browser substitution is the
    // likeliest explanation for an SSO step that behaved unexpectedly.
    if (r.ok && r.state?.notice) setNotice(r.state.notice)
    else if (fallbackNotice) setNotice(fallbackNotice)
    setPhase('idle')
    await refresh()
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    const r = await api.signOut(profileId)
    setBusy(false)
    if (!r.ok) setError(r.error)
    await refresh()
  }

  const openArtifacts = async (): Promise<void> => {
    const r = await api.openArtifacts(profileId)
    if (!r.ok) setError(r.error)
  }

  const dot = (ok: boolean, warn = false): string =>
    ok ? 'bg-green' : warn ? 'bg-yellow' : 'bg-overlay0'

  return (
    <div className="settings-panel p-3 space-y-3">
      <div className="text-xs text-text font-medium">{accountName} — authentication</div>

      {/* Code session */}
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot(cli.authenticated)}`} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-text">
            Code session {cli.authenticated ? '— signed in' : '— not signed in'}
            {cli.subscriptionType ? <span className="text-overlay0"> · {cli.subscriptionType}</span> : null}
          </div>
          <div className="text-[10px] text-overlay0 leading-snug">
            {cli.authenticated
              ? <>
                  {cli.email ? <>Signed in as <span className="text-subtext0">{cli.email}</span>. </> : null}
                  {cli.orgName ? <>{cli.orgName}. </> : null}
                  {cli.expiresAt ? `Token expires ${fmt(cli.expiresAt)}.` : null}
                </>
              : <>
                  Sign in from a running session for this account: <span className="text-subtext0">right-click it
                  → Sign in to Claude Code</span>, which runs <code className="text-subtext0">/login</code> in that
                  terminal and opens your own browser. Or run{' '}
                  <code className="text-subtext0">{authCommand}</code> yourself.
                </>}
          </div>

          {/* Sign-in flow is PER ACCOUNT: an org account goes through SSO, a
              personal subscription does not, and a Console account bills API
              usage. Defaulting everyone to one of them fails at the identity
              provider rather than here, which is a bad place to find out. */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-overlay0 shrink-0">Sign-in flow</span>
            <select
              value={authMethod}
              onChange={(e) => { void changeAuthMethod(e.target.value as CliAuthMethod) }}
              className="bg-crust/60 border border-surface0/80 rounded px-2 py-1 text-[11px] text-text focus:outline-none focus:border-blue/50 transition-colors"
            >
              {CLI_AUTH_METHODS.map((m) => (
                <option key={m} value={m}>{CLI_AUTH_METHOD_LABELS[m]}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Web session */}
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot(web.status === 'active', web.status === 'expired')}`} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-text">
            claude.ai web session — {web.status === 'active' ? 'signed in' : web.status === 'expired' ? 'expired' : 'not signed in'}
            {web.accountEmail ? <span className="text-overlay0"> · {web.accountEmail}</span> : null}
          </div>
          <div className="text-[10px] text-overlay0 leading-snug">
            {web.status === 'active'
              ? `Acquired ${fmt(web.acquiredAt)}${web.expiresAt ? `, expires ${fmt(web.expiresAt)}` : ''}.`
              : 'Needed to import an organisation-scoped share and to open this account’s artifacts. Opens a window to sign in.'}
          </div>

          {/* #439: where the web sign-in runs. Default keeps today's flow
              untouched (the dedicated window; the system browser for SSO); the
              alternative hosts it in a session's baked-in browser pane on this
              account's partition. */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-overlay0 shrink-0">Open claude.ai sign-in in</span>
            <select
              value={signInMode}
              disabled={busy}
              onChange={(e) => { void changeSignInMode(e.target.value as WebSignInMode) }}
              className="bg-crust/60 border border-surface0/80 rounded px-2 py-1 text-[11px] text-text focus:outline-none focus:border-blue/50 transition-colors disabled:opacity-40"
              data-testid="web-sign-in-mode"
            >
              {WEB_SIGN_IN_MODES.map((m) => (
                <option key={m} value={m}>{WEB_SIGN_IN_MODE_LABELS[m]}</option>
              ))}
            </select>
            {signInMode === 'internal-pane' && (
              <span className="text-[10px] text-overlay0">Signs in inside a session’s browser pane</span>
            )}
          </div>

          {/* SSO ONLY, and only when there is a genuine CHOICE (#439: more than
              one drivable browser detected). Non-SSO accounts sign in inside an
              in-app window (#290), which launches no system browser, so this
              picker would be inert for them. For SSO the browser IS the user's
              call: on a managed machine Chrome's force-installed SSO extension
              is not there yet when claude.ai loads in a fresh profile, while
              Edge does Entra SSO natively — which one an account needs depends
              on its org, so CCC asks. With exactly one browser installed the
              launcher's not-silent fallback already says what ran. */}
          {authMethod === 'sso' && detectedBrowsers.length > 1 && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-overlay0 shrink-0">Sign-in browser</span>
              <select
                value={authBrowser}
                disabled={busy}
                onChange={(e) => { void changeAuthBrowser(e.target.value as AuthBrowser) }}
                className="bg-crust/60 border border-surface0/80 rounded px-2 py-1 text-[11px] text-text focus:outline-none focus:border-blue/50 transition-colors disabled:opacity-40"
              >
                {AUTH_BROWSERS.map((b) => (
                  <option key={b} value={b}>{AUTH_BROWSER_LABELS[b]}</option>
                ))}
              </select>
              <span className="text-[10px] text-overlay0">
                {authBrowser === 'edge' ? 'Handles SSO without an extension' : 'Needs your policy’s SSO extension'}
              </span>
            </div>
          )}
        </div>
      </div>

      {busy && (
        <div className="text-[11px] text-blue">
          {phase === 'awaiting-user'
            ? 'Waiting for you to finish signing in, in the sign-in window that just opened…'
            : phase === 'harvesting' ? 'Signed in — collecting the session…' : 'Opening the sign-in window…'}
        </div>
      )}

      {error && (
        <div className="rounded border border-red/40 bg-red/10 px-3 py-2 text-[11px] text-red whitespace-pre-wrap">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded border border-yellow/40 bg-yellow/10 px-3 py-2 text-[11px] text-yellow whitespace-pre-wrap">
          {notice}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          disabled={busy}
          onClick={signIn}
          className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 disabled:opacity-40 transition-colors"
        >
          {web.status === 'active' ? 'Sign in again' : 'Sign in to claude.ai'}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => { void api.cancel(profileId) }}
            className="px-3 py-1.5 rounded text-xs bg-surface1 text-text hover:bg-surface2 transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={busy || web.status !== 'active'}
          onClick={openArtifacts}
          title={web.status === 'active' ? '' : 'Sign in to claude.ai first'}
          className="px-3 py-1.5 rounded text-xs bg-surface1 text-text hover:bg-surface2 disabled:opacity-40 transition-colors"
        >
          Open my artifacts
        </button>
        {web.status !== 'none' && (
          <button
            type="button"
            disabled={busy}
            onClick={signOut}
            className="px-3 py-1.5 rounded text-xs text-subtext0 hover:text-text hover:bg-surface1 disabled:opacity-40 transition-colors"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  )
}
