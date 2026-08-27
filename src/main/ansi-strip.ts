/**
 * Escape stripping for the SSH sentinel parsers (setup-ok / acct, tier-3/4
 * stage, arch probe — pty-manager.ts and ssh-tmux-push.ts).
 *
 * WHY THIS EXISTS (2026-08-27, the Pi tier-3 incident): every sentinel
 * parser requires its captured token to be IMMEDIATELY followed by a line
 * terminator (`(?=[\r\n])`) — the chunk-boundary discipline that stops a
 * half-arrived line from parsing as a truncated value. On Windows the app
 * talks to `ssh.exe` through ConPTY, and ConPTY re-encodes the ENTIRE remote
 * byte stream, gluing its own escape sequences (window-title OSC, cursor
 * CSIs) at arbitrary points — including BETWEEN a sentinel's last token and
 * its `\r\n`. That glue broke every end-anchored prompt detector in RC8
 * (ui-detection.ts's strip is the proven fix), and it breaks the sentinel
 * parsers the same way, each with its own blast radius:
 *   - `parseTmuxStageSentinel`: `\S+` swallows the glued escapes, the
 *     charset gate then rejects the capture, and a SUCCESSFUL remote stage
 *     is declared `fail=unsafe-path` — tmux persistence silently lost, and
 *     `CCC_TMUX_BIN` never patched (the statusline dies under the very tmux
 *     the stage installed) — the live Pi incident.
 *   - `parseArchProbeSentinel`: the combo captures with glue appended,
 *     `mapUnameToTarget` returns null, and `archProbeResolved` LATCHES an
 *     unrecognised arch — tier 4 permanently unreachable for the session.
 *   - `parseTmuxSentinel` / `parseSetupAccountSentinel`: the lookahead never
 *     matches, setup-ok never latches, and the flow limps to its timeout.
 *
 * The fix: each parser strips complete escape sequences from ITS OWN input
 * before matching. Stripping is the right layer (vs. loosening the regexes):
 * the terminator discipline stays intact, and the capture can no longer
 * contain escape bytes by construction.
 *
 * The classes mirror ui-detection.ts's RC8 strip (kept separate there by
 * design — it is deliberately dependency-free), with two deviations that
 * matter for THIS use, where the input is an ACCUMULATED MULTI-LINE buffer
 * rather than a single prompt line:
 *   - OSC/DCS string bodies also abort on `\r`/`\n` (`[^\x07\x1b\r\n]*`): a
 *     real title OSC never contains a newline, and without the abort an
 *     UNTERMINATED introducer earlier in the buffer + any later BEL would
 *     swallow the sentinel line sitting between them.
 *   - The trailing-partial rule only drops an unterminated escape on the
 *     LAST line (`\x1b[^\r\n]*$`), so a stray mid-buffer ESC cannot erase a
 *     complete sentinel line that follows it.
 * Escapes never legitimately appear INSIDE sentinel text (plain ASCII,
 * host-authored `echo` output), so stripping cannot corrupt a genuine match.
 *
 * NEGATED classes, not lazy dot-alls — this runs on every chunk of an SSH
 * session's setup window against a buffer that can be MAX_SETUP_LINE_BUFFER
 * long, and `[\s\S]*?` with an alternation terminator is O(n²) on a flood of
 * unterminated introducers (the ReDoS class the RC8 adversarial review
 * measured at ~1s of main-thread stall per 64KB chunk). These are linear.
 */
const CSI_SEQ = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g
const OSC_SEQ = /\x1b\][^\x07\x1b\r\n]*(?:\x07|\x1b\\)/g
const DCS_APC_PM_SEQ = /\x1b[P_X^][^\x07\x1b\r\n]*(?:\x07|\x1b\\)/g
const TRAILING_PARTIAL_ESC = /\x1b[^\r\n]*$/

export function stripAnsiForSentinel(data: string): string {
  return data
    .replace(OSC_SEQ, '')
    .replace(DCS_APC_PM_SEQ, '')
    .replace(CSI_SEQ, '')
    .replace(TRAILING_PARTIAL_ESC, '')
}
