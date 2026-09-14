// src/main/channel-attachments.ts
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { channelsDir } from './channel-storage'

// 2 MB decoded cap -- allows base64 overhead over the spec's 1 MB post-encode image limit.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024

// Matches channel-ledger.ts's own retention window, so an attachment never
// outlives (or is reaped much before) the ledger record that references it.
const ATTACHMENT_RETENTION_DAYS = 30

function attachmentsDir(): string {
  return join(channelsDir(), 'attachments')
}

// Persists a data URL (or raw base64) to conductor-channels/attachments/<id>.<ext>
// and returns the absolute path. CC reads files reliably; we never embed base64.
export function persistAttachment(dataUrl: string, ext: 'png' | 'txt'): string {
  const dir = attachmentsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment exceeds size cap')
  const path = join(dir, `${Date.now().toString(36)}.${ext}`)
  writeFileSync(path, buffer)
  return path
}

/**
 * Deletes attachments older than `retentionDays`. The ledger files that
 * reference them already rotate (channel-ledger.ts rotateLedgers, 30-day
 * default) but the attachments themselves were exempt, so screenshot-heavy
 * channel traffic grew `attachments/` without bound (#487 audit).
 *
 * The filename IS a base-36 `Date.now()` (see persistAttachment above), so age
 * is derived from the name -- no per-file stat() needed. A name that doesn't
 * parse as our timestamp format is left alone rather than guessed at.
 *
 * The whole-string base36 guard below is NOT sufficient by itself (round-1
 * adversarial finding, BLOCKER): any all-base36 stem -- "logo", "note",
 * "icon", "Thumbs", "README" -- still parses via parseInt(stem, 36) into some
 * number, and every one of those happens to land in 1970, so `ts < cutoff`
 * was true and the file was deleted. Guaranteed real-world victim on Windows:
 * Thumbs.db. Two further checks are required before a stem is trusted as OUR
 * timestamp: it must ROUND-TRIP back to itself (rejects any stem that parsed
 * but isn't actually the canonical base-36 encoding of its own value, and
 * -- by comparing against the lowercased stem -- the case-insensitive hole
 * the old regex's `/i` flag left open), and it must fall inside a PLAUSIBLE
 * epoch-ms window (this repo postdates 2020; nothing genuine is ever
 * millions of ms since epoch, which is what a short English word parses to).
 * A stem that fails either check is left alone, never deleted.
 */
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2020, 0, 1)

export function reapAttachments(now: Date = new Date(), retentionDays: number = ATTACHMENT_RETENTION_DAYS): void {
  const dir = attachmentsDir()
  if (!existsSync(dir)) return
  const cutoff = now.getTime() - retentionDays * 86_400_000
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const dotIndex = name.lastIndexOf('.')
    const stem = dotIndex === -1 ? name : name.slice(0, dotIndex)
    // parseInt(str, 36) parses only a leading valid-base36 PREFIX and ignores
    // the rest -- "not-a-timestamp" would silently parse as "not" and return a
    // small, very-old-looking number. Require the whole stem to be base36
    // first, or an unrelated filename could be misread as an ancient
    // timestamp and deleted.
    if (!/^[0-9a-z]+$/i.test(stem)) continue
    const ts = parseInt(stem, 36)
    if (!Number.isFinite(ts)) continue
    // Round-trip: reject any stem that parses but isn't ACTUALLY the
    // canonical lowercase base-36 encoding of `ts` (coincidental words,
    // leading zeros, mixed case).
    if (ts.toString(36) !== stem.toLowerCase()) continue
    // Plausibility bound: reject anything outside a sane epoch-ms window
    // (before 2020, or in the future relative to `now`) -- this is what
    // actually stops "logo"/"note"/"Thumbs"/"README", all of which round-trip
    // cleanly but parse to a handful of days/minutes/hours after 1970-01-01.
    if (ts < MIN_PLAUSIBLE_TIMESTAMP_MS || ts > now.getTime()) continue
    if (ts < cutoff) {
      try { unlinkSync(join(dir, name)) } catch { /* best effort */ }
    }
  }
}
