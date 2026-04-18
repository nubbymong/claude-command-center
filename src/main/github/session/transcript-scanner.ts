import type { TranscriptReference } from '../../../shared/github-types'
import {
  TRANSCRIPT_GH_REGEX,
  TRANSCRIPT_ISSUE_REGEX,
  TRANSCRIPT_URL_REGEX,
} from '../../../shared/github-constants'

export interface TranscriptMessage {
  role: 'user' | 'assistant' | string
  text: string
  ts: number
}

const MAX_MESSAGES = 50

/**
 * Opt-in transcript scanner. Enabled only via the explicit user-facing toggle
 * (see spec §10 and `GitHubConfig.transcriptScanningOptIn`).
 *
 * Security / privacy invariants (tested explicitly):
 *   - Only user + assistant messages are scanned. Tool-call events and their
 *     arguments/results are never touched. Session Context's tool-call inputs
 *     come from a separate narrower module (tool-call-inspector).
 *   - Scan is bounded to the last 50 messages.
 *   - ONLY issue/PR NUMBERS and their origin type (`issue` | `pr`) are
 *     captured — never message text, never excerpts. The output shape
 *     (TranscriptReference) contains only numeric fields + timestamp + repo
 *     slug derived from matched URLs.
 */
export function scanTranscriptMessages(messages: TranscriptMessage[]): TranscriptReference[] {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_MESSAGES)

  const refs: TranscriptReference[] = []
  for (const m of recent) {
    if (typeof m.text !== 'string') continue

    // Each regex is global so we create fresh iterators per call (matchAll
    // resets state). Order: bare #N, then GH-N, then URL refs (which carry
    // explicit repo slug and kind).
    for (const mt of m.text.matchAll(TRANSCRIPT_ISSUE_REGEX)) {
      refs.push({ kind: 'issue', number: Number(mt[1]), at: m.ts })
    }
    for (const mt of m.text.matchAll(TRANSCRIPT_GH_REGEX)) {
      refs.push({ kind: 'issue', number: Number(mt[1]), at: m.ts })
    }
    for (const mt of m.text.matchAll(TRANSCRIPT_URL_REGEX)) {
      refs.push({
        kind: mt[3] === 'pull' ? 'pr' : 'issue',
        repo: `${mt[1]}/${mt[2]}`,
        number: Number(mt[4]),
        at: m.ts,
      })
    }
  }
  return refs
}
