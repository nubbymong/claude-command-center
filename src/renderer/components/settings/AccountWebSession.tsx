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
 * Both sign-ins happen in the user's OWN browser, because a managed machine
 * requires an extension an in-app window cannot load. Doing the web sign-in
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
  type AuthBrowser,
  type CliAuthMethod,
} from '../../../shared/account-web-session'

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
    }
    else setError(r.error)
  }, [profileId])

  useEffect(() => { void refresh() }, [refresh])

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

  const signIn = async (): Promise<void> => {
    setBusy(true); setError(''); setNotice(''); setPhase('launching')
    const r = await api.signIn(profileId)
    setBusy(false)
    if (!r.ok) setError(r.error)
    else if (r.state.phase === 'failed') setError(r.state.error ?? 'Sign-in failed.')
    // Shown whether the sign-in succeeded or not: a browser substitution is the
    // likeliest explanation for an SSO step that behaved unexpectedly.
    if (r.ok && r.state?.notice) setNotice(r.state.notice)
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
    <div className="rounded border border-surface1 bg-mantle p-3 space-y-3">
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
              className="bg-base border border-surface1 rounded px-2 py-1 text-[11px] text-text focus:outline-none focus:border-blue"
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
              : 'Needed to import an organisation-scoped share and to open this account’s artifacts. Opens your own browser to sign in.'}
          </div>

          {/* Browser is PER ACCOUNT and the user's call, because the two are not
              interchangeable at the identity provider. The sign-in runs in a
              fresh profile by design, and on a managed machine Chrome's
              force-installed SSO extension is not there yet when claude.ai
              loads — Edge does Entra SSO natively and has nothing to wait for.
              Which one an account needs depends on its org, so CCC asks. */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-overlay0 shrink-0">Sign-in browser</span>
            <select
              value={authBrowser}
              disabled={busy}
              onChange={(e) => { void changeAuthBrowser(e.target.value as AuthBrowser) }}
              className="bg-base border border-surface1 rounded px-2 py-1 text-[11px] text-text focus:outline-none focus:border-blue disabled:opacity-40"
            >
              {AUTH_BROWSERS.map((b) => (
                <option key={b} value={b}>{AUTH_BROWSER_LABELS[b]}</option>
              ))}
            </select>
            <span className="text-[10px] text-overlay0">
              {authBrowser === 'edge' ? 'Handles SSO without an extension' : 'Needs your policy’s SSO extension'}
            </span>
          </div>
        </div>
      </div>

      {busy && (
        <div className="text-[11px] text-blue">
          {phase === 'awaiting-user'
            ? 'Waiting for you to finish signing in, in the browser window that just opened…'
            : phase === 'harvesting' ? 'Signed in — collecting the session…' : 'Opening your browser…'}
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
