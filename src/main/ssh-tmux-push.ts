/**
 * ssh-tmux-push.ts — pure builder for tier 4 of the #242 tmux-detection
 * ladder: pushing a pre-downloaded, sha256-verified tmux static build down
 * an ALREADY-OPEN SSH PTY as base64, for remotes tier 3 (ssh-tmux-stage.ts)
 * could not reach because they have NO outbound network egress at all —
 * the archive travels over the SSH tunnel that is already open (local ->
 * remote), never touching the remote's own network stack, which is exactly
 * why this tier works where curl/wget cannot. The host-side download/cache
 * (fetching the archive once into `app.getPath('userData')/tmux-cache/` and
 * reusing it thereafter) is pty-manager.ts's job — this module only builds
 * the shell text pty-manager writes once it already has the verified bytes
 * in hand, mirroring the ssh-tmux.ts / ssh-tmux-stage.ts pattern: a
 * dependency-free string builder so the exact shell fragment is
 * unit-testable without the pty-manager dependency graph.
 *
 * Reuses ssh-tmux-stage.ts's `TmuxStageTarget` type, its per-arch
 * `TMUX_STAGE_SHA256` digests (the archive bytes pushed here are
 * byte-for-byte the same v3.7b release asset tier 3 would have downloaded,
 * so the SAME digest applies), and its `TMUX_STAGE_SENTINEL_PREFIX`
 * (`ccc-tmux-stage ok/fail`) — pty-manager's existing
 * `parseTmuxStageSentinel` handles BOTH tiers' completion sentinel with
 * zero new parsing code.
 *
 * Exports:
 *   - `chunkBase64()` — splits a base64 string into PUSH_B64_LINE_MAX-sized
 *     lines. Exported so the max-line-length invariant is testable
 *     directly, not only against buildTmuxPushLines' embedded default.
 *   - `buildTmuxPushControlScript()` / `buildTmuxPushLines()` — the ordered
 *     list of discrete shell command LINES to write to the PTY, each one
 *     meant to land as its own '\r'-terminated write. Readable text (except
 *     the final control line, which is base64-wrapped for the same
 *     echo-immunity reason buildTmuxStageCommand's whole payload is), for
 *     structural unit tests to assert against.
 *   - `buildTmuxPushCommand()` — all of the above joined into the single
 *     string pty-manager actually feeds through `runChunkedWrite`
 *     (pty-chunked-write.ts) — NOT a single `ptyProcess.write()` the way
 *     buildTmuxStageCommand is, because this payload cannot safely be a
 *     single base64-wrapped line — see PUSH_B64_LINE_MAX's doc comment.
 *   - `buildArchProbeCommand()` / `buildArchProbeCommandBracketed()` /
 *     `parseArchProbeSentinel()` / `mapUnameToTarget()` — pty-manager needs
 *     to know the REMOTE's arch BEFORE it can pick which cached archive to
 *     push, and tier 3's `fail=download` sentinel never carries it (the
 *     download failed before its own `uname` result was ever reported) — so
 *     tier 4 runs a second, tiny `uname -s`/`uname -m` probe of its own
 *     (bracketed in `stty -echo`/`stty echo` by the Bracketed variant, #242
 *     round-3 MINOR fix). `mapUnameToTarget` re-expresses the SAME four-way
 *     combo table `buildTmuxStageScript` embeds as remote shell text
 *     (ssh-tmux-stage.ts) as a callable TS function, since the HOST side,
 *     not the remote, needs to interpret the result — ssh-tmux-push.test.ts
 *     parses the remote `case`/`esac` text back out and asserts the two
 *     tables agree combo-for-combo (#242 round-3 MINOR fix), so they cannot
 *     silently drift apart the way two independently hand-typed copies
 *     could.
 *
 * No default export (project convention).
 */

import { TMUX_STAGE_SHA256, TMUX_STAGE_SENTINEL_PREFIX, assertSafeNonce, type TmuxStageTarget } from './ssh-tmux-stage'
import { stripAnsiForSentinel } from './ansi-strip'

