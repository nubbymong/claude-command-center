// WP2 PR 4, P4.7 (row 68): the stored form of a Codex Insights report.
//
// Claude's report is Claude Code's own /insights page, kept as report.html
// and parsed into cards in the renderer (parseInsightsReport.ts). Codex has
// no such command, so the app makes the report: it counts the account's
// sessions itself and asks Codex for the cards (main/insights-codex.ts).
// What it keeps is DATA, never markup: report.json holds the title, the
// subtitle and the seven card kinds as plain strings, and the page draws
// them with the same components as Claude's cards (InsightsSections.tsx),
// as text.
//
// This module is the one rule for that data, used on both sides of the
// file: main checks a reply against it before anything is kept, and the
// renderer checks report.json again before it draws it, so a file edited on
// disk, truncated or from a newer build shows "no report" instead of
// anything it was not checked to be. Every string is cut to a fixed length
// with every control and spoofing character replaced (shared/safe-text);
// every list has a fixed maximum. No default export (project convention).
import { stripSpoofableText } from './safe-text'

/** The report's title, drawn beside Codex's mark. */
export const CODEX_REPORT_TITLE = 'Codex Insights'

/** The narrative card's title. */
export const CODEX_NARRATIVE_TITLE = 'How you use Codex'

/** The version of report.json this build writes and reads. */
export const CODEX_REPORT_VERSION = 1

/** The longest text one field keeps, in code points. */
export const CODEX_REPORT_FIELD_MAX = 600
/** The longest paragraph, in code points. */
export const CODEX_REPORT_PARAGRAPH_MAX = 1200
/** The most items a card's list keeps. */
export const CODEX_REPORT_ITEMS_MAX = 6
/** The most paragraphs the narrative card keeps. */
export const CODEX_REPORT_PARAGRAPHS_MAX = 6
/** The largest report.json read, in bytes (main) and characters (the page). */
export const CODEX_REPORT_MAX_BYTES = 512 * 1024

/** The card kinds the page draws (the same shapes as parseInsightsReport's). */
export type CodexReportSection =
  | { kind: 'at-a-glance'; title: string; body: string }
  | { kind: 'narrative'; title: string; paragraphs: string[] }
  | { kind: 'big-wins'; items: Array<{ title: string; desc: string }> }
  | { kind: 'friction'; items: Array<{ title: string; desc: string }> }
  | { kind: 'features'; items: Array<{ title: string; oneliner: string; why: string }> }
  | { kind: 'patterns'; items: Array<{ title: string; summary: string; detail: string }> }
  | { kind: 'horizon'; title: string; body: string }

/** What report.json holds. */
export interface CodexStoredReport {
  version: number
  title: string
  subtitle: string
  sections: CodexReportSection[]
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A field as plain one-line text: a string, controls and spoofing
 *  characters replaced by a space, runs of spaces folded, cut to `max` code
 *  points (a cut one ends in "..."). Null for anything that is not a string.
 *  The input is cut first to 4 x `max` code units, which can split a pair
 *  only past the `max` code points kept. */
export function codexReportText(v: unknown, max: number = CODEX_REPORT_FIELD_MAX): string | null {
  if (typeof v !== 'string') return null
  const head = v.length > max * 4 ? v.slice(0, max * 4) : v
  const folded = stripSpoofableText(head, head.length).replace(/\s+/g, ' ').trim()
  const points = Array.from(folded)
  return points.length <= max ? folded : `${points.slice(0, Math.max(0, max - 3)).join('').trimEnd()}...`
}

/** A required, non-empty field; null when it is missing, not text or empty. */
function need(v: unknown, max: number = CODEX_REPORT_FIELD_MAX): string | null {
  const t = codexReportText(v, max)
  return t ? t : null
}

/** A list of objects, each read by `item`; null when it is not a list, is
 *  longer than the maximum, or any entry does not read. */
function list<T>(v: unknown, item: (o: Record<string, unknown>) => T | null, max: number = CODEX_REPORT_ITEMS_MAX): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const e of v) {
    if (!isObject(e)) return null
    const r = item(e)
    if (r === null) return null
    out.push(r)
  }
  return out
}

