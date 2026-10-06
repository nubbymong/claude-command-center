import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useInsightsStore } from '../stores/insightsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderAccountsStore, accountDisplayName, providerAccountActions } from '../stores/providerAccountsStore'
import { useClickOutside } from '../hooks/useClickOutside'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { authFailureStillApplies, describeAuthWindow, type ProfileAuthInfo } from '../../shared/account-auth'
import { isAccountActive } from '../../shared/account-types'
import { resolveAccountNameByEmail, resolveAccountName } from '../../shared/account-chip-color'
import KpiSidebar from './KpiSidebar'
import type { CrossAccountInsights, InsightsData } from '../types/electron'
import PageFrame from './PageFrame'
import { parseInsightsReport, parseCodexInsightsReport, type ParsedInsights } from './insights/parseInsightsReport'
import { InsightsSections } from './insights/InsightsSections'
import CrossAccountReport from './insights/CrossAccountReport'
import { CLAUDE_OFF, useClaudeOff } from '../lib/claudeOff'
import { providerOffForLaunch } from '../utils/launchAccount'
import { ProviderMark } from './sidebar/Badges'
import {
  claudeAccountChoices,
  codexAccountChoices,
  codexAccountLabel,
  codexRunAccountName,
  defaultInsightsChoice,
  insightsAccountKey,
  runAllCount,
  type InsightsAccountChoice,
} from './insights/insightsAccounts'

interface InsightsPageProps {
  /** Switch to the sessions view. Re-auth opens a login shell session, so the
   *  user has to be taken to it — same contract AccountUsagePanel uses. */
  onNavigateToSessions?: () => void
}

/** One account the sign-in banner names. */
interface ReauthEntry {
  provider: 'claude' | 'codex'
  id: string
  name: string
  error?: string
}

/** P4.7 (mockup D3): what the "?" beside a Codex report's title says. */
const CODEX_HOW_MADE = "Codex has no Insights command of its own, so the app makes this report. It counts this account's Codex sessions itself, then asks Codex to write the cards, read-only and with no tools, on this account's own allowance."

/**
 * Accounts whose sign-in has expired, according to Insights' own runs.
 *
 * Only each account's MOST RECENT run counts. A historical auth failure that has
 * since been fixed must not keep nagging — same calibration as the nav status dot:
 * a warning means "needs attention now", not "once failed".
 *
 * P4.7 (mockup D10): a Codex account is listed too, and its button opens
 * Settings, Accounts, where its Sign in again is (the Usage page's way); its
 * own line says a Codex report cannot run at all without a sign-in.
 */
