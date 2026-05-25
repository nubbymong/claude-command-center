import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore, DEFAULT_STATUS_LINE } from '../stores/settingsStore'
import { ViewType } from '../types/views'
import RateLimitBar from './terminal/RateLimitBar'
import { formatResetTime } from '../utils/terminalFormatting'
import { useCodexReviewUsage } from '../hooks/useCodexReviewUsage'
import { useRestartSession } from '../hooks/useRestartSession'
import ToolbarPopup from './ToolbarPopup'
import {
  MODELS,
  EFFORTS,
  PERMISSION_MODES,
  shortModelName,
  isModelActive,
} from '../lib/claude-cli-options'

declare const __BUILD_TIME__: string
declare const __APP_VERSION__: string

interface BottomBarProps {
  currentView: ViewType
  onViewChange: (v: ViewType) => void
}

// App-level bottom bar (v2 shell, P4 Task B). One row, three zones:
//   LEFT   runtime: CLI status, version, beta chip, update indicator
//   MIDDLE telemetry for the active session (respects statusLine show* flags)
//   RIGHT  controls (Mode / Model / Compact / Restart) -- Claude only
// Replaces the global StatusBar AND the per-session ContextBar. The CLI poll
// and the "CLI not found" help modal are ported verbatim from StatusBar so no
// CLI affordance is lost.
export default function BottomBar({ currentView, onViewChange }: BottomBarProps) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) || null)
  const sl = useSettingsStore((s) => s.settings.statusLine) || DEFAULT_STATUS_LINE
  const channel = useSettingsStore((s) => s.settings.updateChannel)
  const codexReview = useCodexReviewUsage(session?.enableCodexReview ? activeSessionId : null)
  const { restart } = useRestartSession(session, false)

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

  // Update availability: one-shot check + subscribe to pushed availability.
  useEffect(() => {
    window.electronAPI.update.check().then(setUpdateAvailable)
    const off = window.electronAPI.update.onAvailable((available: boolean) => {
      setUpdateAvailable(available)
    })
    return off
  }, [])

  const [openPicker, setOpenPicker] = useState<'mode' | 'model' | null>(null)
  const [lastMode, setLastMode] = useState<string | null>(null)
  const [lastEffort, setLastEffort] = useState<string | null>(null)
  const isClaude = (session?.provider ?? 'claude') === 'claude'

  const write = (cmd: string) => {
    if (activeSessionId) window.electronAPI.pty.write(activeSessionId, cmd)
  }
  const onMode = (_si: number, v: string) => {
    setLastMode(v)
    write(`/permission-mode ${v}\n`)
    setOpenPicker(null)
  }
  const onModel = (si: number, v: string) => {
    if (si === 0) {
      write(`/model ${v}\n`)
    } else {
      setLastEffort(v)
      write(`/effort ${v}\n`)
    }
    setOpenPicker(null)
  }

  const showCockpit = currentView === 'sessions' && !!session
  const pct = session?.contextPercent ?? 0
  const ctxColor = pct > 85 ? 'var(--status-danger)' : pct >= 70 ? 'var(--status-warning)' : 'var(--text-muted)'

  return (
    <div
      className="h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t"
      style={{ background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)', borderColor: 'var(--border-subtle)' }}
    >
      {/* LEFT -- runtime */}
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
            onClick={() => window.electronAPI.update.installAndRestart()}
            className="px-1.5 py-px rounded-full text-[10px] font-medium focus-ring"
            style={{ color: 'var(--status-success)', background: 'color-mix(in srgb, var(--status-success) 15%, transparent)' }}
            title="Update available -- click to install and restart"
          >
            Update
          </button>
        )}
      </div>

      <span className="w-px self-stretch my-1.5" style={{ background: 'var(--border-subtle)' }} aria-hidden />

      {/* MIDDLE -- telemetry */}
      <div className="flex items-center gap-3 flex-1 min-w-0 overflow-hidden">
        {showCockpit && (
          <>
            {sl.showModel && session!.modelName && (
              <span className="font-medium truncate shrink-0">
                {session!.modelName}
                {session!.reasoningEffort && (
                  <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>{session!.reasoningEffort}</span>
                )}
              </span>
            )}
            {sl.showContextBar && session!.contextPercent != null && (
              <span className="flex items-center gap-1.5 shrink-0">
                <span className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
                  <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: ctxColor }} />
                </span>
                <span className="tabular-nums">{Math.round(pct)}%</span>
              </span>
            )}
            {sl.showCost && session!.costUsd != null && (
              <span className="tabular-nums shrink-0" title="API equivalent cost (not billed on Max plan)">API eq ${session!.costUsd.toFixed(4)}</span>
            )}
            {sl.showLinesChanged && session!.linesAdded != null && (
              <span className="tabular-nums shrink-0" style={{ color: 'color-mix(in srgb, var(--status-success) 70%, var(--text-secondary))' }}>+{session!.linesAdded}</span>
            )}
            {sl.showLinesChanged && session!.linesRemoved ? (
              <span className="tabular-nums shrink-0" style={{ color: 'color-mix(in srgb, var(--status-danger) 70%, var(--text-secondary))' }}>-{session!.linesRemoved}</span>
            ) : null}
            {sl.showRateLimits && session!.rateLimitCurrent != null && (
              <span className="flex items-center gap-3 shrink-0">
                <RateLimitBar label="5h" pct={session!.rateLimitCurrent} resets={session!.rateLimitCurrentResets} />
                {session!.rateLimitWeekly != null && (
                  <RateLimitBar label="7d" pct={session!.rateLimitWeekly} resets={session!.rateLimitWeeklyResets} />
                )}
              </span>
            )}
            {sl.showResetTime && session!.rateLimitCurrentResets && (
              <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }} title="5h window resets">resets {formatResetTime(session!.rateLimitCurrentResets)}</span>
            )}
            {codexReview && codexReview.reviewCount > 0 && (
              <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>review {codexReview.reviewCount}</span>
            )}
          </>
        )}
      </div>

      {/* RIGHT -- controls (Claude only) */}
      {showCockpit && isClaude && (
        <>
          <span className="w-px self-stretch my-1.5" style={{ background: 'var(--border-subtle)' }} aria-hidden />
          <div className="flex items-center gap-1 shrink-0">
            <div className="relative">
              <button
                onClick={() => setOpenPicker(openPicker === 'mode' ? null : 'mode')}
                className="px-2 py-0.5 rounded bg-surface0/50 hover:bg-surface0 border border-surface1/40 focus-ring"
                title="Permission mode"
              >
                Mode
              </button>
              {openPicker === 'mode' && (
                <ToolbarPopup
                  sections={[{ title: 'Mode', items: PERMISSION_MODES.map((m) => ({ ...m, active: m.value === lastMode })) }]}
                  onSelect={onMode}
                  onClose={() => setOpenPicker(null)}
                />
              )}
            </div>
            <div className="relative">
              <button
                onClick={() => setOpenPicker(openPicker === 'model' ? null : 'model')}
                className="px-2 py-0.5 rounded bg-surface0/50 hover:bg-surface0 border border-surface1/40 focus-ring"
                title="Model"
              >
                <span className="text-blue">{shortModelName(session!.modelName)}</span>
              </button>
              {openPicker === 'model' && (
                <ToolbarPopup
                  alignRight
                  sections={[
                    {
                      title: 'Models',
                      items: MODELS.map((m) => ({ ...m, active: isModelActive(m.value, session!.modelName || session!.model || '') })),
                    },
                    {
                      title: 'Effort',
                      items: EFFORTS.map((e) => ({ ...e, active: e.value === lastEffort })),
                    },
                  ]}
                  onSelect={onModel}
                  onClose={() => setOpenPicker(null)}
                />
              )}
            </div>
            <button
              onClick={() => write('/compact\n')}
              className="px-2 py-0.5 rounded bg-surface0/50 hover:bg-surface0 border border-surface1/40 focus-ring"
              title="Compact the conversation"
            >
              Compact
            </button>
            <button
              onClick={restart}
              className="px-2 py-0.5 rounded text-overlay1 hover:text-text hover:bg-surface0 focus-ring"
              title="Restart session"
            >
              Restart
            </button>
          </div>
        </>
      )}

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
