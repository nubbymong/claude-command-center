// Policy derived from claude-auto-retry (https://github.com/cheapestinference/claude-auto-retry), MIT License.
//
// Defensive config resolution for the session watchdog. Mirrors upstream
// src/config.js: any bad type/range on an individual field silently falls
// back to that field's default rather than throwing or poisoning the whole
// block. Partial input merges onto defaults field-by-field.

export interface OverloadConfig {
  enabled: boolean
  backoffSeconds: number[]
  steadyStateSeconds: number
  jitterPct: number
  maxTotalWaitMinutes: number
  retryMessage: string
  // Contract adjustment: ./patterns' detectOverload(text, patterns) requires the
  // caller to supply the match patterns (an empty/omitted list always returns
  // false) — there is no built-in default inside that module. Carrying the
  // upstream default pattern set here (mirroring claude-auto-retry's
  // DEFAULT_OVERLOAD.patterns) is what makes overload detection do anything.
  patterns: string[]
}

export interface SafeguardConfig {
  enabled: boolean
  maxRetries: number
  retryDelaySeconds: number
  retryMessage: string
  // Same adjustment as OverloadConfig.patterns, for detectSafeguard.
  patterns: string[]
}

export interface WatchdogConfig {
  maxRetries: number
  marginSeconds: number
  fallbackWaitHours: number
  retryMessage: string
  overload: OverloadConfig
  safeguard: SafeguardConfig
}

export const DEFAULT_OVERLOAD: OverloadConfig = {
  enabled: true,
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  retryMessage: 'continue',
  patterns: [
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    'overloaded_error',
    'temporarily limiting requests',
  ],
}

export const DEFAULT_SAFEGUARD: SafeguardConfig = {
  enabled: true,
  maxRetries: 3,
  retryDelaySeconds: 8,
  retryMessage: 'continue',
  patterns: ['safeguards flagged this message', "can't respond to this request with", 'legal/aup'],
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  maxRetries: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'continue',
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A tuning knob with a hard floor and ceiling (#419 review). These fields
 * became settings.json-reachable with F13; a degenerate value cannot open a
 * new injection path (the tick cadence bounds the send rate and the message
 * is sanitized), but sub-second backoffs and effectively-infinite caps turn
 * the retry loops into a self-DoS. Out-of-range values fall back rather than
 * clamp — a config that far off is a mistake, and the default is the honest
 * resolution of a mistake.
 */
function boundedNumber(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback
}

function boolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function nonEmptyString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

// Hard cap on a sanitized retryMessage. Generous for a human-authored retry
// phrase, small enough to bound what a hostile config value can inject into
// the PTY paste envelope built in main/index.ts.
const RETRY_MESSAGE_MAX_LEN = 200

// C0 controls (0x00-0x1F) and DEL (0x7F) — this range covers ESC (0x1B), so it
// strips the ESC sequences (e.g. `\x1b[201~`) that would otherwise close the
// bracketed-paste envelope early and let the remainder of retryMessage land as
// live keystrokes (command-injection primitive). Also strips C1 controls
// (0x80-0x9F, incl. 8-bit CSI 0x9B / OSC 0x9D) and the Unicode line/paragraph/
// next-line separators (U+2028, U+2029, U+0085) as defense-in-depth — even
// though this app's UTF-8 write path does not currently let a raw C1 reach the
// terminal as a single-byte control, the sanitizer should not depend on that.
// Defense-in-depth at the config-resolution boundary, ahead of the send.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029\u0085]/g

// Sanitizes a retryMessage field: trims, strips all C0/C1/DEL control chars
// (including ESC, CR/LF, and the Unicode line/paragraph/next-line separators),
// caps length, and falls back to `fallback` if the result is empty (e.g. an
// all-control-char input).
function sanitizedRetryMessage(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || v.length === 0) return fallback
  const stripped = v.replace(CONTROL_CHARS_RE, '').trim()
  if (stripped.length === 0) return fallback
  return stripped.slice(0, RETRY_MESSAGE_MAX_LEN)
}

function positiveNumberArray(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v) || v.length === 0) return fallback
  const cleaned = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 3600)
  return cleaned.length === v.length ? cleaned : fallback
}

function stringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0) return fallback
  const cleaned = v.filter((s): s is string => typeof s === 'string' && s.length > 0)
  return cleaned.length === v.length ? cleaned : fallback
}

// `defaultRetryMessage` is the resolved top-level retryMessage. The Settings UI
// exposes a single retry-message field, so the operator's message must apply to
// overload/safeguard retries too — not just the rate-limit path. It falls back
// to this shared value unless an explicit per-block retryMessage is configured.
function resolveOverload(partial: unknown, defaultRetryMessage: string): OverloadConfig {
  const p = isPlainObject(partial) ? partial : {}
  return {
    enabled: boolean(p.enabled, DEFAULT_OVERLOAD.enabled),
    backoffSeconds: positiveNumberArray(p.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds),
    steadyStateSeconds: boundedNumber(p.steadyStateSeconds, DEFAULT_OVERLOAD.steadyStateSeconds, 1, 86_400),
    jitterPct: boundedNumber(p.jitterPct, DEFAULT_OVERLOAD.jitterPct, 0, 100),
    maxTotalWaitMinutes: boundedNumber(p.maxTotalWaitMinutes, DEFAULT_OVERLOAD.maxTotalWaitMinutes, 1, 1_440),
    retryMessage: sanitizedRetryMessage(p.retryMessage, defaultRetryMessage),
    patterns: stringArray(p.patterns, DEFAULT_OVERLOAD.patterns),
  }
}

function resolveSafeguard(partial: unknown, defaultRetryMessage: string): SafeguardConfig {
  const p = isPlainObject(partial) ? partial : {}
  return {
    enabled: boolean(p.enabled, DEFAULT_SAFEGUARD.enabled),
    maxRetries: boundedNumber(p.maxRetries, DEFAULT_SAFEGUARD.maxRetries, 1, 100),
    retryDelaySeconds: boundedNumber(p.retryDelaySeconds, DEFAULT_SAFEGUARD.retryDelaySeconds, 1, 3600),
    retryMessage: sanitizedRetryMessage(p.retryMessage, defaultRetryMessage),
    patterns: stringArray(p.patterns, DEFAULT_SAFEGUARD.patterns),
  }
}

export function resolveWatchdogConfig(partial?: unknown): WatchdogConfig {
  const p = isPlainObject(partial) ? partial : {}
  const retryMessage = sanitizedRetryMessage(p.retryMessage, DEFAULT_WATCHDOG_CONFIG.retryMessage)
  return {
    maxRetries: boundedNumber(p.maxRetries, DEFAULT_WATCHDOG_CONFIG.maxRetries, 1, 100),
    marginSeconds: boundedNumber(p.marginSeconds, DEFAULT_WATCHDOG_CONFIG.marginSeconds, 0, 3600),
    fallbackWaitHours: boundedNumber(p.fallbackWaitHours, DEFAULT_WATCHDOG_CONFIG.fallbackWaitHours, 1, 24),
    retryMessage,
    overload: resolveOverload(p.overload, retryMessage),
    safeguard: resolveSafeguard(p.safeguard, retryMessage),
  }
}
