// P3.9 round 2: how Sentinel's analysis findings are read and shown. One
// normalisation serves the display, the quote check and the finding ids, so
// what is checked is what is shown.
import { createHash } from 'crypto'
import { stripSpoofableText } from '../../shared/safe-text'

/** The shortest quote that counts as evidence (after normalisation). */
export const QUOTE_MIN_CHARS = 16

/** Longest text the normalisation reads (the notes sent are far shorter). */
const NORMALISE_MAX = 1_000_000

/** The text as a finding shows it and as the quote check reads it: NFC, no
 *  control, bidi or zero-width characters (each a space), whitespace
 *  collapsed. */
export function normaliseQuoteText(t: string): string {
  return stripSpoofableText(String(t).normalize('NFC'), NORMALISE_MAX).replace(/\s+/g, ' ').trim()
}

/** A quote as the model gave it, without the quotation marks around it. */
function bareQuote(evidence: string): string {
  return normaliseQuoteText(evidence).replace(/^["'`]+|["'`]+$/g, '').trim()
}

/** A finding's evidence counts only as ONE passage copied from the notes it
 *  was sent: after the same normalisation on both sides, one contiguous
 *  piece of them, at least QUOTE_MIN_CHARS long. Anything else (a file the
 *  model read, a paraphrase, text spelled out a character per line) is not
 *  evidence. */
export function evidenceIsQuoted(evidence: string, notes: string): boolean {
  const q = bareQuote(evidence)
  return q.length >= QUOTE_MIN_CHARS && normaliseQuoteText(notes).includes(q)
}

/** A finding's id suffix: from its evidence alone (the checked quote), so the
 *  same passage keeps its id however the model words the title. */
export function quoteKey(evidence: string): string {
  return createHash('sha256').update(bareQuote(evidence)).digest('hex').slice(0, 12)
}

/** The analysis findings of one version that say the same thing: the id's
 *  kind and version, and the quote. A finding kept before (an older id, or
 *  one dismissed) stands for any later one with the same key. Null for
 *  anything that is not an analysis finding. */
export function analysisFindingKey(f: { id: string; evidence: string }): string | null {
  const m = /^(cc|codex-update):([^:]+):[^:]+$/.exec(typeof f.id === 'string' ? f.id : '')
  if (!m || typeof f.evidence !== 'string') return null
  const q = bareQuote(f.evidence)
  return q ? `${m[1]}:${m[2]}:${q}` : null
}

/** A single character, then one or two separators, twelve times or more:
 *  text spelled out a character at a time. */
const SPELLED_OUT = /(?:[A-Za-z0-9+/=_-][\s.,:;|]{1,2}){12,}[A-Za-z0-9+/=_-]?/g
/** An unbroken run long enough to be a token. */
const LONG_RUN = /[A-Za-z0-9+/=_.:~-]{16,}/g

/** Whether an unbroken run reads as a token rather than a word: very long,
 *  or mixed case with digits (base64, opaque ids), or long hex. */
function tokenLike(run: string): boolean {
  if (run.length >= 32) return true
  const digit = /[0-9]/.test(run)
  if (/[A-Z]/.test(run) && /[a-z]/.test(run) && digit) return true
  const hex = run.replace(/[-_.:]/g, '')
  return hex.length >= 16 && /^[0-9a-f]+$/i.test(hex) && digit && /[a-f]/i.test(hex)
}

/** A title or a what-breaks line without anything shaped like a token: a
 *  long mixed or hex run, or text spelled out a character at a time, each
 *  becomes "[removed]". The evidence is not touched (it is a checked quote). */
export function dropTokenRuns(t: string): string {
  return t
    .replace(SPELLED_OUT, ' [removed] ')
    .replace(LONG_RUN, (run) => (tokenLike(run) ? '[removed]' : run))
    .replace(/\s+/g, ' ')
    .trim()
}
