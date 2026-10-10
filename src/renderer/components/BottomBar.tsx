import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from './ui/Dialog'
import { useConfigHealthStore } from '../stores/configHealthStore'
import { retryFailedConfigSaves } from '../utils/config-saver'
import { ViewType } from '../types/views'
import MultiAccountStatusline from './MultiAccountStatusline'
import { useRegionTypography } from '../hooks/useTypography'
import { formatInstalledVersion } from '../utils/versionLabel'
import { useClaudeOff } from '../lib/claudeOff'
import { claudeCodeInstallCommand } from '../utils/claudeInstallCommand'
import type { InstallRecipeView, PathHintView } from '../../shared/providers'
import { providerAccountActions } from '../stores/providerAccountsStore'
import { InstallRecipeList, afterInstallMessage, type RunnableRecipe } from '../onboarding/InstallRecipeList'
import { PathHintNotice, cliHelpLooksText } from '../onboarding/PathHintNotice'
import { openInstallTab, useInstallTabRunning, type InstallTab } from '../utils/installTab'

/** Where the confirmation says the line runs. */
const CONFIRM_WHERE = 'Run this in a new terminal tab? It types the line below, and the app checks again when the command ends.'

declare const __BUILD_TIME__: string
declare const __APP_VERSION__: string

interface BottomBarProps {
  currentView: ViewType
  onViewChange: (v: ViewType) => void
  /** Optional graceful update path. When provided, the Update pill defers to
   *  it (App routes through a "save sessions, then restart" close dialog).
   *  Falls back to a direct install + restart when omitted. */
  onUpdateRequested?: () => void
}

