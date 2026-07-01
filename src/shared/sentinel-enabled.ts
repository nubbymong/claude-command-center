/**
 * Sentinel is OPT-IN (default OFF). It spends Claude tokens -- a real
 * `claude -p` analysis run whenever the Claude Code version changes -- so it
 * must never run without the user's explicit consent. Absent (fresh install /
 * config without the key) or `false` = OFF; only an explicit `true` enables it.
 *
 * Shared by the boot gate (main), the Sentinel dot/badge, and the Settings
 * toggle so the opt-in contract has a single source of truth.
 */
export function isSentinelEnabled(sentinelEnabled: boolean | undefined): boolean {
  return sentinelEnabled === true
}
