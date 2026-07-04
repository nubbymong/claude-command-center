import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useConfigHealthStore } from '../stores/configHealthStore'
import { retryFailedConfigSaves } from '../utils/config-saver'
import { ViewType } from '../types/views'
import MultiAccountStatusline from './MultiAccountStatusline'
import { useRegionTypography } from '../hooks/useTypography'

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
// "CLI not found" help modal stay here verbatim so no CLI affordance is lost.
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

  // Ported from StatusBar: initial check + 30s poll. Keeps the CLI dot live
  // so the user notices if claude drops off PATH mid-session.
  useEffect(() => {
    window.electronAPI.cli.check().then(setCliAvailable)
    const interval = setInterval(() => {
      window.electronAPI.cli.check().then(setCliAvailable)
    }, 30000)
    return () => clearInterval(interval)
  }, [])

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

  return (
    <div
      className="min-h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t"
      style={{ background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)', borderColor: 'var(--border-subtle)', ...statusType }}
    >
      {/* Runtime band */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          className="flex items-center gap-1.5 focus-ring rounded"
          title={cliAvailable ? 'Claude CLI available' : cliAvailable === false ? 'Claude CLI not found -- click for help' : 'Checking CLI...'}
          onClick={() => { if (cliAvailable === false) setShowCliHelp(true) }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: cliAvailable == null ? 'var(--text-muted)' : cliAvailable ? 'var(--status-success)' : 'var(--status-danger)' }}
          />
          <span className={cliAvailable === false ? 'text-red' : ''}>CLI</span>
        </button>
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
        {updateAvailable && (
          <button
            onClick={() => { if (onUpdateRequested) onUpdateRequested(); else window.electronAPI.update.installAndRestart() }}
            className="footer-update-pulse px-1.5 py-px rounded-full text-[10px] font-medium focus-ring"
            style={{ color: 'var(--status-success)', background: 'color-mix(in srgb, var(--status-success) 15%, transparent)' }}
            title="Update available -- click to install and restart"
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
          it between the runtime band and the disclaimer, and keeps the disclaimer
          pinned right when single-account. Pure render over session-store data. */}
      <div className="flex-1 flex justify-center min-w-0 overflow-hidden">
        <MultiAccountStatusline />
      </div>

      {/* Independent-project disclaimer, pinned bottom-right. Nominative use of
          "Anthropic"/"Claude" only; this app is not an Anthropic product. */}
      <span
        className="shrink truncate italic text-[10px]"
        style={{ color: 'var(--text-muted)' }}
        title="Claude and Claude Code are trademarks of Anthropic, PBC. This is an independent community project."
      >
        Not affiliated with or endorsed by Anthropic
      </span>

      {/* CLI help modal -- ported verbatim from StatusBar so the
          "CLI not found -- click for help" path still works. */}
      {showCliHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[480px] max-h-[80vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-text mb-3">Claude CLI Not Found</h2>
            <p className="text-sm text-subtext0 mb-4">
              Claude Command Center requires Claude Code CLI to be installed and on your PATH.
            </p>

            <div className="space-y-3 text-sm">
              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Option 1: Native Installer (Recommended)</div>
                <p className="text-subtext0 mb-2">Run this in any terminal:</p>
                <code className="block bg-base rounded px-2 py-1 text-blue font-mono text-xs select-all">
                  claude install
                </code>
                <p className="text-overlay0 text-xs mt-1">
                  Installs to ~/.local/bin/claude.exe
                </p>
              </div>

              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Option 2: npm</div>
                <code className="block bg-base rounded px-2 py-1 text-blue font-mono text-xs select-all">
                  npm install -g @anthropic-ai/claude-code
                </code>
              </div>

              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Already installed?</div>
                <p className="text-subtext0">
                  Make sure the claude binary is on your system PATH. For the native installer,
                  add <code className="text-blue">%USERPROFILE%\.local\bin</code> to your PATH environment variable.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowCliHelp(false)
                  window.electronAPI.cli.check().then(setCliAvailable)
                }}
                className="px-3 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80"
              >
                Re-check
              </button>
              <button
                onClick={() => setShowCliHelp(false)}
                className="px-3 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
