/**
 * bound-feed-payload.ts — keep the activity-feed RING buffer's per-entry memory
 * bounded.
 *
 * Claude Code hook POSTs can carry large tool inputs/outputs (a PostToolUse for a
 * big-file Edit includes the whole file). The feed history holds RING_BUFFER_CAP
 * entries per session; without a per-entry bound, a few huge payloads make that
 * history unbounded. This pure helper bounds ONE payload to ~maxBytes:
 *
 *  1. Deep-truncate every long string in the payload (slice + the truncation
 *     marker) so common cases (one big field) shrink in place yet stay readable.
 *  2. If the truncated payload STILL serializes larger than maxBytes (e.g. many
 *     medium strings, or deep nesting), drop it entirely for a tiny stub that
 *     records how big it was and points the user at Logs for full detail.
 *
 * The entry's `summary` field lives OUTSIDE the payload and is therefore always
 * preserved — the caller builds the entry with the real summary and only the
 * payload passes through here.
 *
 * Pure (no clock, no IO) so it is trivially table-tested. Never throws: a payload
 * that cannot be serialized (a cycle) is replaced with the same stub.
 */

const TRUNCATION_MARKER = '…[truncated]'
// Cap any single string at this many CHARS before serializing. Chosen so a handful
// of long fields can coexist under an 8 KiB payload budget; oversize-after-this
// falls through to the whole-payload stub.
const MAX_STRING_CHARS = 2048

export interface OversizePayloadStub {
  note: string
  originalBytes: number
}

function truncateString(s: string): string {
  if (s.length <= MAX_STRING_CHARS) return s
  return s.slice(0, MAX_STRING_CHARS) + TRUNCATION_MARKER
}

/** Recursively copy a value, truncating every long string. Arrays/objects are
 *  rebuilt; primitives pass through; functions/symbols/undefined are dropped by
 *  JSON anyway so we leave them. */
function deepTruncate(value: unknown): unknown {
  if (typeof value === 'string') return truncateString(value)
  if (Array.isArray(value)) return value.map(deepTruncate)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepTruncate(v)
    }
    return out
  }
  return value
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY // unserializable (cycle) -> force the stub
  }
}

/**
 * Bound a feed payload to ~maxBytes. Returns either the deep-truncated payload
 * (when it fits) or a tiny stub that records the original size. Always a valid
 * Record<string, unknown> so the existing HookEvent.payload type is unchanged
 * and renderers that index payload fields see `undefined`, never a crash.
 */
export function boundPayloadForFeed(
  payload: Record<string, unknown>,
  maxBytes = 8192,
): Record<string, unknown> {
  const originalBytes = byteLength(payload)
  // deepTruncate itself can blow the stack on a cyclic payload (it walks before
  // any serialize). Guard the whole truncate+measure so ANY failure (cycle,
  // pathological depth) falls through to the stub rather than throwing into the
  // ingest path.
  try {
    const truncated = deepTruncate(payload) as Record<string, unknown>
    if (byteLength(truncated) <= maxBytes) return truncated
  } catch { /* fall through to the stub */ }
  const stub: OversizePayloadStub = {
    note: 'payload too large for feed history — full detail in Logs',
    originalBytes: Number.isFinite(originalBytes) ? originalBytes : 0,
  }
  return stub as unknown as Record<string, unknown>
}
