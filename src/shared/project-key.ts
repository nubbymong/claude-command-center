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
//   F:\MY_PROJECT                              → F--MY-PROJECT
//   f:\sample_app                                   → f--sample-app
//   F:\sample_app\.claude-worktrees\warm-toolchain  → F--sample-app--claude-worktrees-warm-toolchain
//   C:\Users\jane                                   → C--Users-jane
//
// Rule: replace every non-alphanumeric character individually with `-`.
//   cwd.replace(/[^A-Za-z0-9]/g, '-')
//
// Key properties:
//   - Underscores, colons, backslashes, forward-slashes, dots, spaces → `-`
//   - No run-collapsing: `\\` → `--` (two consecutive separators = two hyphens)
//   - Input case is preserved verbatim (no lowercasing)
//   - One `-` per UTF-16 code unit, so a character outside the BMP gives two
//
// P3.16a round 2 (Q1): a name longer than PROJECT_DIR_NAME_MAX (200)
// characters is cut at 200, and `-` and the base-36 absolute value of a 32-bit
// hash of the WHOLE folder (not of the name) follow it, as Claude Code 2.1.285
// to 2.1.287 name the folder (their own function, read from the pinned
// binaries: `h = (h << 5) - h + charCode | 0` over the folder's UTF-16 code
// units). The folder is the one Claude Code launched in (main works out its
// real path first: transcript-discovery.ts claudeProjectDirName).
//
// NOTE: src/main/utils/claude-project-path.ts uses a DIFFERENT (older/looser) rule
// that preserves underscores and collapses separator runs. It serves a separate
// feature and is intentionally NOT modified here — but the divergence is flagged
// so callers do not conflate the two functions.

/** The longest projects folder name Claude Code gives a folder before it cuts
 *  the name and adds the folder's hash. */
export const PROJECT_DIR_NAME_MAX = 200

/** Claude Code's 32-bit string hash: `h * 31 + code unit`, wrapped to a signed
 *  32-bit integer at each step. */
function folderHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0
  return h
}

export function mangleCwdToProjectDir(cwd: string): string {
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-')
  if (name.length <= PROJECT_DIR_NAME_MAX) return name
  return `${name.slice(0, PROJECT_DIR_NAME_MAX)}-${Math.abs(folderHash(cwd)).toString(36)}`
}
