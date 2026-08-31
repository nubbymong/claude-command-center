import React from 'react'
import { useResumeLaunchStore } from '../stores/resumeLaunchStore'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useDetachedLivenessStore } from '../stores/livenessStore'
import { useLaunchSessionAction } from '../hooks/useLaunchConfig'
import { persistSessionState } from '../session-persistence'
import { describeDetachedAge } from '../utils/detachedRemotes'
import { offerableEntries, hasUnverifiedOffer, type EntryLiveness } from '../utils/detachedRemotesLiveness'
import type { DetachedRemote } from '../../shared/types'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, DialogCallout, useDialogEscape } from './ui/Dialog'

// SSH Persistent — "Resume a Running Session" (Phase 2 UI). When a MANUAL config
// launch finds a remote the user LEFT RUNNING (see useLaunchConfig's resume
// gate), this dialog offers to reattach it instead of minting a fresh session
// that would strand the old one. Resume reuses the remote's original session id
// (so the tmux target matches); Start fresh is today's behaviour; Cancel launches
// nothing. Backdrop never closes on click (repo convention) — Escape / Cancel are
// the exits. No account chip renders a credential — accountEmail is a descriptor.
//
// Liveness: the gate fired a host probe when it opened this dialog. As it returns,
// rows reconcile against the liveness map — a CONFIRMED-dead remote is withheld
// (offerableEntries), an unreachable host's rows are marked "couldn't verify"
// (fail-open — still offered), and a still-checking row shows a spinner with its
// Resume disabled. If every row is confirmed dead, the dialog collapses to an
// empty state so the user starts fresh rather than reattaching a ghost.
export default function ResumeSessionDialog() {
  const pending = useResumeLaunchStore((s) => s.pending)
  const clear = useResumeLaunchStore((s) => s.clear)
  const removeEntry = useDetachedRemotesStore((s) => s.remove)
  const bySession = useDetachedLivenessStore((s) => s.bySession)
  const launch = useLaunchSessionAction()
  useDialogEscape(pending ? clear : undefined)

  if (!pending) return null
  const { config, entries } = pending
  const now = Date.now()
  // Fail-open: show everything except a CONFIRMED-dead remote.
  const visible = offerableEntries(entries, bySession)
  const showUnverifiedNote = hasUnverifiedOffer(entries, bySession)

  // Phase 3: reattach by reusing the entry's ORIGINAL session id + the reconnect
  // flag, then drop the registry entry (best-effort staleness — if the remote
  // tmux is gone the wrapper falls through to a fresh create, and the entry is
  // dropped regardless so it stops being offered).
  const resume = (entry: DetachedRemote) => {
    launch(config, { sessionId: entry.sessionId, reconnect: true })
    removeEntry(entry.sessionId)
    void persistSessionState()
    clear()
  }
  // Start fresh: today's behaviour — a brand-new session id. The left-running
  // remote stays registered and alive (the user chose a new one alongside it).
  const startFresh = () => {
    launch(config)
    clear()
  }

  const allDead = visible.length === 0

  return (
    <DialogOverlay position="absolute" z="z-[60]" testId="resume-session-dialog">
      <DialogPanel width="w-[480px]" labelledBy="resume-session-heading">
        <DialogHeader
          titleId="resume-session-heading"
          title={<>Resume a running session?</>}
          subtitle={allDead ? (
            <>The {entries.length === 1 ? 'session' : 'sessions'} you left running for{' '}
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{config.label}</span> {entries.length === 1 ? 'is' : 'are'} no longer on the host.</>
          ) : (
            <>You left {visible.length === 1 ? 'a session' : `${visible.length} sessions`} running on the remote host for{' '}
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{config.label}</span>. Reattach instead of starting a new one.</>
          )}
        />
        <DialogBody>
          {allDead ? (
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              No running session was found on the host — it may have ended or the machine was rebooted.
              Start a fresh session below.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map((e) => {
                const state = bySession[e.sessionId]
                const checking = state === 'checking'
                return (
                  <div
                    key={e.sessionId}
                    className="flex items-center gap-3 rounded-[9px] border px-3 py-2.5"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-base)' }}
                    data-testid="resume-session-entry"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[12px] truncate flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                        {e.username}@{e.host}
                        <LivenessChip state={state} />
                      </div>
                      <div className="text-[11px] mt-0.5 leading-snug truncate" style={{ color: 'var(--text-muted)' }}>
                        {e.accountEmail ? <><span className="font-mono">{e.accountEmail}</span>{' · '}</> : null}
                        left running {describeDetachedAge(e.detachedAt, now)}
                      </div>
                    </div>
                    <DialogButton variant="primary" onClick={() => resume(e)} disabled={checking} testId="resume-session-resume">
                      {checking ? 'Checking…' : 'Resume'}
                    </DialogButton>
                  </div>
                )
              })}
              {showUnverifiedNote && (
                <DialogCallout tone="warning" testId="resume-session-unverified">
                  Couldn’t reach the host to confirm these are still running — offering them anyway.
                  Reattaching will pick the session back up, or start fresh if it has ended.
                </DialogCallout>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="ghost" onClick={clear} testId="resume-session-cancel">Cancel</DialogButton>
          <DialogButton variant={allDead ? 'primary' : 'secondary'} onClick={startFresh} testId="resume-session-fresh">Start fresh</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

/** Small per-row liveness marker. 'live' is left unlabelled (the default, happy
 *  case); only the states worth calling out get a chip. */
function LivenessChip({ state }: { state: EntryLiveness | undefined }) {
  if (state === 'checking') {
    return <span className="inline-block w-2 h-2 rounded-full animate-pulse shrink-0" style={{ background: 'var(--brand)' }} aria-label="Checking" />
  }
  if (state === 'unverified') {
    return <span className="text-[10px] px-1.5 rounded-full shrink-0" style={{ background: 'color-mix(in srgb, var(--status-warning) 16%, transparent)', color: 'var(--status-warning)' }}>couldn’t verify</span>
  }
  if (state === 'live') {
    return <span className="text-[10px] px-1.5 rounded-full shrink-0" style={{ background: 'color-mix(in srgb, var(--status-success) 16%, transparent)', color: 'var(--status-success)' }}>running</span>
  }
  return null
}