export { TMUX_STAGE_SENTINEL_PREFIX }
export type { TmuxStageTarget }

/**
 * Max base64 characters per pushed line, counting ONLY the base64 payload
 * (the surrounding `echo '…' >> <path>` wrapper adds a bounded, small
 * constant on top — see the line-length test in ssh-tmux-push.test.ts,
 * which asserts against the FULL line, not just this constant).
 *
 * Must stay comfortably under the Linux tty line discipline's
 * canonical-mode input buffer (historically 4096 bytes — `N_TTY_BUF_SIZE`
 * / the old `MAX_CANON`). A SINGLE typed line longer than that limit is
 * silently truncated by the KERNEL before the shell ever reads it — this is
 * not a cosmetic echo/readability concern the way a long line in
 * buildTmuxStageCommand's single base64 blob is (that one is base64-decoded
 * in one shot server-side by `base64 -d`, so ITS length is bounded only by
 * ARG_MAX-via-`echo`, not by canonical-mode line buffering — but it is also
 * a ~2KB script, nowhere near this scale). A full tmux static build is
 * ~1.27 MB of base64 once encoded; a single line that size would be nowhere
 * close to safe on ANY remote tty. Splitting into many bounded lines (each
 * its own PTY write, terminated by '\r' so the remote shell executes it as
 * a discrete command) is what makes tier 4 viable at all — acceptance (c)
 * exists specifically to catch a future "send it in one write" regression
 * that would silently corrupt (truncate) the transferred archive on any
 * remote with a standard canonical-mode tty.
 */
export const PUSH_B64_LINE_MAX = 2000

/**
 * Base64 alphabet guard (#242 round-2 MAJOR fix). `buildTmuxPushLines`
 * interpolates `input.tarGzBase64` into single-quoted remote shell text
 * (`echo '<chunk>' >> "$…"`) — a single `'` anywhere in that string closes
 * the quote early and everything after it becomes remote shell code
 * executed as the SSH user. Today's only caller passes
 * `buf.toString('base64')`, which can never contain one, so no exploit
 * exists in this diff — but this module is exported, pure, and documented
 * as reusable (mirrors why `SAFE_TMUX_BIN_RE` in ssh-tmux.ts is re-applied
 * inside `parseTmuxStageSentinel` rather than trusted to its one caller —
 * this repo's own convention is to re-guard at the boundary, not rely on
 * "the only caller happens to be safe"; see #188/#241 for the two prior
 * times a remote-facing string-interpolation boundary shipped without one).
 * Exported so callers/tests can probe the exact charset this module trusts.
 */
export const SAFE_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

// Remote paths, $$-suffixed like the tier-3 stage script's temp files so two
// concurrent push sessions to the same host can't clobber each other's
// in-progress upload (same reasoning as ssh-tmux-stage.ts's `.ccc-tmux-stage.$$`).
//
// #242 round-2 BLOCKER fix: PUSH_TMP_B64_PATH is written by the INTERACTIVE
// remote shell (the one the chunk lines below are typed into — call it PID
// A) but read by buildTmuxPushControlScript, which runs as a DIFFERENT `sh`
// process piped in via `base64 -d | sh` (PID B, a child of A). `$$` is each
// process's OWN pid, so a literal `$$` embedded in this constant resolves to
// A's pid everywhere the interactive shell expands it, and to B's pid
// wherever the piped `sh` expands it — two DIFFERENT values, proven
// empirically in this worktree (writing `.ccc-tmux-push.<A>.b64` then piping
// a script that reads `.ccc-tmux-push.$$.b64` into `sh` produced `sh: line 1:
// .../ .ccc-tmux-push.44268.b64: No such file or directory`, a pid that
// belonged to neither the writer nor anything the caller controlled). A
// constant string can therefore NEVER be the accumulator path — it has to be
// captured ONCE, by shell A, into a variable that is `export`ed so shell B
// inherits the SAME already-expanded value via its environment rather than
// re-deriving `$$` itself. `buildTmuxPushLines` emits that capture as its own
// line (`PUSH_ACCUMULATOR_VAR=$HOME/.../.ccc-tmux-push.$$.b64; export
// PUSH_ACCUMULATOR_VAR`) BEFORE any chunk line, and every reference below —
// both the chunk lines' `>>` target and the control script's `<` source —
// reads `"$PUSH_ACCUMULATOR_VAR"`, never the raw path, so there is exactly
// ONE place `$$` is ever evaluated for this file.
//
// PUSH_ARCHIVE_PATH and PUSH_DEST_TMP_PATH have NO such hazard: both are used
// exclusively inside buildTmuxPushControlScript, i.e. entirely within the
// single piped `sh` process (PID B) — every reference to `$$` in either one
// resolves to the SAME pid throughout that one script, so leaving them as
// literal `$$`-suffixed constants is safe.
// Exported (not just module-private) so pty-manager.ts's tier-4 abort-recovery
// path (#242 round-3 MINOR fix) can emit `rm -f "$PUSH_ACCUMULATOR_PATH"` off
// the SAME literal this module uses for the write side, rather than a second
// hand-typed copy of the variable name that could silently drift from it.
export const PUSH_ACCUMULATOR_VAR = 'PUSH_ACCUMULATOR_PATH'
const PUSH_ARCHIVE_PATH = '$HOME/.claude/bin/.ccc-tmux-push.$$.tar.gz'
const PUSH_DEST_TMP_PATH = '$HOME/.claude/bin/.tmux-push.$$'
const PUSH_DEST_PATH = '$HOME/.claude/bin/tmux'

