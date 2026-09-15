import { stripAnsiForSentinel } from './ansi-strip'
import { isSafeTmuxBin } from './ssh-tmux'
import { TMUX_STAGE_SENTINEL_PREFIX } from './ssh-tmux-stage'
import { sanitiseRemoteAccountEmail } from './statusline-watcher'

/**
 * Escape a string for literal (non-special) use inside `new RegExp(...)`.
 * #242 finding F1 (b): the per-session nonce is interpolated into
 * parseTmuxSentinel/parseTmuxStageSentinel's dynamically-built regexes below
 * -- randomId() (src/shared/id.ts) only ever produces lowercase hex, which
 * has no regex meaning, but this call site takes a plain `string` (the test
 * seam `_getSshNonceForTest` and any future caller aren't bound to that
 * guarantee), so escaping defends against a future nonce source that isn't
 * charset-limited the same way.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The two usable tmux CLASSES `parseTmuxSentinel` can return -- see its doc
 *  comment and generateRemoteSetupScript (ssh-shim.ts) for what each means. */
export type TmuxDetectionClass = 'path' | 'home'

/**
 * Parse the `tmux=<path|home|none>` CLASS field off the `setup ok`
 * completion sentinel (#242 — the tmux detection result rides the SAME
 * sentinel the setup script already emits, rather than a second
 * round-trip), AND gate the sentinel's own nonce match in one place so
 * every caller (the outer completion latch AND the tmux-class read) shares
 * the identical match (#242 finding I1/I2 correction, below).
 *
 * #242 round-3 correction (finding I3): the field is a fixed three-way
 * CLASS, never a path. `generateRemoteSetupScript` (ssh-shim.ts) reports
 * `path` (tier 1 — tmux found via `command -v tmux` on the remote's PATH),
 * `home` (tier 2 — a pre-existing, executable `~/.claude/bin/tmux`, the
 * SAME fixed location tier 3/4 stage/push a binary to), or `none`. There is
 * no free-text capture left for `isSafeTmuxBin`/`isPinnedTmuxPath` to
 * validate — the fixed alternation IS the allowlist — so both of those
 * checks (and the wire-reported path they used to gate) are gone; see
 * ssh-tmux.ts's `ON_PATH_TMUX_BIN_EXPR`/`STAGED_TMUX_BIN_EXPR` for the two
 * host-authored literal tokens a caller picks between using ONLY the class
 * this function returns, never a value read off the wire.
 *
 * Returns THREE distinct outcomes, because "the field wasn't there" and
 * "the field explicitly said none" are not the same thing (adversarial
 * review, #242 MINOR — call sites used to do `parseTmuxSentinel(data) ??
 * detectedTmuxSource`, which cannot tell them apart and so lets a
 * `tmux=none` from a LATER stage, e.g. container setup, inherit an EARLIER
 * stage's detected class instead of clearing it):
 *   - `undefined` — the sentinel is not present in THIS data (regex miss),
 *     the nonce is missing/wrong, or the chunk ends before the class token's
 *     trailing line terminator. Callers must leave any detected-tmux state
 *     untouched.
 *     - #242 finding I1 fix: callers pass the ACCUMULATED per-session
 *       buffer (`bufferSetupLine` in `ssh-line-buffer.ts`), not just the current chunk — a
 *       real SSH link routinely segments this single logical line across
 *       multiple PTY chunks (`setup ok <nonce> tmux=pa` | `th\r\n`), and the
 *       chunk-boundary discipline above (require the trailing terminator)
 *       correctly refuses a truncated read from the FIRST chunk alone; the
 *       bug was that nothing ever re-parsed the SECOND chunk once an
 *       earlier, unrelated latch had already fired off a bare substring
 *       check, so the tmux probe was lost silently on every segmented line
 *       (adversarial review / live-test repro, #242 finding I1).
 *     - #242 finding I2 fix: this is ALSO what a spoofed bare `setup ok`
 *       (no nonce, or the wrong one) now produces for BOTH purposes — the
 *       outer completion latch is gated on this SAME nonce-bearing match,
 *       not a separate bare-substring check, so a write-only attacker can
 *       no longer latch completion early (starving the genuine, later
 *       sentinel of ever being parsed and forcing an unwanted tier-3/4
 *       staging attempt on a host that already had tmux).
 *   - `null` — the field parsed and explicitly reported `none`. Callers
 *     must CLEAR any detected-tmux state.
 *   - `'path'` or `'home'` — a validated CLASS (see `TmuxDetectionClass`).
 *
 * `nonce` (#242 finding F1 (b)): this session's host-generated random token.
 * The sentinel must carry it, immediately after "setup ok", or the WHOLE
 * match fails (returns `undefined`, i.e. "not present in this chunk") —
 * this is what makes a spoofed sentinel (a co-tenant's `wall`/`write`, a
 * MOTD script, any other PTY writer that doesn't know this session's nonce)
 * indistinguishable from "no sentinel here" rather than a rejected-but-seen
 * value. SECOND layer only: an attacker who can also read the tty can copy
 * the nonce verbatim (this line's own echo is not suppressed) — but even
 * then there is no path left to substitute; the worst a copied nonce buys
 * is forcing CCC to pick between the two fixed literal tokens, never an
 * arbitrary one.
 */