/** One stored card, or null when it is not one of the seven shapes. */
function readSection(v: unknown): CodexReportSection | null {
  if (!isObject(v)) return null
  switch (v.kind) {
    case 'at-a-glance':
    case 'horizon': {
      const title = codexReportText(v.title)
      // The at-a-glance body is three lines the app joins; each line is read on its own.
      const body = typeof v.body === 'string'
        ? v.body.split('\n').slice(0, 4).map((l) => codexReportText(l, CODEX_REPORT_FIELD_MAX) ?? '').filter(Boolean).join('\n')
        : null
      if (title === null || !body) return null
      return { kind: v.kind, title, body }
    }
    case 'narrative': {
      const title = codexReportText(v.title)
      if (title === null || !Array.isArray(v.paragraphs) || v.paragraphs.length === 0 || v.paragraphs.length > CODEX_REPORT_PARAGRAPHS_MAX) return null
      const paragraphs: string[] = []
      for (const p of v.paragraphs) {
        const t = need(p, CODEX_REPORT_PARAGRAPH_MAX)
        if (t === null) return null
        paragraphs.push(t)
      }
      return { kind: 'narrative', title, paragraphs }
    }
    case 'big-wins':
    case 'friction': {
      const items = list(v.items, (o) => {
        const title = need(o.title)
        const desc = need(o.desc)
        return title && desc ? { title, desc } : null
      })
      return items && items.length ? { kind: v.kind, items } : null
    }
    case 'features': {
      const items = list(v.items, (o) => {
        const title = need(o.title)
        const oneliner = need(o.oneliner)
        const why = need(o.why)
        return title && oneliner && why ? { title, oneliner, why } : null
      })
      return items && items.length ? { kind: 'features', items } : null
    }
    case 'patterns': {
      const items = list(v.items, (o) => {
        const title = need(o.title)
        const summary = need(o.summary)
        const detail = need(o.detail)
        return title && summary && detail ? { title, summary, detail } : null
      })
      return items && items.length ? { kind: 'patterns', items } : null
    }
    default:
      return null
  }
}

/** The order the page draws the cards in, as Claude's report has them. */
const SECTION_ORDER: ReadonlyArray<CodexReportSection['kind']> = ['at-a-glance', 'narrative', 'big-wins', 'friction', 'features', 'patterns', 'horizon']

/**
 * A stored report, checked: the parsed JSON of report.json, or null when it
 * is not one this build reads (another version, a missing or unknown card, a
 * card twice, a field that is not text). Never throws.
 */
export function readCodexStoredReport(value: unknown): CodexStoredReport | null {
  try {
    if (!isObject(value) || value.version !== CODEX_REPORT_VERSION) return null
    const title = need(value.title, 120)
    const subtitle = codexReportText(value.subtitle, 300)
    if (title === null || subtitle === null || !Array.isArray(value.sections)) return null
    if (value.sections.length === 0 || value.sections.length > SECTION_ORDER.length) return null
    const sections: CodexReportSection[] = []
    const seen = new Set<string>()
    for (const s of value.sections) {
      const read = readSection(s)
      if (!read || seen.has(read.kind)) return null
      seen.add(read.kind)
      sections.push(read)
    }
    // The two cards every report has.
    if (!seen.has('at-a-glance') || !seen.has('narrative')) return null
    sections.sort((a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind))
    return { version: CODEX_REPORT_VERSION, title, subtitle, sections }
  } catch {
    return null
  }
}

/** The stored report from report.json's text, or null (see readCodexStoredReport). */
export function parseCodexStoredReport(text: unknown): CodexStoredReport | null {
  if (typeof text !== 'string' || text.length > CODEX_REPORT_MAX_BYTES) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  return readCodexStoredReport(parsed)
}