export interface TmuxPushInput {
  /** Which tmux-builds release asset the pushed bytes came from — selects
   *  the embedded sha256 digest to re-verify against on the remote. */
  arch: TmuxStageTarget
  /** Full base64 encoding of the cached, host-verified v3.7b .tar.gz bytes
   *  for `arch`. Pure input — this module never touches fs or the network;
   *  pty-manager.ts resolves this from `app.getPath('userData')/tmux-cache/`
   *  (downloading once and caching thereafter) before calling in here. */
  tarGzBase64: string
  /**
   * #242 finding F1 (b): host-generated per-session nonce (randomId(),
   * src/shared/id.ts), embedded in every sentinel `buildTmuxPushControlScript`
   * emits. Same SECOND-layer contract as ssh-tmux-stage.ts's `nonce` param —
   * see that module's doc comment on buildTmuxStageScript for the honest
   * limitation (defeated by a tty-reader; the fixed STAGED_TMUX_BIN_EXPR
   * literal buildTmuxLaunchCommand embeds for this tier, ssh-tmux.ts, is
   * what survives that).
   */
  nonce: string
}

/**
 * Split a base64 string into `maxLen`-sized lines. Exported so both
 * buildTmuxPushLines' default chunking AND the max-line-length invariant
 * itself are directly testable against arbitrary inputs.
 *
 * Deliberately NOT regex-based (a lazy `.match(/.{1,N}/g)` on a ~1.7M-char
 * string is exactly the kind of thing that risks pathological backtracking
 * on some regex engines) — a plain index loop is linear regardless of input
 * size.
 */
export function chunkBase64(b64: string, maxLen: number = PUSH_B64_LINE_MAX): string[] {
  if (b64.length === 0) return ['']
  const out: string[] = []
  for (let i = 0; i < b64.length; i += maxLen) out.push(b64.slice(i, i + maxLen))
  return out
}

