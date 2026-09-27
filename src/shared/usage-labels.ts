// Labels and small time rules for usage figures, shared by main (which builds
// the buckets) and the renderer (the Account usage page, the footer and the
// session strip). Pure: no Node or DOM imports.

import type { UsageBucket } from './usage-types'
import type { ProviderId } from './types'
import { isProviderId } from './providers/ids'

/** The provider the multi-account footer's older, bare hidden labels belong
 *  to (usage track MP6): they were written when the footer showed only Claude
 *  Code's meters. Newer entries name their provider (`<provider>:<label>`). */
export const FOOTER_BARE_LABEL_PROVIDER: ProviderId = 'claude'

/**
 * One entry of the footer's hidden list, read: `<provider>:<label>` names its
 * provider; anything else is a bare label of FOOTER_BARE_LABEL_PROVIDER's (a
 * colon that names no provider is part of the label). Null for a value that
 * is not an entry. The one reader: the footer, Settings and the migration all
 * use it, so they cannot disagree about an entry.
 */
export function parseFooterHiddenEntry(entry: unknown): { providerId: ProviderId; label: string; scoped: boolean } | null {
  if (typeof entry !== 'string' || !entry) return null
  const i = entry.indexOf(':')
  const prefix = i > 0 ? entry.slice(0, i) : ''
  if (isProviderId(prefix)) return { providerId: prefix, label: entry.slice(i + 1), scoped: true }
  return { providerId: FOOTER_BARE_LABEL_PROVIDER, label: entry, scoped: false }
}

/** The labels the footer's hidden list hides for one provider. */
export function footerHiddenLabelsFor(hidden: readonly unknown[], providerId: ProviderId): string[] {
  const out: string[] = []
  for (const entry of hidden) {
    const e = parseFooterHiddenEntry(entry)
    if (e && e.providerId === providerId && !out.includes(e.label)) out.push(e.label)
  }
  return out
}

const MINUTES_PER_DAY = 1440
const MINUTES_PER_WEEK = 10080

/**
 * The label a window of `minutes` reads as (Q1.3 of the approved usage UX):
 * 300 is "5h", 10080 is "Weekly", whole days read in days ("3d"), other whole
 * hours in hours ("12h"). A length that is not a whole hour reads in minutes
 * ("90m") rather than being rounded into a window it is not. Null for a
 * missing or nonsensical length, so the caller decides what an unknown window
 * reads as.
 */
export function windowLabel(minutes: number | null | undefined): string | null {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) return null
  if (minutes === MINUTES_PER_WEEK) return 'Weekly'
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * Short code for a bucket label, for the compact (multi-account footer) form.
 *
 * The footer shows one row per account, each with every bucket, so the words
 * repeat across the whole strip and crowd out the thing you actually read, the
 * coloured bar. Labels come from the API and are open-ended (5h, Weekly, then a
 * bucket per model), so this is a rule rather than a fixed list.
 *
 * Only the fixed TIME windows shorten. "5h" is already minimal and Weekly goes
 * to a single "W"; both are positional and unambiguous once seen. Model
 * buckets keep their full name: "Fable" is the label actually worth scanning
 * for, and truncating it ("Fab") saves a few pixels at the cost of the one
 * label that has to stay legible as new models are added.
 */
export function shortBucketLabel(label: string): string {
  const l = label.trim()
  if (/^\d+\s*h$/i.test(l)) return l.replace(/\s+/g, '').toLowerCase()  // "5h", "5 H" -> 5h
  if (/^week(ly)?$/i.test(l)) return 'W'
  return l
}

/**
 * D2 (approved as drawn): a window whose reset time has passed has no current
 * figure, so the page reads "no reading since" and the footer and strip show a
 * static no-reading meter. True from the reset instant on; false when the
 * reset time is missing or unreadable (there is nothing to compare).
 */
export function bucketPastReset(bucket: Pick<UsageBucket, 'resetsAt'>, now: number): boolean {
  const t = Date.parse(bucket.resetsAt)
  return Number.isFinite(t) && t <= now
}

/**
 * How long ago `ts` was, in the page's words: "just now", "N min ago",
 * "N h ago", "N day(s) ago". Whole units, rounded down, so a reading never
 * looks newer than it is. A time in the future reads "just now"; an unreadable
 * one reads as nothing.
 */
export function relAgo(ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return ''
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes === 1 ? '1 min ago' : `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}
