import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { TokenomicsSessionRecord } from '../shared/types'

const CLAUDE_JSON_MAX_BYTES = 5 * 1024 * 1024

/**
 * Normalise an email for storage + comparison. Returns null for empty
 * or non-string input so callers can short-circuit cleanly.
 */
export function canonicalEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

interface TimelineInterval {
  start: number
  end: number
  email: string
}

/**
 * Build a sorted timeline of [t_i, t_{i+1}) intervals from the backup
 * snapshots in ~/.claude/backups/. The trailing interval [t_last, +Inf)
 * uses the LIVE ~/.claude.json's email.
 *
 * Defensive parse: backup files with non-numeric timestamps or missing
 * oauthAccount are silently skipped.
 */
export function buildAccountTimeline(): TimelineInterval[] {
  const events: Array<{ ts: number; email: string }> = []
  const backupsDir = join(homedir(), '.claude', 'backups')
  try {
    const files = readdirSync(backupsDir)
    for (const f of files) {
      if (!f.startsWith('.claude.json.backup.')) continue
      const tail = f.split('.').pop()
      const ts = tail ? Number(tail) : NaN
      if (!Number.isFinite(ts)) continue
      try {
        const j = JSON.parse(readFileSync(join(backupsDir, f), 'utf-8'))
        const email = canonicalEmail(j?.oauthAccount?.emailAddress)
        if (email) events.push({ ts, email })
      } catch { /* skip unreadable / malformed */ }
    }
  } catch { /* no backups dir is fine */ }

  // Live trailing interval -- read ~/.claude.json with the same size cap as
  // account-identity to stay consistent.
  let liveEmail: string | null = null
  try {
    const livePath = join(homedir(), '.claude.json')
    const stat = statSync(livePath)
    if (stat.size <= CLAUDE_JSON_MAX_BYTES) {
      const j = JSON.parse(readFileSync(livePath, 'utf-8'))
      liveEmail = canonicalEmail(j?.oauthAccount?.emailAddress)
    }
  } catch { /* fine, just no trailing interval */ }

  events.sort((a, b) => a.ts - b.ts)

  const out: TimelineInterval[] = []
  for (let i = 0; i < events.length; i++) {
    const next = events[i + 1]
    out.push({
      start: events[i].ts,
      end: next ? next.ts : (liveEmail ? Infinity : events[i].ts + 1),
      email: events[i].email,
    })
  }
  // Trailing live interval if the live email differs from the last event's email
  if (liveEmail && events.length > 0 && events[events.length - 1].email !== liveEmail) {
    out[out.length - 1].end = events[events.length - 1].ts + 1
    out.push({ start: events[events.length - 1].ts + 1, end: Infinity, email: liveEmail })
  } else if (liveEmail && events.length === 0) {
    // No backups but live identity exists -- single open interval
    out.push({ start: 0, end: Infinity, email: liveEmail })
  } else if (liveEmail && events.length > 0) {
    // Extend the last interval to +Infinity since live email matches
    out[out.length - 1].end = Infinity
  }
  return out
}

/**
 * Suggest an email for a historic session based on its lastTimestamp.
 * Returns null when the timestamp predates the earliest interval.
 */
export function suggestEmailForSession(
  record: TokenomicsSessionRecord,
  timeline: TimelineInterval[],
): string | null {
  const ts = new Date(record.lastTimestamp).getTime()
  if (!Number.isFinite(ts)) return null
  for (const iv of timeline) {
    if (ts >= iv.start && ts < iv.end) return iv.email
  }
  return null
}