/**
 * Build the small remote control script that runs ONCE all chunk lines have
 * landed: decode the accumulated base64 file back into the archive, RE-VERIFY
 * its sha256 on the remote (acceptance (a) — never trust that ~600+
 * individually-typed lines sent over an interactive PTY arrived byte-for-byte;
 * a single dropped/duplicated/reordered keystroke on a flaky link silently
 * installs a corrupt binary otherwise, and the host's OWN pre-push digest
 * check — real as it is — says nothing about what actually survived the
 * wire), THEN extract/chmod/install/smoke-report using the exact same
 * sibling-temp-then-mv install pattern ssh-tmux-stage.ts's round-2 fix
 * established (never truncate a possibly-already-installed live path;
 * chmod the SIBLING temp, only `mv -f` it into place once tar has confirmed
 * success), THEN run the exact same detached smoke test tier 3's round-2
 * BLOCKER fix established (`tmux -V` then a DETACHED `new-session -d -s
 * <name> true`, immediately `kill-session`ing the probe on success) BEFORE
 * ever emitting `ok`, and finally emit the SAME `ccc-tmux-stage ok/fail`
 * sentinel tier 3 uses, so pty-manager's existing `parseTmuxStageSentinel`
 * needs no changes to understand tier 4's outcome too.
 *
 * #242 round-3 BLOCKER fix: the smoke test was missing entirely from the
 * prior version of this function -- it went digest-check -> tar -> chmod ->
 * mv -f -> straight to `ok path=...` with no verification the binary can
 * actually OPEN A TERMINAL. That re-arms the EXACT landmine tier 3's own
 * round-2 BLOCKER fix removed (see ssh-tmux-stage.ts's doc comment on
 * buildTmuxStageScript, step 5, for the full mechanism): the tier-2 probe in
 * ssh-shim.ts (`fs.accessSync(path, X_OK)`) checks EXECUTABILITY ONLY, never
 * runs the binary, so an installed-but-terminfo-broken tmux is reported as
 * `setup ok tmux=...` on every future session to this host, and
 * `buildTmuxLaunchCommand` (ssh-tmux.ts) emits `<bin> new-session -A -s
 * ccc-<sid> '<claude...>'` with NO `|| claude` fallback -- tmux dies with
 * "open terminal failed" and claude never starts, permanently, on a host
 * population (egress-less minimal containers) that is if anything MORE
 * likely than tier 3's to have no terminfo database. On smoke failure the
 * binary is removed (reported removal, not silent -- the fail=terminfo
 * sentinel still fires) so the tier-2 X_OK-only probe can never find it
 * again and re-wrap claude in a dead tmux.
 *
 * Returned as RAW shell text — buildTmuxPushLines (below) is the one that
 * base64-wraps it before it ever becomes a line pty-manager writes to a
 * live PTY. Exported only for the structural tests in ssh-tmux-push.test.ts,
 * which decode the wrapped line back to this text to assert the sha256
 * gate's program order.
 */
export function buildTmuxPushControlScript(arch: TmuxStageTarget, nonce: string): string {
  // #242 finding F1 (b): sink-side guard, before nonce is interpolated into
  // the sentinel lines below -- see ssh-tmux-stage.ts's assertSafeNonce.
  assertSafeNonce(nonce)
  const sha256 = TMUX_STAGE_SHA256[arch]
  return [
    // `"$PUSH_ACCUMULATOR_VAR"` — NOT a literal `$$`-suffixed path — so this
    // script (running as a piped `sh`, a different process than the
    // interactive shell that wrote the chunk lines) reads the SAME path the
    // writer used, inherited via the exported env var rather than
    // re-derived from this process's own pid. See PUSH_ACCUMULATOR_VAR's doc
    // comment above (#242 round-2 BLOCKER fix).
    `base64 -d < "$${PUSH_ACCUMULATOR_VAR}" > ${PUSH_ARCHIVE_PATH} 2>/dev/null`,
    `rm -f "$${PUSH_ACCUMULATOR_VAR}"`,
    `if command -v sha256sum >/dev/null 2>&1; then ` +
      `echo "${sha256}  ${PUSH_ARCHIVE_PATH}" | sha256sum -c - >/dev/null 2>&1; _pdgok=$?; ` +
    `else ` +
      `echo "${sha256}  ${PUSH_ARCHIVE_PATH}" | shasum -a 256 -c - >/dev/null 2>&1; _pdgok=$?; ` +
    `fi`,
    `if [ "$_pdgok" != "0" ]; then rm -f ${PUSH_ARCHIVE_PATH}; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=digest"; else ` +
      `if tar -xzf ${PUSH_ARCHIVE_PATH} -O tmux > ${PUSH_DEST_TMP_PATH} 2>/dev/null; then ` +
        `chmod 755 ${PUSH_DEST_TMP_PATH}; mv -f ${PUSH_DEST_TMP_PATH} ${PUSH_DEST_PATH}; rm -f ${PUSH_ARCHIVE_PATH}; ` +
        // #242 round-3 BLOCKER fix: smoke-test the just-installed binary
        // BEFORE reporting ok -- see this function's doc comment for why an
        // install that "succeeds" without this is a permanent landmine on
        // exactly the host population (egress-less minimal containers) tier
        // 4 targets. Mirrors ssh-tmux-stage.ts's tier-3 smoke test verbatim:
        // `tmux -V` (binary runs) THEN a detached `new-session -d -s <name>
        // true` (binary can actually open a terminal) -- `-V` alone never
        // touches a terminal and would miss a missing terminfo database.
        `_psmoke="ccc-tmux-push-smoke-$$"; ` +
        `if "${PUSH_DEST_PATH}" -V >/dev/null 2>&1 && "${PUSH_DEST_PATH}" new-session -d -s "$_psmoke" true; then ` +
          `"${PUSH_DEST_PATH}" kill-session -t "$_psmoke" >/dev/null 2>&1; ` +
          `echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} ok path=${PUSH_DEST_PATH}"; ` +
        `else ` +
          // Reported removal, not silent -- the fail=terminfo sentinel below
          // still fires. Leaving the binary in place would let the tier-2
          // X_OK-only probe (ssh-shim.ts) find it on every FUTURE session to
          // this host and wrap claude in a tmux that cannot open a terminal.
          `rm -f ${PUSH_DEST_PATH}; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=terminfo"; ` +
        `fi; ` +
      `else ` +
        `rm -f ${PUSH_DEST_TMP_PATH} ${PUSH_ARCHIVE_PATH}; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=extract"; ` +
      `fi; ` +
    `fi`,
  ].join('; ')
}

