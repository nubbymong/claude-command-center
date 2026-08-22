import React, { useEffect, useMemo, useState, useCallback } from 'react'
import ChatTranscriptView from './logs/ChatTranscriptView'
import LogEmptyState, { type LogEmptyReason } from './logs/LogEmptyState'
import { useWindowedTurns, type Logs2Scope } from '../hooks/useWindowedTurns'
import { useLogsStore } from '../stores/useLogsStore'
import { useSessionStore } from '../stores/sessionStore'
import { sessionCapabilities } from '../lib/session-capabilities'
import { useConfigStore } from '../stores/configStore'
import { useSettingsStore } from '../stores/settingsStore'

interface Props {
  sessionId: string
}

/**
 * Per-session Logs alt pane (Logs v2). Shows THIS session's chat transcript
 * (the same presentational ChatTranscriptView used by the global Logs view),
 * scoped to the live slot and follow-mode ON by default so new turns tail.
 *
 * The pane renders an honest empty state INSTEAD of the transcript when there is
 * nothing (or nothing that will ever be) indexed for this session:
 *   - shell-only      — shells don't run Claude, no transcript
 *   - SSH remote      — the transcript lives on the remote host (named regression)
 *   - Codex           — different format, not indexed (named regression)
 *   - indexing off    — global master switch OR per-config opt-out
 *   - no transcript   — nothing detected yet; shows the watched cwd (diagnosable)
 *
 * NOTE (partner fold): the partner terminal is a SEPARATE session keyed
 * `<sessionId>-partner` (shellOnly), so this pane shows only the base session's
 * conversation. A partner shell renders the shell-only empty state.
 */
export default function LogsPane({ sessionId }: Props) {
  const togglePane = useLogsStore((s) => s.togglePane)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const config = useConfigStore((s) => s.configs.find((c) => c.id === session?.configId))
  const globalLogging = useSettingsStore((s) => s.settings.loggingEnabled)

  const handleClose = useCallback(() => togglePane(sessionId), [togglePane, sessionId])

  // ---- Decide whether (and why) a transcript can't be shown -----------------
  // Mirrors the main-process shouldRegisterRun predicate so the pane never
  // promises a transcript a session can't produce.
  const provider = session?.provider ?? 'claude'
  const isShell = !!session?.shellOnly
  const isSSH = session?.sessionType === 'ssh'
  const isCodex = provider === 'codex'
  // Per-config opt-out. The toggle's persistence on claudeOptions lands with
  // T16 (SessionDialog "Index conversation logs"); read it defensively so this
  // already honours it once T16 adds the field — DEFAULT-TRUE (only false off).
  const perConfigOff =
    (config?.claudeOptions as { loggingEnabled?: boolean } | undefined)?.loggingEnabled === false
  const loggingOff = globalLogging === false || perConfigOff

  // Precedence: structural reasons (can never index) before logging-off before
  // no-transcript-yet. shell-only first because a shell has no Claude at all.
  // ONE source of truth for "can this session have a transcript": the command
  // bar and the Logs button read the same function (lib/session-capabilities),
  // so the pane and the bar cannot drift. (ADR-018 D2)
  const structuralReason: LogEmptyReason | null = sessionCapabilities(session).logsEmptyReason
  void isShell; void isSSH; void isCodex

  // ---- no-transcript-yet detection via ingestStatus -------------------------
  // Only relevant when the session COULD index (no structural reason, logging on).
  const canIndex = !structuralReason && !loggingOff
  const [hasTranscript, setHasTranscript] = useState<boolean | null>(canIndex ? null : false)

  useEffect(() => {
    if (!canIndex) { setHasTranscript(false); return }
    let active = true
    let id: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (id !== null) { clearInterval(id); id = null } }
    const check = async () => {
      try {
        const st = await window.electronAPI.logs2.ingestStatus({ sessionId })
        if (!active) return
        // A bound, non-empty transcript means there IS a conversation to render.
        const detected = !!st && (st.transcripts.length > 0 || st.messageCount > 0)
        setHasTranscript(detected)
        // Once a transcript exists the live-follow hook takes over — stop polling.
        if (detected) stop()
      } catch {
        if (active) setHasTranscript(false)
      }
    }
    void check()
    // Poll while no transcript is detected yet so the empty state flips to the
    // transcript as soon as the first turn is ingested for a fresh session.
    id = setInterval(() => { void check() }, 2000)
    return () => { active = false; stop() }
  }, [sessionId, canIndex])

  const scope: Logs2Scope = useMemo(() => ({ sessionId }), [sessionId])

  // Resolve the empty reason (if any) for the chrome.
  let emptyReason: LogEmptyReason | null = structuralReason
  if (!emptyReason && loggingOff) emptyReason = 'logging-off'
  if (!emptyReason && hasTranscript === false) emptyReason = 'no-transcript'

  const watchedCwd = session?.workingDirectory ?? config?.workingDirectory ?? null

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Pane chrome. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
        <span className="text-[11px] font-medium text-subtext1">Conversation</span>
        <div className="flex-1" />
        {emptyReason === null && (
          <span className="flex items-center gap-1 text-[10px] text-green shrink-0" title="Live-following the conversation">
            <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
            Live
          </span>
        )}
        <button
          onClick={handleClose}
          className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors shrink-0"
          title="Close conversation"
        >
          Close
        </button>
      </div>
      {emptyReason !== null ? (
        <LogEmptyState reason={emptyReason} watchedCwd={emptyReason === 'no-transcript' ? watchedCwd : null} />
      ) : (
        <SessionTranscript scope={scope} />
      )}
    </div>
  )
}

/** Owns the shared windowing hook for the in-session transcript (follow ON). */
function SessionTranscript({ scope }: { scope: Logs2Scope }) {
  const win = useWindowedTurns(scope)
  return (
    <ChatTranscriptView
      messages={win.messages}
      follow={win.follow}
      setFollow={win.setFollow}
      loading={win.loading}
      loadingOlder={win.loadingOlder}
      error={win.error}
      loadOlder={win.loadOlder}
      prependToken={win.prependToken}
      jumpTarget={win.jumpTarget}
      className="flex-1 px-3"
    />
  )
}