export function parseTmuxSentinel(data: string, nonce: string): TmuxDetectionClass | null | undefined {
  // ConPTY can glue title-OSC/cursor-CSI escapes between the class token and
  // its line terminator, making the lookahead unsatisfiable — strip complete
  // sequences first (see ansi-strip.ts for the incident + class rationale).
  const m = stripAnsiForSentinel(data).match(new RegExp(`setup ok ${escapeRegExp(nonce)} tmux=(path|home|none)(?: acct=[A-Za-z0-9+/=]*)?(?=[\\r\\n])`))
  if (!m) return undefined
  if (m[1] === 'none') return null
  return m[1] as TmuxDetectionClass
}

/**
 * SSH tmux enhancement (item 10): parse the `acct=<base64email>` field the
 * setup-ok sentinel now carries AFTER the tmux class (generateRemoteSetupScript,
 * ssh-shim.ts). Same chunk-boundary + nonce discipline as parseTmuxSentinel:
 * requires the FULL nonce-bearing line (anchored on the line terminator via
 * the tmux-class lookahead), so a truncated or spoofed sentinel yields nothing.
 *
 * The wire token is base64 of the remote's oauthAccount.emailAddress. This is
 * a DESCRIPTOR the remote host controls, surfaced only as a label -- treated as
 * UNTRUSTED-FOR-DISPLAY: after base64-decode it is charset-filtered to the
 * characters a real email uses and length-capped, and anything else yields
 * `undefined` (no account shown) rather than passing an arbitrary string to the
 * renderer. It is never interpreted, never a credential, never an auth key.
 *
 * Returns the sanitized descriptor, or `undefined` when the field is absent,
 * empty, undecodable, or fails the display charset (never throws).
 */
// ADR-009: the max + display charset now live in ONE place
// (sanitiseRemoteAccountEmail, statusline-watcher.ts) and gate BOTH deliveries
// of this field -- this setup sentinel and the /status ingest, which used to
// copy it verbatim and, because the renderer prefers its value, silently won.
export function parseSetupAccountSentinel(data: string, nonce: string): string | undefined {
  // Same ConPTY-glue hazard as parseTmuxSentinel above (ansi-strip.ts).
  const m = stripAnsiForSentinel(data).match(new RegExp(`setup ok ${escapeRegExp(nonce)} tmux=(?:path|home|none) acct=([A-Za-z0-9+/=]*)(?=[\\r\\n])`))
  if (!m || !m[1]) return undefined
  let decoded: string
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf-8')
  } catch {
    return undefined
  }
  // Display gate: an email address only, length-capped. Anything else (a hostile
  // host trying to plant markup / control chars in the label) is dropped.
  return sanitiseRemoteAccountEmail(decoded)
}