/**
 * Build the ordered list of shell command LINES pty-manager writes to the
 * PTY, one '\r'-terminated write per line (see buildTmuxPushCommand below
 * for the joined wire form).
 *
 * Shape:
 *   1. `stty -echo`               — acceptance (b): a ~1.27 MB transfer sent
 *      one bounded line at a time must never be echoed into the visible
 *      pane. This is the FIRST line, submitted and executed before any
 *      chunk line is sent, so it protects every line that follows.
 *   2. `mkdir -p ~/.claude/bin`    — defensive; tier 1/2/3 already create
 *      it, but tier 4 can be the FIRST thing to run on a truly bare host.
 *   3. `<var>=<tmp.b64 path>; export <var>` — capture the accumulator path
 *      ONCE, in the interactive shell, into an exported variable (#242
 *      round-2 BLOCKER fix — see PUSH_ACCUMULATOR_VAR's doc comment: a
 *      literal `$$`-suffixed path resolves to a DIFFERENT pid in the piped
 *      `sh` the control script (step N+1) runs in, so it can never be a bare
 *      constant shared between writer and reader).
 *   4. `: > "$<var>"`              — truncate/create the accumulator file.
 *   5..N. `echo '<chunk>' >> "$<var>"` — one per `chunkBase64()` slice.
 *      Safe to leave as PLAINTEXT shell text (not base64-wrapped) even
 *      though `stty -echo` may not have taken visible effect for the very
 *      first few of these (ioctl race) — a base64 alphabet chunk can NEVER
 *      contain the sentinel's literal `-` characters (`ccc-tmux-stage`),
 *      so even a fully-echoed chunk line cannot satisfy
 *      `parseTmuxStageSentinel`'s regex. Opacity-by-alphabet, not by timing.
 *   N+1. the control script (buildTmuxPushControlScript), base64-wrapped —
 *      UNLIKE the chunk lines, this one's plaintext genuinely contains the
 *      sentinel literals (`ccc-tmux-stage ok path=…` / `fail=…`), so it gets
 *      the EXACT same echo-immunity fix buildTmuxStageCommand needed
 *      (#242 round-3 MAJOR): wrap it in base64 so the line the terminal
 *      echoes back WHILE IT IS BEING TYPED is opaque, and the real sentinel
 *      is only ever emitted by the DECODED script's own `echo`, once it has
 *      actually run — not a re-parse of the same typed bytes.
 *   N+2. `stty echo`              — restore echo once the transfer + control
 *      script have both run.
 */
