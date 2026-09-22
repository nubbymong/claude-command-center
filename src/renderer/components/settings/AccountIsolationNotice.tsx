// Layer 4 of the account-isolation hardening, made visible.
//
// Every managed Claude launch runs a preflight in the main process (see
// src/main/managed-launch-diagnostics.ts). Without this component its findings
// reach only app.log, which means a session that started WITHOUT its isolation
// control looks exactly like one that started with it. That is the failure this
// panel exists to prevent: not to claim a session is isolated -- it cannot know
// that, because remote and mid-session settings sources are not locally
// observable -- but to make a MISSING or unverifiable control loud.
//
// Only `blocked` findings are shown. The `info` ones (what the sanitiser
// removed from the settings copy, what the ambient pass stripped) are recorded
// and available on the same channel, but a panel that lists routine activity is
// a panel people stop reading.
import React, { useEffect, useState } from 'react'
import type { PreflightFinding, ManagedLaunchReport } from '../../../shared/providers'

// The SHARED wire type, not a local restatement of it. The local copy made
// `kind` optional and the call site cast to it, so the cast type-checked
// whether or not the main process actually sent the field -- and `kind` is the
// whole point of the probe/launch split (adversarial round 4).
type Report = ManagedLaunchReport

/**
 * The newest report that represents something the USER started.
 *
 * Not simply `reports[0]`. This very panel triggers an `auth status` probe from
 * each account row's mount, and that probe is a real managed launch, so it
 * records a report of its own -- newer than the session it is meant to describe,
 * and carrying no project directory, so it has no project-settings finding.
 * Reading the newest report therefore meant OPENING the panel replaced what the
 * panel was about to show (adversarial review, MAJOR). Probes are still
 * recorded and still logged; they are just not what this answers with.
 *
 * A profile whose ONLY reports are probes falls back to the newest of those:
 * the alternative is showing nothing about a launch that did happen.
 */
function newestUserLaunch(reports: readonly Report[]): Report | undefined {
  return reports.find((r) => r.kind !== 'probe') ?? reports[0]
}

/**
 * What is wrong RIGHT NOW for THIS profile, one row per distinct finding id.
 *
 * Reports are already scoped to one profile by the channel and arrive
 * newest-first. Only the latest is consulted, which is the difference between
 * "is my account isolation OK?" and "has anything ever gone wrong?" -- a user
 * who installs the CLI after seeing `cli-version-unverified`, or fixes the JSON
 * after `settings-copy-refused`, would otherwise keep being told to do the thing
 * they have already done.
 *
 * The per-home merge this replaced was the leak: it folded every account's
 * findings into one list and deduped by finding id, so another account's
 * occurrence was invisible rather than merely unattributed (MAJOR 5).
 */
function findingsOfSeverity(reports: readonly Report[], severity: PreflightFinding["severity"]): PreflightFinding[] {
  const latest = newestUserLaunch(reports)
  if (!latest) return []
  const seen = new Map<string, PreflightFinding>()
  for (const f of latest.preflight.findings) {
    if (f.severity === severity && !seen.has(f.id)) seen.set(f.id, f)
  }
  return [...seen.values()]
}

export function AccountIsolationNotice({ profileId }: { profileId: string }) {
  const [blocked, setBlocked] = useState<PreflightFinding[]>([])
  const [info, setInfo] = useState<PreflightFinding[]>([])
  const [showInfo, setShowInfo] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const reports = await window.electronAPI.accountProfiles?.managedLaunchReports?.(profileId)
        if (cancelled || !reports) return
        setBlocked(findingsOfSeverity(reports, 'blocked'))
        setInfo(findingsOfSeverity(reports, 'info'))
      } catch { /* best-effort: a diagnostic that breaks the panel is worse than none */ }
    })()
    return () => { cancelled = true }
  }, [profileId])

  if (blocked.length === 0 && info.length === 0) return null

  return (
    <div data-testid={`account-isolation-notice-${profileId}`} className="mt-3 space-y-2">
      {blocked.length > 0 && (
        <div
          className="rounded-lg border py-2 px-3"
          style={{ borderColor: 'var(--color-yellow)', backgroundColor: 'color-mix(in srgb, var(--color-yellow) 8%, transparent)' }}
          role="status"
        >
          <p className="text-[11px] font-medium" style={{ color: 'var(--color-yellow)' }}>
            Account isolation could not be confirmed
          </p>
          <ul className="mt-1 space-y-1.5">
            {blocked.map((f) => (
              <li key={f.id} data-testid={`isolation-finding-${f.id}`} className="text-[11px] text-overlay1 leading-relaxed">
                <span className="text-subtext0">{f.title}.</span> {f.detail}
                {f.action && <> <span className="text-subtext0">{f.action}</span></>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {info.length > 0 && (
        <div>
          <button
            onClick={() => setShowInfo((v) => !v)}
            data-testid="isolation-info-toggle"
            className="text-[11px] text-overlay0 hover:text-overlay1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50 rounded"
          >
            {showInfo ? 'Hide' : 'Show'} what account isolation changed for your sessions
          </button>
          {showInfo && (
            <ul className="mt-1 space-y-1.5">
              {info.map((f) => (
                <li key={f.id} data-testid={`isolation-finding-${f.id}`} className="text-[11px] text-overlay0 leading-relaxed">
                  <span className="text-overlay1">{f.title}.</span> {f.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
