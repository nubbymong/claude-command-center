import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
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
      end: next ? next.ts : Infinity,
      email: events[i].email,
    })
  }
  // No backups but a live identity exists -- attribute everything to it.
  if (events.length === 0 && liveEmail) {
    out.push({ start: 0, end: Infinity, email: liveEmail })
  }
  // Copilot review on PR #31 (p9.14): when liveEmail differs from the last
  // backup we DELIBERATELY do not synthesize a transition at
  // `lastBackup.ts + 1`. The precise change time is unknown -- forcing the
  // boundary either makes the last backup's interval 1ms long (orphaning
  // every post-backup session) or misattributes the gap to the new account.
  // The last backup's interval stays open-ended; the wizard surfaces
  // liveEmail as a manual override option (via listKnownEmails below).
  return out
}

/**
 * Collect every email we have evidence for: backup events, the live
 * ~/.claude.json, and legacy accounts.json. Wizard uses this so the user
 * can still pick a real email even when the timeline cannot suggest one
 * (e.g. no backups at all, or the active account is different from every
 * backed-up one).
 *
 * Synchronous, defensive -- never throws.
 */
export function listKnownEmails(): string[] {
  const out = new Set<string>()
  // Backup events
  try {
    const backupsDir = join(homedir(), '.claude', 'backups')
    for (const f of readdirSync(backupsDir)) {
      if (!f.startsWith('.claude.json.backup.')) continue
      try {
        const j = JSON.parse(readFileSync(join(backupsDir, f), 'utf-8'))
        const email = canonicalEmail(j?.oauthAccount?.emailAddress)
        if (email) out.add(email)
      } catch { /* skip unreadable */ }
    }
  } catch { /* no backups dir */ }
  // Live ~/.claude.json
  try {
    const livePath = join(homedir(), '.claude.json')
    const stat = statSync(livePath)
    if (stat.size <= CLAUDE_JSON_MAX_BYTES) {
      const j = JSON.parse(readFileSync(livePath, 'utf-8'))
      const email = canonicalEmail(j?.oauthAccount?.emailAddress)
      if (email) out.add(email)
    }
  } catch { /* no live identity */ }
  // Legacy accounts.json (best-effort)
  try {
    const accountsPath = join(homedir(), '.claude', 'accounts.json')
    for (const email of extractEmailsFromAccountsJson(accountsPath)) {
      out.add(email)
    }
  } catch { /* fine */ }
  return Array.from(out).sort()
}

/**
 * P8.21: read an existing accounts.json (legacy account-manager store)
 * and extract any stored oauthAccount.emailAddress values. The file
 * is NOT modified or deleted -- per spec section 5.5 it stays dormant
 * after the wizard's one-time read.
 *
 * Synchronous (one-shot ~few-KB file).
 */
export function extractEmailsFromAccountsJson(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    const j = JSON.parse(readFileSync(path, 'utf-8'))
    const out = new Set<string>()
    for (const a of (j?.accounts as Array<any> | undefined) ?? []) {
      const email = canonicalEmail(a?.credentials?.oauthAccount?.emailAddress)
      if (email) out.add(email)
    }
    return Array.from(out)
  } catch {
    return []
  }
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