function AuthBanner({
  accounts,
  checking,
  onReauth,
  onRecheck,
}: {
  accounts: ReauthEntry[]
  checking: boolean
  onReauth: (entry: ReauthEntry) => void
  onRecheck: () => void
}) {
  if (accounts.length === 0) return null
  const anyClaude = accounts.some((a) => a.provider === 'claude')
  const anyCodex = accounts.some((a) => a.provider === 'codex')
  return (
    <div className="px-4 py-2.5 bg-red/10 border-b border-red/25 shrink-0" data-testid="insights-auth-banner">
      <div className="flex items-start gap-2">
        <span className="text-red text-xs mt-0.5 shrink-0">{String.fromCodePoint(0x26a0)}</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-red font-medium">
            {accounts.length === 1
              ? 'One account needs to sign in again before Insights can analyse it.'
              : `${accounts.length} accounts need to sign in again before Insights can analyse them.`}
          </p>
          {anyClaude && (
            <p className="text-[11px] text-overlay1 mt-0.5">
              The report still generates, but the metrics and the written analysis need a working
              sign-in. Signing in opens a terminal session for that account.
            </p>
          )}
          {anyCodex && (
            <p className="text-[11px] text-overlay1 mt-0.5" data-testid="insights-auth-codex-line">
              A Codex report cannot run without a working sign-in.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {accounts.map((a) => (
              <button
                key={`${a.provider}:${a.id}`}
                onClick={() => onReauth(a)}
                title={a.error || 'Sign-in expired'}
                data-testid={`insights-reauth-${a.provider}`}
                className="text-[11px] px-2 py-0.5 rounded border border-red/40 text-red hover:bg-red/15 transition-colors"
              >
                Sign in: {a.name}
              </button>
            ))}
            {/* Explicit re-check: the credential files are read on mount, but a
                sign-in happens in a terminal session this component never hears
                about, so the user needs a way to say "look again" without a reload. */}
            <button
              onClick={onRecheck}
              disabled={checking}
              className="text-[11px] px-2 py-0.5 rounded border border-surface1 text-overlay1 hover:text-text transition-colors disabled:opacity-60"
            >
              {checking ? 'Checking…' : 'Re-check sign-ins'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** P4.7 (mockup D12): a run on an account marked "confirm at launch" asks the
 *  per-run confirmation a Codex cloud agent asks, in its words. Nothing is
 *  kept: the tick counts for this run and this account only. A run that
 *  starts closes it (the page's own Run buttons are off while one runs);
 *  Escape or a click outside closes it, and the tick box takes focus. */
function CodexRunConfirm({ choice, onRun, onCancel }: { choice: InsightsAccountChoice; onRun: () => void; onCancel: () => void }) {
  const [ticked, setTicked] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLInputElement>(null)
  useClickOutside(ref, onCancel)
  useEffect(() => { box.current?.focus() }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Confirm this report"
      data-testid="insights-codex-confirm"
      className="absolute right-0 top-full mt-1 z-30 w-[320px] rounded-lg border p-3 text-left shadow-lg"
      style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)' }}
    >
      <label className="flex items-start gap-2 text-[11.5px] leading-snug cursor-pointer" style={{ color: 'var(--text-primary)' }}>
        <input
          ref={box}
          type="checkbox"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
          className="mt-0.5 shrink-0 rounded"
          data-testid="insights-codex-ack"
        />
        <span>
          {choice.external
            ? `Run this report with the Codex sign-in already on this computer${choice.email ? ` (${choice.email})` : ''}`
            : 'Run this report with this account although its sign-in is not verified'}
        </span>
      </label>
      <div className="flex justify-end gap-1.5 mt-2.5">
        <button
          onClick={onRun}
          disabled={!ticked}
          data-testid="insights-codex-confirm-run"
          className="text-xs px-2.5 py-0.5 rounded border font-medium bg-teal/10 border-teal/30 text-teal hover:bg-teal/20 disabled:bg-surface0 disabled:border-surface1 disabled:text-overlay0 disabled:cursor-not-allowed"
        >
          Run
        </button>
        <button
          onClick={onCancel}
          data-testid="insights-codex-confirm-cancel"
          className="text-xs px-2.5 py-0.5 rounded border border-surface1 bg-surface0 text-subtext1 hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function InsightsPage({ onNavigateToSessions }: InsightsPageProps = {}) {
  // All hooks called unconditionally -- early returns appear after all hook calls.
  const catalogue = useInsightsStore((s) => s.catalogue)
  const selectedRunId = useInsightsStore((s) => s.selectedRunId)
  const selectRun = useInsightsStore((s) => s.selectRun)
  const status = useInsightsStore((s) => s.status)
  const statusMessage = useInsightsStore((s) => s.statusMessage)
  const startInsights = useInsightsStore((s) => s.startInsights)
  const startCodexInsights = useInsightsStore((s) => s.startCodexInsights)
  const startCrossAccount = useInsightsStore((s) => s.startCrossAccount)
  const batchActive = useInsightsStore((s) => s.batchActive)
  const loadCatalogue = useInsightsStore((s) => s.loadCatalogue)
  // A run on a Claude Code account is a headless Claude Code run: with Claude
  // Code switched off, a Claude account's run is disabled and says why (the
  // store refuses as well). A Codex account's run is not (mockup D8).
  const claudeOff = useClaudeOff()

  const [parsed, setParsed] = useState<ParsedInsights | null>(null)
  const [currentKpis, setCurrentKpis] = useState<InsightsData | null>(null)
  const [previousKpis, setPreviousKpis] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Account selection: which account a new run executes under (mockup D7).
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const codexEnabled = useSettingsStore((s) => s.settings.codexEnabled)
  // Codex off or not set up: its accounts leave the picker (their reports stay).
  const codexUsable = !providerOffForLaunch('codex', snapshot)
  const defaultProfileId = (profiles.find((p) => p.isPrimary) ?? profiles[0])?.id ?? ''
  const nameForAccount = (email?: string) => (email ? resolveAccountNameByEmail(email, profiles, accountAliases) : null)
  const labelForProfile = (p: { accountEmail: string; name?: string; isPrimary?: boolean }) =>
    (resolveAccountName(p.accountEmail, p.name, accountAliases) || 'Account') + (p.isPrimary ? ' (primary)' : '')
  const claudeChoices = claudeAccountChoices(profiles, labelForProfile, !claudeOff)
  // codexEnabled is read so a switch in Settings re-draws the list at once.
  const codexChoices = useMemo(() => codexAccountChoices(snapshot, codexUsable), [snapshot, codexUsable, codexEnabled])
  const allChoices = [...claudeChoices, ...codexChoices]
  const showPicker = allChoices.length >= 2
  const [runChoice, setRunChoice] = useState<string>('')
  const fallbackChoice: InsightsAccountChoice = { value: insightsAccountKey('claude', ''), provider: 'claude', id: '', label: 'Claude Code', disabled: false, needsAck: false, external: false }
  const selected: InsightsAccountChoice =
    allChoices.find((c) => c.value === runChoice && !c.disabled) ??
    defaultInsightsChoice(claudeChoices, codexChoices, !claudeOff, defaultProfileId) ??
    fallbackChoice
  const selectedClaudeOff = selected.provider === 'claude' && claudeOff
  const allCount = runAllCount(claudeChoices, codexChoices, !claudeOff)

  useEffect(() => {
    loadCatalogue()
  }, [])

  // A changed account choice closes an open confirmation: it named the other
  // one. So does a run starting, from this page or a roll-up.
  useEffect(() => { setConfirming(false) }, [selected.value])
  useEffect(() => { if (status === 'running' || status === 'extracting_kpis' || batchActive) setConfirming(false) }, [status, batchActive])

  useEffect(() => {
    if (!selectedRunId) {
      setParsed(null)
      setCurrentKpis(null)
      setPreviousKpis(null)
      return
    }

    setLoading(true)
    setHelpOpen(false)
    const sel = catalogue?.runs.find((r) => r.id === selectedRunId)
    // P4.7: a Codex report is data (report.json), checked and drawn as text;
    // Claude's is its report.html, parsed into the same cards.
    const codexRun = sel?.provider === 'codex'

    Promise.all([
      window.electronAPI.insights.getReport(selectedRunId),
      window.electronAPI.insights.getKpis(selectedRunId),
    ]).then(([text, kpis]) => {
      setParsed(text ? (codexRun ? parseCodexInsightsReport(text) : parseInsightsReport(text)) : null)
      setCurrentKpis(kpis)
      setLoading(false)
    }).catch(() => {
      // A read main could not make is no report, never a page left waiting.
      setParsed(null)
      setCurrentKpis(null)
      setLoading(false)
    })

    if (catalogue) {
      // Compare against the previous complete run of the SAME account (W5) —
      // otherwise multi-account diffs one account's run against another's.
      // Aggregates are excluded on both sides: they carry no profileId, so they
      // would otherwise pair up with every default-account run, and a
      // cross-account roll-up is rendered without the trend sidebar anyway.
      // P4.7: and of the same assistant (absent reads as Claude Code's).
      if (sel?.kind === 'aggregate') {
        setPreviousKpis(null)
        return
      }
      const runs = catalogue.runs.filter(
        (r) =>
          r.status === 'complete' &&
          r.kind !== 'aggregate' &&
          (r.profileId ?? null) === (sel?.profileId ?? null) &&
          (r.provider ?? 'claude') === (sel?.provider ?? 'claude')
      )
      const idx = runs.findIndex((r) => r.id === selectedRunId)
      if (idx > 0) {
        window.electronAPI.insights.getKpis(runs[idx - 1].id).then(setPreviousKpis)
      } else {
        setPreviousKpis(null)
      }
    }
  }, [selectedRunId, catalogue])

  const completedRuns = catalogue?.runs.filter((r) => r.status === 'complete') || []
  const failedRuns = catalogue?.runs.filter((r) => r.status === 'failed') || []
  const latestRun = catalogue?.runs[catalogue.runs.length - 1] || null
  const selectedRun = catalogue?.runs.find((r) => r.id === selectedRunId) || null
  // Picker lists viewable (complete) + failed runs, newest first, so failures
  // are discoverable instead of being silently filtered out.
  const pickerRuns = [...completedRuns, ...failedRuns].sort((a, b) => b.timestamp - a.timestamp)
  const isRunning = status === 'running' || status === 'extracting_kpis'
  const selectedIsCodex = selectedRun?.provider === 'codex'

  // A cross-account roll-up renders from its own JSON (it has no report.html).
  // The shape is validated before use so a truncated or hand-edited kpis.json
  // shows the "no report" state instead of throwing inside the view.
  const selectedIsAggregate = selectedRun?.kind === 'aggregate'
  const crossAccount: CrossAccountInsights | null =
    selectedIsAggregate &&
    currentKpis &&
    Array.isArray((currentKpis as CrossAccountInsights).accounts) &&
    Array.isArray((currentKpis as CrossAccountInsights).comparison)
      ? (currentKpis as CrossAccountInsights)
      : null
  const runAllLabel = allCount >= 2 ? `Run all (${allCount})` : 'Run all'
  const runAllBlockedTitle =
    claudeOff && claudeChoices.length > 0 ? CLAUDE_OFF : 'A cross-account report needs at least two accounts that can run without their own confirmation.'
  const runAllTitle = allCount >= 2 ? 'Generate a report for every account, then one combined cross-account report' : runAllBlockedTitle

  // LIVE credential state, read from disk. The first cut derived this purely from
  // run history ("this account's latest run failed authentication"), which cannot
  // be cleared by the fix: signing in does not produce a new run, so the warning
  // persisted forever after a successful login. Run history is now only a
  // secondary hint, retired as soon as the credentials are newer than the run.
  const [authInfo, setAuthInfo] = useState<ProfileAuthInfo[] | null>(null)
  const [checkingAuth, setCheckingAuth] = useState(false)
  const recheckAuth = React.useCallback(async () => {
    setCheckingAuth(true)
    try {
      setAuthInfo(await window.electronAPI.accountProfiles.authInfo())
    } catch {
      setAuthInfo([])
    } finally {
      setCheckingAuth(false)
    }
  }, [])
  useEffect(() => { void recheckAuth() }, [recheckAuth])

  const accountsNeedingReauth = useMemo(() => {
    const out: ReauthEntry[] = []
    const latestRunByAccount = new Map<string, { timestamp: number; authFailed?: boolean; authFailedRefreshExpiry?: number; error?: string; accountEmail?: string }>()
    for (const run of catalogue?.runs ?? []) {
      if (!run.profileId || run.kind === 'aggregate') continue
      const key = insightsAccountKey(run.provider ?? 'claude', run.profileId)
      const current = latestRunByAccount.get(key)
      if (!current || run.timestamp > current.timestamp) latestRunByAccount.set(key, run)
    }

    for (const info of authInfo ?? []) {
      const profile = profiles.find((p) => p.id === info.profileId)
      // A parked (inactive) account is intentionally never token-refreshed (#280),
      // so its credentials lapse BY DESIGN — never nag the user to re-authenticate
      // an account they deliberately parked (clicking would spawn a login shell
      // pinned to it, the exact behaviour #280 set out to stop on the sibling
      // surface). Skip known-parked profiles before either push site.
      if (profile && !isAccountActive(profile)) continue
      const email = info.oauthEmail || info.accountEmail || profile?.accountEmail
      const name = (email ? nameForAccount(email) : null) || profile?.name || email || 'Account'

      // 1. Live state is authoritative and self-clearing.
      const window_ = describeAuthWindow(info, Date.now())
      if (window_.tone === 'expired') {
        out.push({ provider: 'claude', id: info.profileId, name, error: window_.label })
        continue
      }
      // 2. A past auth failure counts only while the credentials have NOT been
      //    rewritten since it happened.
      const run = latestRunByAccount.get(insightsAccountKey('claude', info.profileId))
      if (run?.authFailed && authFailureStillApplies(run.timestamp, info, run.authFailedRefreshExpiry)) {
        out.push({ provider: 'claude', id: info.profileId, name, error: run.error })
      }
    }

    // P4.7 (D10): a Codex account whose sign-in reads signed out or expired,
    // or whose latest run failed to sign in and has not signed in since.
    if (codexUsable) {
      for (const a of snapshot?.accounts ?? []) {
        if (a.providerId !== 'codex' || a.lifecycle !== 'active') continue
        const name = codexAccountLabel(accountDisplayName(snapshot, a))
        if (a.lastKnownAuthState === 'signed-out' || a.lastKnownAuthState === 'expired') {
          out.push({ provider: 'codex', id: a.id, name, error: a.lastKnownAuthState === 'expired' ? 'Sign-in expired' : 'Signed out' })
          continue
        }
        const run = latestRunByAccount.get(insightsAccountKey('codex', a.id))
        if (run?.authFailed && !(typeof a.lastAuthenticatedAt === 'number' && a.lastAuthenticatedAt > run.timestamp)) {
          out.push({ provider: 'codex', id: a.id, name, error: run.error })
        }
      }
    }
    return out
  }, [authInfo, catalogue, profiles, accountAliases, snapshot, codexUsable])

  const reauthAccount = useReauthAccount()
  const handleReauth = (entry: ReauthEntry): void => {
    if (entry.provider === 'codex') {
      // A Codex account signs in again from Settings, Accounts.
      window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'accounts' } }))
      return
    }
    const profile = profiles.find((p) => p.id === entry.id)
    // Re-read the credentials when the login lands, so the banner clears itself
    // without the user having to press anything.
    reauthAccount({ id: entry.id, name: profile?.name || entry.name }, () => {
      void loadCatalogue()
      void recheckAuth()
    })
    onNavigateToSessions?.()
  }
  const authBanner = (
    <AuthBanner
      accounts={accountsNeedingReauth}
      checking={checkingAuth}
      onReauth={handleReauth}
      onRecheck={() => {
        void recheckAuth()
        // A Codex account's sign-in is asked of Codex (Check sign-in); the
        // pushed snapshot then updates the banner.
        for (const a of accountsNeedingReauth) if (a.provider === 'codex') void providerAccountActions.checkSignIn(a.id)
      }}
    />
  )

  /** New run, or Run Insights Now, on the account picked. */
  const runSelected = (): void => {
    if (selected.provider === 'codex') {
      if (selected.needsAck) { setConfirming(true); return }
      void startCodexInsights(selected.id)
      return
    }
    void startInsights(selected.id || undefined)
  }
  const runDisabled = isRunning || selectedClaudeOff || selected.disabled
  const confirmPopover = confirming && selected.provider === 'codex' && selected.needsAck ? (
    <CodexRunConfirm
      choice={selected}
      onRun={() => { setConfirming(false); void startCodexInsights(selected.id, true) }}
      onCancel={() => setConfirming(false)}
    />
  ) : null

  const accountPicker = (extraClass: string) => {
    const grouped = claudeChoices.length > 0 && codexChoices.length > 0
    const opt = (c: InsightsAccountChoice) => <option key={c.value} value={c.value} disabled={c.disabled}>{c.label}</option>
    return (
      <select
        value={selected.value}
        onChange={(e) => setRunChoice(e.target.value)}
        className={extraClass}
        title="Account for the next run"
        data-testid="insights-account-picker"
      >
        {grouped ? (
          <>
            <optgroup label="Claude Code">{claudeChoices.map(opt)}</optgroup>
            <optgroup label="Codex">{codexChoices.map(opt)}</optgroup>
          </>
        ) : (
          allChoices.map(opt)
        )}
      </select>
    )
  }

  // Empty state (P4.7, mockup D9: a Codex-only user sees it too, with Run
  // Insights Now; the Claude-only message is gone).
  if (!catalogue || completedRuns.length === 0) {
    return (
      <div className="flex-1 flex flex-col bg-base overflow-hidden">
        {/* Header even in empty state */}
        <div className="px-5 pt-4 pb-3 border-b border-surface0/80 bg-mantle/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-teal">
                <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-text">Insights</h1>
              <p className="text-[11px] text-overlay0 mt-0.5">AI-generated analysis of your workflow</p>
            </div>
          </div>
        </div>

        {/* Shown in the empty state too: an expired sign-in is exactly why there
            may be no reports yet, so this is when it matters most. */}
        {authBanner}

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 16 16" fill="none" className="text-overlay0">
                <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-subtext1 mb-2">{latestRun?.status === 'failed' ? 'Last run failed' : 'No Insights Yet'}</h3>
            {isRunning ? (
              <div className="flex flex-col items-center gap-3">
                <svg className="w-5 h-5 animate-spin text-teal" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs text-teal font-medium">
                  {statusMessage || (status === 'extracting_kpis' ? 'Extracting KPIs...' : 'Generating insights...')}
                </span>
                <span className="text-[11px] text-overlay0">This may take a few minutes</span>
              </div>
            ) : (
              <>
                {latestRun?.status === 'failed' && (
                  <p className="text-xs text-red mb-3 max-w-[260px]" title={latestRun.error || undefined}>
                    {latestRun.error || 'unknown error'}
                  </p>
                )}
                <p className="text-xs text-overlay0 mb-4 max-w-[240px]">Generate an AI-powered analysis of your session history and workflow patterns</p>
                {showPicker && accountPicker('block mx-auto mb-3 bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-1 focus:outline-none focus:border-teal/40')}
                <div className="flex items-center justify-center gap-2">
                  <span className="relative">
                    <button
                      onClick={runSelected}
                      disabled={runDisabled}
                      title={selectedClaudeOff ? CLAUDE_OFF : undefined}
                      data-testid="insights-run-now"
                      className="px-4 py-2 bg-teal/10 border border-teal/25 text-teal rounded-lg hover:bg-teal/20 transition-colors text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Run Insights Now
                    </button>
                    {confirmPopover}
                  </span>
                  {showPicker && (
                    <button
                      onClick={() => startCrossAccount()}
                      disabled={allCount < 2}
                      className="px-4 py-2 bg-surface0 border border-surface1 text-subtext1 rounded-lg hover:border-teal/40 hover:text-teal transition-colors text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                      title={runAllTitle}
                      data-testid="insights-run-all-empty"
                    >
                      {runAllLabel}
                    </button>
                  )}
                </div>
                {selectedClaudeOff && (
                  <p className="text-xs text-overlay0 mt-3 max-w-[260px] mx-auto" data-testid="insights-claude-off">{CLAUDE_OFF}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const insightsIcon = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="8" cy="3" r="2" stroke="currentColor" />
      <path d="M4 8h8M6 6v4M10 6v4M3 12h10" />
    </svg>
  )

  const insightsActions = (
    <>
      <select
        value={selectedRunId || ''}
        onChange={(e) => selectRun(e.target.value)}
        className="bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-0.5 focus:outline-none focus:border-blue/40 transition-colors"
        data-testid="insights-run-picker"
      >
        {pickerRuns.map((run) => {
          const date = new Date(run.timestamp)
          const label = date.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          })
          // An aggregate belongs to every account, so it is labelled by how many
          // it actually compared rather than by one account name. P4.7 (D6): a
          // Codex run always says Codex, with its account's name when the page
          // shows more than one account.
          const acct =
            run.kind === 'aggregate'
              ? `All accounts (${run.memberRunIds?.length ?? run.members?.length ?? 0})`
              : run.provider === 'codex'
                ? showPicker ? codexRunAccountName(snapshot, run.profileId, run.accountEmail) : 'Codex'
                : showPicker
                  ? nameForAccount(run.accountEmail)
                  : null
          const base = acct ? `${label} · ${acct}` : label
          const suffix = run.status === 'failed' ? ' · failed' : run.kpisUnavailable ? ' · no KPIs' : ''
          return <option key={run.id} value={run.id}>{base}{suffix}</option>
        })}
      </select>
      {showPicker && accountPicker('bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-0.5 focus:outline-none focus:border-teal/40 transition-colors')}
      {selectedClaudeOff && (
        <span className="text-[11px] text-overlay0" data-testid="insights-claude-off">{CLAUDE_OFF}</span>
      )}
      <span className="relative">
        <button
          onClick={runSelected}
          disabled={runDisabled}
          title={selectedClaudeOff ? CLAUDE_OFF : undefined}
          data-testid="insights-new-run"
          className={`text-xs px-2.5 py-0.5 rounded border font-medium transition-all flex items-center gap-1.5 ${
            isRunning
              ? 'bg-surface0 border-surface1 text-teal cursor-wait'
              : selectedClaudeOff || selected.disabled
                ? 'bg-surface0 border-surface1 text-overlay0 cursor-not-allowed'
                : 'bg-teal/10 border-teal/30 text-teal hover:bg-teal/20'
          }`}
        >
          {isRunning ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
              </svg>
              {statusMessage || 'Running…'}
            </>
          ) : 'New run'}
        </button>
        {confirmPopover}
      </span>
      {/* Reloads the run catalogue AND re-reads every account's credentials. Both
          change outside this view — a run finishing elsewhere, a sign-in completing
          in a terminal session — and neither pushes an event here. */}
      <button
        onClick={() => { void loadCatalogue(); void recheckAuth() }}
        disabled={checkingAuth}
        title="Reload reports and re-check account sign-ins"
        className="text-xs px-2 py-0.5 rounded text-overlay1 hover:text-text hover:bg-surface0 transition-colors disabled:opacity-60"
      >
        {checkingAuth ? 'Checking…' : 'Refresh'}
      </button>
      {showPicker && (
        <button
          onClick={() => startCrossAccount()}
          disabled={isRunning || batchActive || allCount < 2}
          className={`text-xs px-2.5 py-0.5 rounded border font-medium transition-all ${
            isRunning || batchActive || allCount < 2
              ? 'bg-surface0 border-surface1 text-overlay0 cursor-not-allowed'
              : 'bg-surface0 border-surface1 text-subtext1 hover:border-teal/40 hover:text-teal'
          }`}
          title={runAllTitle}
          data-testid="insights-run-all"
        >
          {runAllLabel}
        </button>
      )}
    </>
  )

  const insightsContext = (
    <>{completedRuns.length} report{completedRuns.length !== 1 ? 's' : ''} generated</>
  )

  // P4.7: a roll-up's columns carry their assistant's mark (D7), read from
  // each member run's own record.
  const providerOfRun = (runId: string) => (catalogue?.runs.find((r) => r.id === runId)?.provider === 'codex' ? 'codex' as const : 'claude' as const)

  return (
    <PageFrame
      icon={insightsIcon}
      iconAccent="teal"
      title="Insights"
      context={insightsContext}
      actions={insightsActions}
      scrollable={false}
    >
      {authBanner}
      {latestRun?.status === 'failed' && (
        <div
          className="px-4 py-1.5 text-[11px] text-red bg-red/10 border-b border-red/20 shrink-0 truncate"
          title={latestRun.error || undefined}
        >
          Last Insights run failed: {latestRun.error || 'unknown error'}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Report native sections */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2.5 text-overlay1">
                <svg className="w-4 h-4 animate-spin text-teal" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs">Loading report...</span>
              </div>
            </div>
          ) : crossAccount && selectedRun ? (
            <CrossAccountReport data={crossAccount} run={selectedRun} nameForAccount={nameForAccount} providerOfRun={providerOfRun} />
          ) : parsed ? (
            <div className="w-full h-full overflow-auto">
              {parsed.title && (
                <div style={{ padding: '16px 16px 0' }}>
                  {selectedIsCodex ? (
                    // P4.7 (D3): Codex's mark, the title, and the one new piece
                    // of help behind a "?"; the subtitle is the app's counts.
                    <>
                      <h2 className="flex items-center gap-2" style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
                        <ProviderMark providerId="codex" size={20} />
                        {parsed.title}
                        <button
                          type="button"
                          aria-label="How this report is made"
                          aria-expanded={helpOpen}
                          onClick={() => setHelpOpen((v) => !v)}
                          data-testid="insights-codex-help"
                          className={`inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] font-semibold leading-none shrink-0 transition-colors ${
                            helpOpen ? 'border-teal text-teal' : 'border-surface2 text-overlay1 hover:text-text'
                          }`}
                        >
                          ?
                        </button>
                      </h2>
                      {helpOpen && (
                        <div
                          className="mt-2 mb-1 max-w-[360px] rounded-lg border px-3 py-2 text-xs"
                          style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
                          data-testid="insights-codex-help-text"
                        >
                          <b style={{ color: 'var(--text-primary)' }}>How this report is made</b>
                          <br />
                          {CODEX_HOW_MADE}
                        </div>
                      )}
                    </>
                  ) : (
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{parsed.title}</h2>
                  )}
                  {parsed.subtitle && <p style={{ color: 'var(--text-muted)' }}>{parsed.subtitle}</p>}
                </div>
              )}
              <InsightsSections sections={parsed.sections} />
            </div>
          ) : selectedRun?.status === 'failed' ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-[340px] px-4">
                <p className="text-sm text-red mb-1">This run failed</p>
                <p className="text-xs text-overlay0 break-words">{selectedRun.error || 'Unknown error'}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-overlay0 text-xs">No report available for this run</p>
            </div>
          )}
        </div>

        {/* KPI Sidebar — or a note when KPIs failed for this completed run.
            An aggregate is full-width: its comparison table already holds every
            metric, and the trend sidebar has no same-account previous run to
            diff against. */}
        {selectedIsAggregate ? null : currentKpis ? (
          <KpiSidebar current={currentKpis} previous={previousKpis} />
        ) : selectedRun?.kpisUnavailable ? (
          <div className="w-72 shrink-0 border-l border-surface0/80 p-4 text-xs text-overlay0">
            <p>Report ready — KPI extraction failed for this run.</p>
            {/* The reason, when the runner captured one. An expired OAuth session
                is a one-click fix the user can only act on if told about it. */}
            {selectedRun?.error && (
              <p className="mt-2 text-red break-words" title={selectedRun.error}>
                {selectedRun.error}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </PageFrame>
  )
}