// Slim global runtime footer (v2 shell, UAT R2). Pinned full-width at the very
// bottom of <main>. One left-aligned band:
//   CLI status dot + "CLI" + version + Beta pill + Update pill
// The per-session telemetry and the Mode/Model/Compact/Restart controls moved
// up into SessionStatusStrip (above the command rows). The Update pill is now
// the single update affordance -- the big green sidebar toast was removed -- so
// it gently pulses while an update is available. The CLI poll and the
// "CLI not found" help modal stay here so no CLI affordance is lost. The help
// lists main's own Claude Code install commands, Anthropic's native installer
// first, each with Run it for me and Copy (owner decision D2, 2026-10-10;
// ADR-024); when the install tab ends, and on Check again, the app asks main to
// check again (which brings its PATH up to date first) and reads the CLI.
export default function BottomBar({ currentView, onViewChange, onUpdateRequested }: BottomBarProps) {
  void currentView
  const channel = useSettingsStore((s) => s.settings.updateChannel)
  const failedSaveKeys = useConfigHealthStore((s) => s.failedKeys)
  // Status-bars region scale/family (Font & Size page) governs this footer and
  // the multi-account cluster nested inside it.
  const statusType = useRegionTypography('status')

  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [showCliHelp, setShowCliHelp] = useState(false)

  // Escape is the third way out of the CLI help modal (Close and Check again are
  // the other two); only armed while it is open.
  const closeCliHelp = useCallback(() => setShowCliHelp(false), [])
  useDialogEscape(closeCliHelp, showCliHelp)

  // Main's install commands for Claude Code, read each time the help opens
  // (null: main could not give them; the npm command is shown to copy).
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  useEffect(() => {
    if (!showCliHelp) return
    let live = true
    void providerAccountActions.installRecipes('claude').then((r) => { if (live) setRecipes(r) })
    return () => { live = false }
  }, [showCliHelp])
  // The install tab the help opened (one at a time), what the last check
  // after it, or after Check again, found, and whether a check is running.
  const [tab, setTab] = useState<InstallTab | null>(null)
  const tabRunning = useInstallTabRunning(tab)
  const [stillMissing, setStillMissing] = useState<null | 'ended' | 'checked'>(null)
  const [pathHint, setPathHint] = useState<PathHintView | undefined>(undefined)
  const [rechecking, setRechecking] = useState(false)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // Main checks again (bringing its PATH up to date first), then the CLI is
  // read. Still missing after the install tab ended: the help opens again
  // (it closed when the tab opened), so what to do is in front of the user.
  const recheck = async (after: 'ended' | 'checked') => {
    setRechecking(true)
    const r = await providerAccountActions.discover('claude')
    let found = false
    try { found = (await window.electronAPI.cli.check()) === true } catch { found = false }
    if (!mounted.current) return
    setRechecking(false)
    setCliAvailable(found)
    setStillMissing(found ? null : after)
    setPathHint(!found && r.ok ? r.pathHint : undefined)
    if (found) setShowCliHelp(false)
    else if (after === 'ended') setShowCliHelp(true)
  }
  const runInstall = (recipe: RunnableRecipe) => {
    if (tabRunning) return
    setShowCliHelp(false)
    setStillMissing(null)
    setTab(openInstallTab({ label: 'Install Claude Code', runLine: recipe.runLine, show: true, onEnded: () => { void recheck('ended') } }))
  }
  const listed = Array.isArray(recipes) && recipes.some((r) => r.purpose === 'install')

  // Claude Code switched off in Settings, Accounts: there is no Claude CLI
  // to watch, so the indicator is absent, as the bar treats any feature that
  // is not in use (no Beta pill off the beta channel, no Update pill without
  // an update), rather than a red "not found" every 30 s.
  const claudeOff = useClaudeOff()

  // Ported from StatusBar: initial check + 30s poll. Keeps the CLI dot live
  // so the user notices if claude drops off PATH mid-session.
  useEffect(() => {
    if (claudeOff) return
    window.electronAPI.cli.check().then(setCliAvailable)
    const interval = setInterval(() => {
      window.electronAPI.cli.check().then(setCliAvailable)
    }, 30000)
    return () => clearInterval(interval)
  }, [claudeOff])

  // Update availability: check on mount, then re-check on a 30-min interval and
  // when the window regains focus (debounced to <=1/5min). Without this the
  // pill only appeared after a manual restart, so a release cut while the app
  // is open went unnoticed. Each check is a single cheap GitHub release call.
  useEffect(() => {
    const UPDATE_INTERVAL_MS = 30 * 60 * 1000
    const FOCUS_DEBOUNCE_MS = 5 * 60 * 1000
    let lastCheckedAt = 0
    const runCheck = () => {
      lastCheckedAt = Date.now()
      window.electronAPI.update.check().then(setUpdateAvailable)
    }
    runCheck()
    const interval = setInterval(runCheck, UPDATE_INTERVAL_MS)
    const onFocus = () => {
      if (Date.now() - lastCheckedAt >= FOCUS_DEBOUNCE_MS) runCheck()
    }
    window.addEventListener('focus', onFocus)
    const off = window.electronAPI.update.onAvailable((available: boolean) => {
      setUpdateAvailable(available)
    })
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [])

  // py-0.5 gives a wrapped account cluster breathing room instead of butting
  // against the border; min-h-7 is a MINIMUM, so the bar grows to fit it. The
  // old overflow-hidden is gone -- it clipped the cluster rather than letting
  // it wrap, which is what cut the leading account pill against the CLI band.
  return (
    <div
      className="min-h-7 shrink-0 flex items-center gap-3 px-3 py-0.5 text-xs border-t"
      style={{ background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)', borderColor: 'var(--border-subtle)', ...statusType }}
    >
      {/* Runtime band */}
      <div className="flex items-center gap-3 shrink-0">
        {!claudeOff && (
          <button
            className="flex items-center gap-1.5 focus-ring rounded"
            title={cliAvailable ? 'Claude CLI available' : cliAvailable === false ? 'Claude CLI not found -- click for help' : 'Checking CLI...'}
            onClick={() => { if (cliAvailable === false) setShowCliHelp(true) }}
            data-testid="bottom-bar-cli"
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: cliAvailable == null ? 'var(--text-muted)' : cliAvailable ? 'var(--status-success)' : 'var(--status-danger)' }}
            />
            <span className={cliAvailable === false ? 'text-red' : ''}>CLI</span>
          </button>
        )}
        <span title={`Built: ${__BUILD_TIME__}`} className="tabular-nums" style={{ color: 'var(--text-muted)' }}>v{__APP_VERSION__}</span>
        {channel === 'beta' && (
          <button
            onClick={() => onViewChange('settings')}
            className="px-1.5 py-px rounded-full text-[10px] font-medium focus-ring"
            style={{ color: 'var(--brand)', background: 'color-mix(in srgb, var(--brand) 15%, transparent)' }}
            title="Beta channel -- change in Settings"
          >
            Beta
          </button>
        )}
        {/* Ask Conductor deliberately has NO button here (user call 2026-08-21:
            "why do we have two ask conductor buttons — we dont need the one on
            the bottom bar"). The docked pill at the foot of the sidebar is the
            entry point: it is the one that shows whether a session is already
            open, and two controls for one thing in the same corner of the
            window read as two different things. The Feature Guide and Discuss
            on a tip still route to the same place. */}
        {updateAvailable && (
          <button
            onClick={() => { if (onUpdateRequested) onUpdateRequested(); else void Promise.resolve(window.electronAPI.update.installAndRestart()).catch((e: unknown) => console.error('[update] install failed:', e)) }}
            className="footer-update-pulse px-1.5 py-px rounded-full text-[10px] font-medium focus-ring"
            style={{ color: 'var(--status-success)', background: 'color-mix(in srgb, var(--status-success) 15%, transparent)' }}
            title={`Update available -- you're on ${formatInstalledVersion(__APP_VERSION__, channel)} -- click to install and restart`}
          >
            Update
          </button>
        )}
        {failedSaveKeys.length > 0 && (
          <button
            onClick={() => { void retryFailedConfigSaves() }}
            className="px-1.5 py-px rounded-full text-[10px] font-medium focus-ring"
            style={{ color: 'var(--status-danger)', background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)' }}
            title={`Could not save to disk: ${failedSaveKeys.join(', ')} -- recent changes are not persisted. Click to retry.`}
          >
            Save failed
          </button>
        )}
      </div>

      {/* Multi-account usage readout, centred along the footer (Bug 3). Renders
          only when >=2 accounts are live (else null). The flex-1 spacer centres
          it in the space to the right of the runtime band. Pure render over
          session-store data. */}
      {/* No overflow-hidden here. It used to clip the cluster instead of letting
          it wrap, which is what cut the leading account pill in half against the
          runtime band -- `justify-center` spills an over-wide child out of BOTH
          sides, and the clip then hid the left one. The cluster now wraps
          internally, so it is bounded by this zone's width and grows downward;
          the footer's min-h-7 absorbs the extra height. */}
      <div className="flex-1 flex justify-center min-w-0">
        <MultiAccountStatusline />
      </div>

      {/* The independent-project disclaimer that used to be pinned bottom-right
          was removed on the owner's call (#383): the app is AI Code Conductor
          now, and the trademark attribution lives in the README. */}

      {/* CLI help modal: the "CLI not found -- click for help" path. */}
      {showCliHelp && (
        <DialogOverlay>
          <DialogPanel width="w-[600px]" className="max-h-[80vh]" labelledBy="bottombar-cli-help-title" testId="bottombar-cli-help">
            <DialogHeader
              titleId="bottombar-cli-help-title"
              title="Claude CLI Not Found"
              subtitle="AI Code Conductor requires Claude Code CLI to be installed and on your PATH."
            />
            <DialogBody>
              <div className="space-y-3 text-sm">
                {stillMissing && !rechecking && pathHint && (
                  <PathHintNotice
                    hint={pathHint}
                    toolName="Claude Code"
                    providerId="claude"
                    testIdPrefix="bottombar"
                    onAdded={() => { void recheck('checked') }}
                  />
                )}
                {recipes === undefined ? null : listed ? (
                  <div className="install-recipes">
                    <InstallRecipeList
                      purpose="install"
                      recipes={recipes}
                      toolName="Claude Code"
                      testIdPrefix="bottombar"
                      confirmWhere={CONFIRM_WHERE}
                      onRun={runInstall}
                      busyReason={tab && tabRunning ? `Already running in the ${tab.label} tab` : undefined}
                    />
                  </div>
                ) : (
                  <div className="rounded p-3" style={{ background: 'var(--surface-overlay)' }}>
                    <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Install with npm</div>
                    <p className="mb-2" style={{ color: 'var(--text-secondary)' }}>Run this in a terminal (it needs Node.js 22 or later):</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 min-w-0 rounded px-2 py-1 font-mono text-xs select-all" style={{ background: 'var(--surface-base)', color: 'var(--brand)' }} data-testid="bottombar-cli-npm-install-command">
                        {claudeCodeInstallCommand(window.electronPlatform)}
                      </code>
                      <DialogButton
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => {
                          void navigator.clipboard?.writeText(claudeCodeInstallCommand(window.electronPlatform)).then(() => {
                            if (!mounted.current) return
                            setCopied(true)
                            setTimeout(() => { if (mounted.current) setCopied(false) }, 1500)
                          }).catch(() => { /* clipboard blocked: the command is selectable */ })
                        }}
                        testId="bottombar-cli-npm-copy"
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </DialogButton>
                    </div>
                  </div>
                )}

                {stillMissing && !rechecking && !pathHint && (
                  <p className="text-xs" role="status" style={{ color: 'var(--status-warning)' }} data-testid="bottombar-cli-after-install">
                    {afterInstallMessage('Claude Code', { ended: stillMissing === 'ended' })}
                  </p>
                )}

                <div className="rounded p-3" style={{ background: 'var(--surface-overlay)' }}>
                  <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Already installed?</div>
                  <p style={{ color: 'var(--text-secondary)' }} data-testid="bottombar-cli-looks">
                    {cliHelpLooksText(window.electronPlatform)}
                  </p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <DialogButton variant="ghost" onClick={() => setShowCliHelp(false)}>
                Close
              </DialogButton>
              <DialogButton
                variant="primary"
                onClick={() => { void recheck('checked') }}
                disabled={rechecking}
                testId="bottombar-cli-recheck"
              >
                {rechecking ? 'Checking...' : 'Check again'}
              </DialogButton>
            </DialogFooter>
          </DialogPanel>
        </DialogOverlay>
      )}
    </div>
  )
}
