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
import type { PreflightFinding } from '../../../shared/providers'

interface Report {
  home: string
  sessionId: string
  at: number
  preflight: { ok: boolean; findings: readonly PreflightFinding[] }
}

/**
 * What is wrong RIGHT NOW, one row per distinct finding id.
 *
 * Only the NEWEST report per profile home is consulted, which is the difference
 * between "is my account isolation OK?" and "has anything ever gone wrong?".
 * Scanning every retained report answers the second question and gets the first
 * one wrong in exactly the cases that matter: a user who installs the CLI after
 * seeing `cli-version-unverified`, or fixes the JSON after
 * `settings-copy-refused`, would keep being told to do the thing they have
 * already done until fifty more sessions pushed the stale report out of the
 * ring buffer.
 *
 * Reports arrive newest-first, so the first one seen for a home is its latest.
 */
function currentlyBlocked(reports: readonly Report[]): PreflightFinding[] {
  const latestPerHome = new Map<string, Report>()
  for (const r of reports) if (!latestPerHome.has(r.home)) latestPerHome.set(r.home, r)
  const seen = new Map<string, PreflightFinding>()
  for (const r of latestPerHome.values()) {
    for (const f of r.preflight.findings) {
      if (f.severity === 'blocked' && !seen.has(f.id)) seen.set(f.id, f)
    }
  }
  return [...seen.values()]
}

/** The `info` findings of the newest report per home: what the hardening DID,
 *  as opposed to what it could not confirm. Shown in a quieter, collapsed row
 *  rather than omitted -- the wide ambient strip (endpoint and provider-switch
 *  variables included) changes how a session behaves relative to the user's own
 *  shell, and a change nobody can see is the thing this panel exists to end. */
function currentlyInfo(reports: readonly Report[]): PreflightFinding[] {
  const latestPerHome = new Map<string, Report>()
  for (const r of reports) if (!latestPerHome.has(r.home)) latestPerHome.set(r.home, r)
  const seen = new Map<string, PreflightFinding>()
  for (const r of latestPerHome.values()) {
    for (const f of r.preflight.findings) {
      if (f.severity === 'info' && !seen.has(f.id)) seen.set(f.id, f)
    }
  }
  return [...seen.values()]
}

export function AccountIsolationNotice() {
  const [blocked, setBlocked] = useState<PreflightFinding[]>([])
  const [info, setInfo] = useState<PreflightFinding[]>([])
  const [showInfo, setShowInfo] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const reports = await window.electronAPI.accountProfiles?.managedLaunchReports?.()
        if (cancelled || !reports) return
        setBlocked(currentlyBlocked(reports as Report[]))
        setInfo(currentlyInfo(reports as Report[]))
      } catch { /* best-effort: a diagnostic that breaks the panel is worse than none */ }
    })()
    return () => { cancelled = true }
  }, [])

  if (blocked.length === 0 && info.length === 0) return null

  return (
    <div data-testid="account-isolation-notice" className="mt-3 space-y-2">
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
