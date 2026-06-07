/**
 * spawn-claude-command.ts — pure builder for the Claude launch command string.
 *
 * Extracted verbatim from pty-manager.ts's Claude branch (the shell command
 * written into the PTY after spawn) so it can be unit-tested WITHOUT node-pty /
 * Electron. No default export (project convention). No side effects.
 *
 * Behaviour contract:
 *   - When `resumeUuid` is ABSENT the produced string is BYTE-IDENTICAL to the
 *     pre-refactor inline construction (picker / picker-fallback / direct).
 *   - When `resumeUuid` is PRESENT the resume-picker branch is BYPASSED and the
 *     command launches Claude directly with `--resume <uuid>` FIRST, before
 *     --settings / --mcp-config / --agents etc. (mirrors the ordering in
 *     scripts/resume-picker.js:299 — the resume verb must come first).
 *
 * The cwd-override decision (whether a resume target exists + all the fail-open
 * existence checks) lives in the CALLER (pty-manager). This function only knows
 * "given a uuid (or not), produce the command".
 */

export interface BuildClaudeLaunchCommandOptions {
  /** 'win32' produces a PowerShell command; anything else produces a POSIX sh command. */
  platform: 'win32' | 'posix' | string
  /** The (already account/worktree-resolved) directory to cd into before launch. */
  cwd: string
  /** Resolved claude binary path/command (resolveClaudeForPty().cmd). */
  claudeBin: string
  /** Pre-built extra flag string (e.g. ` --effort high --settings '...' --mcp-config '...'`). */
  extraFlags: string
  /** Pre-built --agents flag string (empty when no agents). */
  agentsFlag: string
  /** Whether the resume-picker branch would normally run (restored sessions). */
  useResumePicker: boolean
  /** Resolved resume-picker.js path, or null when not deployed. */
  pickerScript: string | null
  /**
   * When set, BYPASS the picker and launch `claude --resume <uuid>` directly.
   * The caller has already validated the uuid + transcript/companion/cwd
   * existence; this builder trusts it. Absent => golden no-resume behaviour.
   */
  resumeUuid?: string
}

/**
 * Escape a path for single-quoting in the target shell.
 *   - win32 (PowerShell): double the single quotes.
 *   - posix (sh): close-quote, backslash-escape, reopen-quote.
 */
function escapeForCwdQuote(p: string, isWin32: boolean): string {
  return isWin32 ? p.replace(/'/g, "''") : p.replace(/'/g, "'\\''")
}

export function buildClaudeLaunchCommand(opts: BuildClaudeLaunchCommandOptions): string {
  const { cwd, claudeBin, extraFlags, agentsFlag, useResumePicker, pickerScript, resumeUuid } = opts
  const isWin32 = opts.platform === 'win32'
  const escapedCwd = escapeForCwdQuote(cwd, isWin32)

  // RESUME path: bypass the picker, launch claude directly with --resume first.
  // The --resume verb must precede every other flag (resume-picker.js:299), so
  // it is injected before agentsFlag/extraFlags here.
  if (resumeUuid) {
    const resumeFlag = ` --resume ${resumeUuid}`
    return isWin32
      ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${resumeFlag}${agentsFlag}${extraFlags}; exit`
      : `cd '${escapedCwd}' && "${claudeBin}"${resumeFlag}${agentsFlag}${extraFlags}; exit`
  }

  // GOLDEN no-resume behaviour (byte-identical to the prior inline code).
  if (useResumePicker) {
    if (pickerScript && isWin32) {
      const escapedScript = pickerScript.replace(/'/g, "''")
      return `Set-Location '${escapedCwd}'; node '${escapedScript}'${extraFlags}; exit`
    } else if (pickerScript) {
      return `cd '${escapedCwd}' && node '${pickerScript.replace(/'/g, "'\\''")}'${extraFlags}; exit`
    } else {
      // Fallback: no picker script found, launch Claude directly.
      return isWin32
        ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
        : `cd '${escapedCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    }
  }

  return isWin32
    ? `Set-Location '${escapedCwd}'; & "${claudeBin}"${agentsFlag}${extraFlags}; exit`
    : `cd '${escapedCwd}' && "${claudeBin}"${agentsFlag}${extraFlags}; exit`
}
