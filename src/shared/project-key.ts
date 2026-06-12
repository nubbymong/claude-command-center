// THE canonical project key: Claude Code stores per-project data under
// ~/.claude/projects/<mangled-cwd>/. This rule is the single source of truth
// shared by main (transcript-discovery, log worker) AND renderer (live-session
// matching on the Memory page). Pure — no Node imports (precedent:
// src/shared/model-registry.ts). NEVER duplicate this regex; import it.
//
// Verified rule (2026-06-06) against real ~/.claude/projects on the dev machine:
//
//   Input                                            → Directory name
//   ──────────────────────────────────────────────────────────────────────────
//   F:\CLAUDE_MULTI_APP                              → F--CLAUDE-MULTI-APP
//   f:\platform_v9                                   → f--platform-v9
//   F:\platform_v9\.claude-worktrees\warm-toolchain  → F--platform-v9--claude-worktrees-warm-toolchain
//   C:\Users\nicho                                   → C--Users-nicho
//
// Rule: replace every non-alphanumeric character individually with `-`.
//   cwd.replace(/[^A-Za-z0-9]/g, '-')
//
// Key properties:
//   - Underscores, colons, backslashes, forward-slashes, dots, spaces → `-`
//   - No run-collapsing: `\\` → `--` (two consecutive separators = two hyphens)
//   - Input case is preserved verbatim (no lowercasing)
//
// NOTE: src/main/utils/claude-project-path.ts uses a DIFFERENT (older/looser) rule
// that preserves underscores and collapses separator runs. It serves a separate
// feature and is intentionally NOT modified here — but the divergence is flagged
// so callers do not conflate the two functions.
export function mangleCwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}
