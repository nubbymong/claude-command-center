import React from 'react'

/**
 * The docked SSH host pill (#570, canvas "rc.10 UX fixes" v4, approved
 * 2026-08-30): the remote host, bottom-left of the MAIN terminal pane, riding
 * just above the statusline. It replaces the host-in-a-MachineBadge treatment
 * that overhung the command buttons — the cluster badges now only say which
 * side ("this PC" / "remote"), and the host itself lives here.
 *
 * Terminal view ONLY (R4 note a7): it is mounted inside the main terminal
 * PaneFade, so the canvas, browser, logs and partner surfaces can never show
 * it — placement enforces the rule, no visibility state to get stale.
 *
 * Display-only: pointer-events none, so clicks and selection fall through to
 * the terminal under it; aria-hidden because the session header already
 * announces "SSH: user@host" accessibly.
 */
export default function SshHostPill({ host }: { host: string | undefined }) {
  if (!host) return null
  return (
    <span className="ssh-host-pill" aria-hidden="true" data-testid="ssh-host-pill">
      {host}
    </span>
  )
}