/**
 * Parse the tier-3 staging sentinel (#242) that `buildTmuxStageCommand`
 * (ssh-tmux-stage.ts) writes to the remote PTY: either
 * `ccc-tmux-stage ok path=<abs-path>` or `ccc-tmux-stage fail=<reason>`.
 *
 * Same chunk-boundary discipline as parseTmuxSentinel above: the captured
 * token must be immediately followed by a line terminator, so a chunk that
 * ends mid-path/mid-reason (before the trailing `\n` the shell's own `echo`
 * always appends) returns `undefined` rather than a truncated value — the
 * caller leaves staging pending and waits for the next chunk instead of
 * treating a half-arrived line as the real result.
 *
 * The `ok` path is raw remote output — re-applies the SAME charset
 * allowlist (`isSafeTmuxBin`) here, before the value is returned in the
 * parse result. #242 finding F1(a), ROUND-2 CORRECTION: this function used
 * to ALSO apply a path-pin (`isPinnedTmuxPath`, requiring the path end in
 * "/.claude/bin/tmux") as a security gate on this field -- removed, because
 * "ends with the right suffix" is satisfiable from an attacker-writable
 * directory (`/tmp/.claude/bin/tmux`, or the double-slash
 * `/tmp/x//.claude/bin/tmux`) and is NOT equivalent to "really is under
 * $HOME" (verified end to end, adversarial review round 5, WITH a valid
 * nonce). The fix is not a stronger check on this field -- it is to stop
 * needing this field for anything security-relevant at all:
 * `buildTmuxLaunchCommand` (ssh-tmux.ts) never reads the result's `path` for
 * a staged tier, embedding `STAGED_TMUX_BIN_EXPR` (a fixed, host-authored
 * `"$HOME"/.claude/bin/tmux` literal) instead. #242 round-3 MINOR correction:
 * the result's `path` is never assigned to any state at all — the only
 * consumer is the adjacent `logInfo` call at each call site, inline. The
 * charset check that remains here exists purely so a malformed/garbage
 * capture can't pollute logs with control characters, not as a security
 * boundary.
 *
 * `nonce` (#242 finding F1 (b)): required immediately after
 * TMUX_STAGE_SENTINEL_PREFIX, same contract as parseTmuxSentinel's own
 * `nonce` param above -- a sentinel missing it, or carrying the wrong one,
 * is indistinguishable from "not present in this chunk" (`undefined`), not
 * a rejected-but-seen value.
 *
 * `reason` (#242 M2, MINOR): capped to a bounded, charset-guarded value
 * before it flows into flow-state IPC and logs -- the failure sentinel's
 * fail=<reason> field is raw remote output like the path is, and previously
 * `\S+` let an unbounded/garbage value straight through. The script itself
 * only ever emits arch/download/digest/extract/terminfo (ssh-tmux-stage.ts,
 * ssh-tmux-push.ts), all short lowercase words, so a real reply always
 * passes; anything else degrades to 'invalid-reason' rather than being
 * echoed verbatim.
 *
 * #242 finding I5: both capture groups are now BOUNDED (`\S{1,4096}`), not
 * unbounded `\S+`. This value is informational-only (never reaches a launch
 * command), but it still gets written into the remote shell's own recovery
 * path (nothing here does that today, but nothing prevents a future editor
 * from assuming a capped value) and unconditionally into logs/flow-state
 * IPC -- a multi-kilobyte capture is resource/log noise regardless. 4096 is
 * ample headroom for any real path or reason word this script emits.
 */
const MAX_FAIL_REASON_LEN = 32
const SAFE_FAIL_REASON_RE = /^[A-Za-z0-9_-]+$/
const MAX_TMUX_STAGE_CAPTURE_LEN = 4096

function sanitizeFailReason(raw: string): string {
  if (raw.length > MAX_FAIL_REASON_LEN) return 'invalid-reason'
  return SAFE_FAIL_REASON_RE.test(raw) ? raw : 'invalid-reason'
}

export function parseTmuxStageSentinel(
  data: string,
  nonce: string,
): { ok: true; path: string } | { ok: false; reason: string } | undefined {
  // 2026-08-27 Pi incident: ConPTY glued escapes between `path=…/tmux` and
  // the `\r\n`, `\S+` swallowed them, and isSafeTmuxBin declared a SUCCESSFUL
  // remote stage `unsafe-path` — strip complete sequences before matching
  // (see ansi-strip.ts). The charset gate below still guards real garbage.
  const m = stripAnsiForSentinel(data).match(new RegExp(`${TMUX_STAGE_SENTINEL_PREFIX} ${escapeRegExp(nonce)} (ok path=(\\S{1,${MAX_TMUX_STAGE_CAPTURE_LEN}})|fail=(\\S{1,${MAX_TMUX_STAGE_CAPTURE_LEN}}))(?=[\\r\\n])`))
  if (!m) return undefined
  if (m[2]) return isSafeTmuxBin(m[2]) ? { ok: true, path: m[2] } : { ok: false, reason: 'unsafe-path' }
  return { ok: false, reason: sanitizeFailReason(m[3] ?? 'unknown') }
}