export function buildTmuxPushLines(input: TmuxPushInput): string[] {
  if (!SAFE_B64_RE.test(input.tarGzBase64)) {
    // Absorbable: attemptTmuxPush's call site (pty-manager.ts) already
    // wraps this in a try/catch that falls through to the bare unwrapped
    // launch on any build failure — a throw here is exactly that path, not
    // a new failure mode.
    throw new Error('buildTmuxPushLines: tarGzBase64 is not valid base64 -- refusing to interpolate into remote shell text')
  }
  const lines: string[] = []
  lines.push('stty -echo 2>/dev/null')
  lines.push('mkdir -p "$HOME/.claude/bin" 2>/dev/null')
  // Capture the accumulator path ONCE, here, in the interactive shell that
  // is about to type every chunk line below -- see PUSH_ACCUMULATOR_VAR's
  // doc comment for why this can't be a bare `$$`-suffixed constant.
  lines.push(`${PUSH_ACCUMULATOR_VAR}=$HOME/.claude/bin/.ccc-tmux-push.$$.b64; export ${PUSH_ACCUMULATOR_VAR}`)
  lines.push(`: > "$${PUSH_ACCUMULATOR_VAR}"`)
  for (const chunk of chunkBase64(input.tarGzBase64)) {
    lines.push(`echo '${chunk}' >> "$${PUSH_ACCUMULATOR_VAR}"`)
  }
  const controlB64 = Buffer.from(buildTmuxPushControlScript(input.arch, input.nonce)).toString('base64')
  lines.push(`echo '${controlB64}' | base64 -d | sh`)
  lines.push('stty echo 2>/dev/null')
  return lines
}

/**
 * Join buildTmuxPushLines' output into the single string pty-manager feeds
 * through `runChunkedWrite` (pty-chunked-write.ts) rather than a single
 * `ptyProcess.write()` call. That distinction matters: runChunkedWrite
 * slices this string into small (WRITE_CHUNK_SIZE) byte-writes purely to
 * avoid overflowing WinPTY/ConPTY's OWN input buffer — it has no concept of
 * "lines" and doesn't need one, because the '\r' characters embedded here
 * are preserved across however many small writes it takes to deliver them,
 * and the remote tty's canonical-mode line discipline reassembles complete
 * lines regardless of how many discrete writes delivered the bytes. The
 * two chunking schemes protect against two INDEPENDENT limits: this
 * module's line-length cap (PUSH_B64_LINE_MAX) guards the remote tty's
 * per-line canonical-mode buffer; runChunkedWrite's byte-chunking guards
 * the LOCAL pty backend's write buffer. Neither substitutes for the other.
 */
export function buildTmuxPushCommand(input: TmuxPushInput): string {
  return buildTmuxPushLines(input).map((line) => `${line}\r`).join('')
}

/** Sentinel prefix for the arch probe below. Distinct from
 *  TMUX_STAGE_SENTINEL_PREFIX so pty-manager's existing
 *  isStagingWrite-shaped write-classification (it distinguishes writes by
 *  substring, e.g. `base64 -d | sh` vs `base64 -d | node`) never confuses
 *  a probe write for a real tier-3/4 completion write. */
export const ARCH_PROBE_SENTINEL_PREFIX = 'ccc-tmux-push-arch'

