// P3.10 (row 43): what the Session Watchdog reads a pane with. Each CLI has its
// own (aicc_planning#72): Claude Code's are patterns.ts's, Codex's are
// codex-patterns.ts's. `available`: which checks the CLI's own patterns can run
// at all; one it has none for is off and cannot be switched on (a CLI without
// its own patterns has that check reported unavailable, never run with another
// CLI's). Kept apart from session-watchdog.ts so the manager picks a session's
// detectors without reaching into the state machine.
import {
  isRateLimited,
  findRateLimitMessage,
  detectOverload,
  detectSafeguard,
  isWorking,
  isInternalRetry,
  resumedAfterLimit,
  canSendNow,
  hasClaudeInputChrome,
} from './patterns'
import type { SendGateResult } from './patterns'
import {
  codexIsRateLimited,
  codexFindRateLimitMessage,
  parseCodexResetTime,
  codexDetectOverload,
  codexDetectSafeguard,
  codexIsWorking,
  codexIsInternalRetry,
  codexResumedAfterLimit,
  codexCanSendNow,
  codexHasInputChrome,
} from './codex-patterns'
import { parseResetTime } from './time-parser'
import type { ParsedResetTime } from './time-parser'
import type { ScreenLine } from '../../shared/codex-screen'

/** #605: the three auto-retry checks (see WatchdogChecks in session-watchdog). */
export interface DetectorChecks {
  rateLimit: boolean
  overload: boolean
  safeguard: boolean
}

export interface WatchdogDetectors {
  isRateLimited(tail: string, tailLines: number): boolean
  findRateLimitMessage(tail: string): string | null
  parseResetTime(message: string, now: Date): ParsedResetTime | null
  detectOverload(tail: string, patterns: Array<string | RegExp>): boolean
  detectSafeguard(tail: string, patterns: Array<string | RegExp>): boolean
  isWorking(tail: string): boolean
  isInternalRetry(tail: string): boolean
  resumedAfterLimit(tail: string, tailLines: number): boolean
  canSendNow(tail: string, nonDim?: string, screen?: ScreenLine[] | null): SendGateResult
  hasInputChrome(tail: string, screen?: ScreenLine[] | null): boolean
  available: DetectorChecks
}

/** Claude Code's: exactly the calls the watchdog made before P3.10. */
export const CLAUDE_DETECTORS: WatchdogDetectors = {
  isRateLimited: (tail, tailLines) => isRateLimited(tail, [], tailLines),
  findRateLimitMessage: (tail) => findRateLimitMessage(tail),
  parseResetTime: (message) => parseResetTime(message),
  detectOverload: (tail, patterns) => detectOverload(tail, patterns),
  detectSafeguard: (tail, patterns) => detectSafeguard(tail, patterns),
  isWorking: (tail) => isWorking(tail),
  isInternalRetry: (tail) => isInternalRetry(tail),
  resumedAfterLimit: (tail, tailLines) => resumedAfterLimit(tail, tailLines),
  canSendNow: (tail, nonDim) => (nonDim === undefined ? canSendNow(tail) : canSendNow(tail, nonDim)),
  hasInputChrome: (tail) => hasClaudeInputChrome(tail),
  available: { rateLimit: true, overload: true, safeguard: true },
}

/** Codex's own (codex-patterns.ts); no safeguard. */
export const CODEX_DETECTORS: WatchdogDetectors = {
  isRateLimited: (tail, tailLines) => codexIsRateLimited(tail, tailLines),
  findRateLimitMessage: (tail) => codexFindRateLimitMessage(tail),
  parseResetTime: (message, now) => parseCodexResetTime(message, now),
  detectOverload: (tail) => codexDetectOverload(tail),
  detectSafeguard: () => codexDetectSafeguard(),
  isWorking: (tail) => codexIsWorking(tail),
  isInternalRetry: (tail) => codexIsInternalRetry(tail),
  resumedAfterLimit: (tail, tailLines) => codexResumedAfterLimit(tail, tailLines),
  canSendNow: (tail, nonDim, screen) => codexCanSendNow(tail, nonDim, screen),
  hasInputChrome: (tail, screen) => codexHasInputChrome(tail, screen),
  available: { rateLimit: true, overload: true, safeguard: false },
}
