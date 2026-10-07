// P3.9 round 2: how Sentinel's analysis findings are read and shown. One
// normalisation serves the display, the quote check and the finding ids, so
// what is checked is what is shown. Round 3: the check and the ids also
// read past markdown and typographic quotes on both sides, accept a whole
// line of the notes however short, and an elided quote whose pieces lie in
// order in one line.
import { createHash } from 'crypto'
import { stripSpoofableText } from '../../shared/safe-text'
import { redactFailure } from '../providers/review-support'

/** The shortest quote that counts as evidence (after normalisation), unless
 *  it is a whole line of the notes. */
export const QUOTE_MIN_CHARS = 16
/** The shortest piece of an elided quote. */
export const QUOTE_MIN_PIECE_CHARS = 8

/** Longest text the normalisation reads (the notes sent are far shorter). */
const NORMALISE_MAX = 1_000_000

/** The text as a finding shows it and as the quote check reads it: NFC, no
 *  control, bidi or zero-width characters (each a space), whitespace
 *  collapsed. */
export function normaliseQuoteText(t: string): string {
  return stripSpoofableText(String(t).normalize('NFC'), NORMALISE_MAX).replace(/\s+/g, ' ').trim()
}

// Typographic quotes and the ellipsis, built from their code points so the
// source stays ASCII.
const SINGLE_QUOTES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x201a, 0x201b)}]`, 'g')
const DOUBLE_QUOTES = new RegExp(`[${String.fromCharCode(0x201c, 0x201d, 0x201e, 0x201f)}]`, 'g')
const ELLIPSIS = new RegExp(`\\s*(?:\\.\\.\\.|${String.fromCharCode(0x2026)})\\s*`)

/** The text as the quote check and the ids compare it: the display
 *  normalisation, then no markdown code or emphasis marks and plain quotes. */
function matchText(t: string): string {
  return normaliseQuoteText(t)
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A quote as the model gave it, compared as the notes are, without the
 *  quotation marks around it. */
function bareQuote(evidence: string): string {
  return matchText(evidence).replace(/^["']+|["']+$/g, '').trim()
}

/** A line of the notes (or a quote) without the list or heading mark it
 *  starts with. */
const unmarked = (line: string) => line.replace(/^(?:[-*+]|#{1,6})\s+/, '').trim()

/** A finding's evidence counts only as ONE passage copied from the notes it
 *  was sent, after the same normalisation on both sides (markdown code and
 *  emphasis marks and typographic quotes set aside):
 *  - one contiguous piece of them, at least QUOTE_MIN_CHARS long; or
 *  - a whole line of them, however short (its list mark aside); or
 *  - pieces of ONE line, in order, the model elided between (an ellipsis),
 *    each at least QUOTE_MIN_PIECE_CHARS and QUOTE_MIN_CHARS together.
 *  Anything else (a file the model read, a paraphrase, text spelled out a
 *  character per line) is not evidence. */
export function evidenceIsQuoted(evidence: string, notes: string): boolean {
  const q = bareQuote(evidence)
  if (!q) return false
  const whole = matchText(notes)
  if (q.length >= QUOTE_MIN_CHARS && whole.includes(q)) return true
  const lines = String(notes).split(/\r?\n|\r/).map((l) => matchText(l)).filter((l) => l.length > 0)
  const bare = unmarked(q)
  if (bare && lines.some((l) => unmarked(l) === bare)) return true
  const pieces = q.split(ELLIPSIS).map((p) => p.trim()).filter((p) => p.length > 0)
  if (pieces.length < 2 || pieces.some((p) => p.length < QUOTE_MIN_PIECE_CHARS) || pieces.join('').length < QUOTE_MIN_CHARS) return false
  return lines.some((line) => {
    let from = 0
    for (const p of pieces) {
      const at = line.indexOf(p, from)
      if (at < 0) return false
      from = at + p.length
    }
    return true
  })
}

/** A finding's id suffix: from its evidence alone (the checked quote, as the
 *  check compares it), so the same passage keeps its id however the model
 *  words the title. Only its hash is kept. */
export function quoteKey(evidence: string): string {
  return createHash('sha256').update(bareQuote(evidence)).digest('hex').slice(0, 12)
}

/** The analysis findings of one version that say the same thing: the id's
 *  kind and version, and the quote as the check compares it, credential
 *  shapes redacted (round 3: a finding stored before its text was redacted
 *  keys as one stored since). A finding kept before (an older id, or one
 *  dismissed) stands for any later one with the same key. Null for anything
 *  that is not an analysis finding. */
export function analysisFindingKey(f: { id: string; evidence: string }): string | null {
  const m = /^(cc|codex-update):([^:]+):[^:]+$/.exec(typeof f.id === 'string' ? f.id : '')
  if (!m || typeof f.evidence !== 'string') return null
  const q = redactFailure(bareQuote(f.evidence)).trim()
  return q ? `${m[1]}:${m[2]}:${q}` : null
}

// P3.9 round 3 (L1): what a title or a what-breaks line may not carry. A
// defence in depth behind the empty tool list (the analysis reads nothing
// but the notes it is sent): the shapes of credentials, whole or taken apart,
// never the shapes of names (an UPPER_SNAKE variable, a --flag, a
// lowercase model or package name, a path).

/** The separators a token may be taken apart with. */
const SEP = '[\\s.,:;|]'
/** Credential prefixes whose start is fixed. */
const TOKEN_PREFIXES = ['sk-', 'github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'npm_', 'AKIA', 'ASIA', 'AIza', 'ya29.', 'eyJ']
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
/** A prefix, its characters perhaps taken apart, then eight or more token
 *  characters, perhaps taken apart too. */
const PREFIXED = new RegExp(
  `(?<![A-Za-z0-9])(?:${TOKEN_PREFIXES.map((p) => [...p].map(escapeRe).join(`${SEP}{0,2}`)).join('|')})(?:[\\s.,:;|-]{0,2}[A-Za-z0-9+/=_]){8,}`,
  'g',
)
/** An email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
/** A single character, then one or two separators, twelve times or more:
 *  text spelled out a character at a time. */
const SPELLED_OUT = /(?:[A-Za-z0-9+/=_-][\s.,:;|]{1,2}){12,}[A-Za-z0-9+/=_-]?/g
/** Three or more short groups joined by one and the same separator. */
const GROUPED = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{2,8}([\s.,:;|_-])[A-Za-z0-9+/=]{2,8}(?:\1[A-Za-z0-9+/=]{2,8})+(?![A-Za-z0-9+/=])/g
/** An unbroken run long enough to be a token. */
const LONG_RUN = /[A-Za-z0-9+/=_.:~-]{16,}/g

/** Names, not tokens: an UPPER_SNAKE variable, a --flag, a lowercase name
 *  (a model, a package, a version) in short segments, a path. */
function nameShaped(run: string): boolean {
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(run)) return true
  if (/^--?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(run)) return true
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(run) && run.split(/[._-]/).every((seg) => seg.length <= 16)) return true
  if (/^[.~]?(?:\/[A-Za-z0-9._-]+)+\/?$/.test(run)) return true
  return false
}

/** Whether text with its separators removed reads as a token: long hex,
 *  mixed case with digits, or long with letters and digits. */
function squeezedTokenLike(t: string): boolean {
  const digit = /[0-9]/.test(t)
  const letter = /[A-Za-z]/.test(t)
  if (t.length >= 16 && /^[0-9a-f]+$/i.test(t) && digit && letter) return true
  if (/[A-Z]/.test(t) && /[a-z]/.test(t) && digit && t.length >= 12) return true
  return t.length >= 24 && digit && letter
}

/** Whether an unbroken run reads as a token rather than a name. */
function runTokenLike(run: string): boolean {
  const hex = run.replace(/[-_.:]/g, '')
  if (hex.length >= 16 && /^[0-9a-f]+$/i.test(hex) && /[0-9]/.test(hex) && /[a-f]/i.test(hex)) return true
  if (nameShaped(run)) return false
  const digit = /[0-9]/.test(run)
  if (/[A-Z]/.test(run) && /[a-z]/.test(run) && digit) return true
  return run.length >= 32 && digit && /[A-Za-z]/.test(run)
}

/** A group that is not a word: letters with digits, or case changing inside it. */
const oddGroup = (g: string) => (/[0-9]/.test(g) && /[A-Za-z]/.test(g)) || /[a-z][A-Z]/.test(g) || (/[A-Z]{2}/.test(g) && /[a-z]/.test(g))

/** Whether groups joined by separators are a token taken apart: hex in
 *  groups of one length; mostly groups that are not words; or five or more
 *  groups of one length that joined read as a token. Prose (words of
 *  varied length, and words) is not. */
function groupedTokenLike(span: string): boolean {
  const groups = span.split(/[\s.,:;|_-]/).filter((g) => g.length > 0)
  if (groups.length < 3) return false
  const joined = groups.join('')
  const head = groups.slice(0, -1)
  const uniform = head.every((g) => g.length === head[0].length) && head[0].length >= 3 && groups[groups.length - 1].length <= head[0].length
  if (uniform && joined.length >= 16 && /^[0-9a-f]+$/i.test(joined) && /[0-9]/.test(joined) && /[a-f]/i.test(joined)) return true
  if (joined.length >= 16 && groups.filter(oddGroup).length * 5 >= groups.length * 3) return true
  return uniform && groups.length >= 5 && squeezedTokenLike(joined)
}

/** A plain word at either end of a grouped span is prose around the token,
 *  not part of it: kept, while what is left still reads as a token. */
const plainWord = (w: string) => /^[A-Za-z][a-z]*$/.test(w)
function removeGroupedToken(span: string): string {
  const parts = span.split(/([\s.,:;|_-])/)
  const words = parts.filter((_, i) => i % 2 === 0)
  const counts = new Map<number, number>()
  for (const w of words) counts.set(w.length, (counts.get(w.length) ?? 0) + 1)
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  // A plain word of another length than the groups at an end is prose: set
  // aside before the rest is judged.
  const prose = (w: string) => plainWord(w) && w.length !== modal
  let lead = ''
  let trail = ''
  while (parts.length > 2 && prose(parts[0])) lead += parts.shift()! + parts.shift()!
  while (parts.length > 2 && prose(parts[parts.length - 1])) trail = parts.splice(-2).join('') + trail
  return groupedTokenLike(parts.join('')) ? `${lead} [removed] ${trail}` : span
}

/** A prefixed token, with the plain words that follow it (prose the match
 *  ran on into) kept. */
function removePrefixedToken(match: string): string {
  const tail = /(?:\s+[A-Za-z][a-z]+)+$/.exec(match)
  return tail && match.length - tail[0].length >= 8 ? ` [removed]${tail[0]} ` : ' [removed] '
}

/** A title or a what-breaks line without anything shaped like a credential:
 *  an email address; a known token prefix and what follows it, taken apart
 *  or not; text spelled out a character at a time; a token taken apart into
 *  groups of one length; a long hex or mixed run that is not a name. Each
 *  becomes "[removed]". The evidence is not touched (it is a checked quote). */
export function dropTokenRuns(t: string): string {
  return t
    .replace(EMAIL, ' [removed] ')
    .replace(PREFIXED, removePrefixedToken)
    .replace(SPELLED_OUT, ' [removed] ')
    .replace(LONG_RUN, (run) => (runTokenLike(run) ? '[removed]' : run))
    .replace(GROUPED, removeGroupedToken)
    .replace(/\s+/g, ' ')
    .trim()
}