/**
 * Build the tiny remote arch probe pty-manager writes BEFORE it knows
 * whether tier 4 will even run — cheap enough (a bare `uname`) to fire
 * alongside tier 3's staging attempt with no meaningful cost, so arch is
 * already known by the time (if ever) a `fail=download` sentinel arrives.
 *
 * Deliberately PLAINTEXT, not base64-wrapped like buildTmuxStageCommand —
 * and this is a considered choice, not an oversight. The round-3 tier-3 bug
 * this codebase already paid for was that a value with NO internal
 * whitespace (`$HOME/.claude/bin/tmux`) sits immediately after `path=` as one
 * contiguous non-whitespace run, so the terminal's pre-execution echo of the
 * as-typed line (which DOES include the trailing \r\n from pressing Enter)
 * satisfies a regex requiring `(\S+)` immediately followed by a line
 * terminator. This probe's value is `$(uname -s)-$(uname -m)` — command
 * substitution syntax that itself CONTAINS a space (`uname -s`) before the
 * unexpanded, pre-execution echo ever reaches a line terminator, so `\S+`
 * cannot span it: `parseArchProbeSentinel`'s capture group cannot match the
 * as-typed line, only the REAL post-execution output where the shell has
 * already substituted in a space-free `<os>-<machine>` string. Base64-wrapping
 * this one would also collide with the SAME `base64 -d | sh` substring
 * pty-manager's staging-write test helper matches on to locate the tier-3
 * write, needlessly complicating that call site for a value that doesn't
 * need the treatment.
 */
export function buildArchProbeCommand(): string {
  return `echo "${ARCH_PROBE_SENTINEL_PREFIX} $(uname -s)-$(uname -m)"`
}

/**
 * Bracket `buildArchProbeCommand()`'s output in the same `stty -echo` /
 * `stty echo` pair `buildTmuxStageCommand` uses around ITS payload (#242
 * round-3 MINOR fix) — the raw probe command, echoed back plaintext while
 * being typed, and its plaintext reply, were otherwise the only thing tier
 * 3/4 writes to a visible pane (every other write on this ladder is either
 * base64-opaque or explicitly echo-suppressed). NOT base64-wrapped, unlike
 * buildTmuxStageCommand's payload — see `buildArchProbeCommand`'s own doc
 * comment for why plaintext is already safe against its own parser here;
 * base64-wrapping it too would needlessly collide with the SAME `base64 -d |
 * sh` substring pty-manager's own tests use to distinguish the tier-3
 * staging write from everything else this call site sends.
 */
export function buildArchProbeCommandBracketed(): string {
  return `stty -echo 2>/dev/null; ${buildArchProbeCommand()}; stty echo 2>/dev/null`
}

/**
 * The exact four-way `uname -s`/`uname -m` combo table
 * `buildTmuxStageScript` (ssh-tmux-stage.ts) embeds as remote shell
 * `case`/`esac` text, re-expressed as a callable TS function — the HOST
 * side needs this as CODE (to pick which cached archive to push), whereas
 * tier 3's remote script only ever needs it as shell text.
 */
export function mapUnameToTarget(combo: string): TmuxStageTarget | null {
  switch (combo) {
    case 'Linux-x86_64': return 'linux-x86_64'
    case 'Linux-aarch64':
    case 'Linux-arm64': return 'linux-arm64'
    case 'Darwin-x86_64': return 'macos-x86_64'
    case 'Darwin-arm64': return 'macos-arm64'
    default: return null
  }
}

/**
 * Parse `buildArchProbeCommand`'s eventual reply off the remote PTY stream.
 * Same chunk-boundary discipline as parseTmuxSentinel/parseTmuxStageSentinel
 * in pty-manager.ts: the captured combo must be immediately followed by a
 * line terminator, so a chunk boundary landing mid-combo returns `undefined`
 * (caller leaves arch pending) rather than a truncated value. An
 * unrecognised combo (mapUnameToTarget returns null) also returns `null`
 * here — a caller must treat that the same as "never arrived": there is no
 * cached archive to select for an arch tier 4 doesn't recognise.
 */
export function parseArchProbeSentinel(data: string): TmuxStageTarget | null | undefined {
  // ConPTY-glue hazard (ansi-strip.ts): without the strip, glued escapes ride
  // into the `\S+` combo capture, mapUnameToTarget returns null, and the call
  // site LATCHES "unrecognised arch" — tier 4 permanently lost this session.
  const m = stripAnsiForSentinel(data).match(new RegExp(`${ARCH_PROBE_SENTINEL_PREFIX} (\\S+)(?=[\\r\\n])`))
  if (!m) return undefined
  return mapUnameToTarget(m[1])
}
