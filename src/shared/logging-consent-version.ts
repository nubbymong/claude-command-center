/**
 * P3.12: the version of the conversation indexing notice. 1: the notice that
 * named Claude Code's transcripts only (a saved `loggingConsentSeen` without a
 * version is that one); 2: the notice that names Claude Code's and Codex's.
 * The renderer shows the notice by it (utils/logging-consent.ts), and main
 * records a Codex run only once it was seen (should-register-run.ts).
 */
export const LOGGING_CONSENT_VERSION = 2
