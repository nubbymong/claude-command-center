import { BrowserWindow, nativeTheme, app } from 'electron'
import * as pty from 'node-pty'
import { PasteQueue } from './paste-queue'
import { runChunkedWrite, WRITE_CHUNK_SIZE } from './pty-chunked-write'
import { buildTmuxLaunchCommand, isSafeTmuxBin, buildSshClaudeFlags } from './ssh-tmux'
import { stripAnsiForSentinel } from './ansi-strip'
import { randomId } from '../shared/id'
import { resolveRunningClaudeInfo } from '../shared/ssh-tmux-persistence'
import { buildTmuxStageCommand, TMUX_STAGE_SENTINEL_PREFIX, TMUX_STAGE_SHA256, tmuxStageAssetUrl, type TmuxStageTarget } from './ssh-tmux-stage'
import { buildTmuxPushCommand, buildArchProbeCommandBracketed, parseArchProbeSentinel, PUSH_ACCUMULATOR_VAR } from './ssh-tmux-push'
import * as os from 'os'
import * as https from 'https'
import * as crypto from 'crypto'
import { execSync, execFile } from 'child_process'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { shouldRegisterRun } from './logging/should-register-run'
import { getLogSupervisor, getTranscriptBinder } from './logging/logging-service'
import { resolveResumeTargetFromTranscript, mangleCwdToProjectDir } from './logging/transcript-discovery'
import { buildClaudeLaunchCommand, resolveResumeLaunch, recoverOrphanResumeLaunch, buildResumeTranscriptPath, quoteArgForShell, modelFlag } from './spawn-claude-command'
import { ensureCompanionDir, nodeFsCompanionDeps } from './logging/companion-dir'
import { forgetSessionName } from './logging/session-name-sidecar'
import { logInfo, logDebug, logError, logWarn } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'
import { buildRemoteSessionCleanupCommand, buildTmuxBinPatchCommand, buildRemoteTmuxKillCommand, getWindowsRemoteSetupCommand, buildWindowsClaudeCommand } from './providers/claude/ssh-shim'
import { isGlobalVisionRunning, getGlobalVisionConfig, teardownVisionSession } from './vision-manager'
import { getConductorMcpPort } from './conductor-mcp-server'
import { buildSshArgs, buildSshExecArgs } from './ssh-args'
import { getRemoteMcpPort } from './ssh-remote-port'
import { resolveClaudeBinary, resolveHostColorScheme, colorFgBgEnvToken } from './providers/claude/spawn'
import { detectClaudeUi, lastPromptLineForClaude, looksLikeShellPromptTail } from './providers/claude/ui-detection'
import { getProvider } from './providers'
import { isSshCapable } from './providers/types'
import type { TelemetrySource } from './providers/types'
import { resolveCwd, isHomeOrAncestor } from './path-utils'
import { buildTerminalLaunchLine } from './terminal-launch-line'
import { dispatchSSHStatuslineUpdate, cleanupStatusFile } from './statusline-watcher'
import { forgetSession } from './background-context'
import { decorateStatuslineWithColour } from './account-color'
import { getGateway, isExactBindSourceActive } from './hooks'
import { injectHooks } from './hooks/session-hooks-writer'
import {
  writeLocalSessionSettings,
  removeLocalSessionSettings,
  writeLocalSessionMcpConfig,
  removeLocalSessionMcpConfig,
} from './hooks/per-session-settings'
import { registerCodexReviewSession, unregisterCodexReviewSession } from './conductor-mcp-server'
import { ensureCanvasPlugin } from './canvas/canvas-plugin'
import { registerCanvasUatRoot, revokeCanvasUatRoots, designateCanvasWorktreeRoot, canvasRootRefusalReason, describeCanvasRootRefusal, setCanvasRootRefusal } from './canvas/canvas-store'
import { designatedWorktreeDir } from './canvas/canvas-worktree'
import { forgetSessionForCanvas } from './canvas/canvas-session-link'
import { disposeSession as disposeCodexReviewUsage } from './codex-review-usage'
import { readCodexAccountEmail } from './account-identity'
import { getProfileConfigDir, setupProfileLinks, getPrimaryProfileId, isValidProfileId, backupProfileHomeToCanonical, syncPrimaryCredentialsWithGlobal } from './account-profiles'
import { captureClaudeAccount, clearClaudeAccount, getAccountIdentity, pushAccountIdentity, startWatchingAccountIdentity, stopWatchingAccountIdentity, getWatchedProfileId } from './claude-account-identity'
import type { AccountIdentity } from '../shared/types'
import { updateSessionMeta, clearSessionMeta, markPtySessionAlive, markPtySessionGone } from './session-registry'
import { readConfig, getConfigDir } from './config-manager'
import { getPtyIntegrityMonitor } from './services/pty-integrity-monitor'
import { getWatchdogManager } from './watchdog/watchdog-manager'

import * as path from 'path'
import * as fs from 'fs'

/**
 * P8.8: per-session Codex spawn-time identity. Captured at PTY spawn,
 * read by tokenomics applyIdentityAtFlush() so claim-time drift on
 * ~/.codex/auth.json doesn't misattribute tokens.
 */
const codexSpawnIdentity = new Map<string, AccountIdentity>()

export function captureCodexSpawnIdentity(sessionId: string): void {
  const id = readCodexAccountEmail()
  if (id) codexSpawnIdentity.set(sessionId, id)
}

export function clearCodexSpawnIdentity(sessionId: string): void {
  codexSpawnIdentity.delete(sessionId)
}

export function getCodexSpawnIdentityMap(): Map<string, AccountIdentity> {
  return codexSpawnIdentity
}

/**
 * Per-process account isolation: run Claude under a per-account fake HOME so the
 * account identity (~/.claude.json, which follows USERPROFILE on Windows / HOME
 * on Unix) is private. CLAUDE_CONFIG_DIR alone does NOT isolate identity. Git/npm
 * are pointed back at the real home so shared dev tooling is unaffected. Returns
 * the env unchanged for the Default account (home == null).
 */
export function withProfileHome(env: Record<string, string>, home: string | null): Record<string, string> {
  if (!home) return env
  const realHome = os.homedir()
  const next: Record<string, string> = {
    ...env,
    USERPROFILE: home,
    // Belt-and-suspenders: keep git/npm reading the real shared config even if a
    // hard-linked dotfile ever desyncs (the mirror also links these through).
    GIT_CONFIG_GLOBAL: path.join(realHome, '.gitconfig'),
    npm_config_userconfig: path.join(realHome, '.npmrc'),
  }
  // macOS locates the login keychain via $HOME (~/Library/Keychains/login.keychain-db).
  // Pointing HOME at the fake profile home — which mirrors only dot-entries, never
  // ~/Library (see mirrorRealHome) — leaves the spawned `claude` with no keychain to
  // resolve, surfacing the macOS "A keychain cannot be found to store ..." dialog (#117).
  // Multi-account is disabled on macOS anyway (see AccountsPanel), so HOME-based identity
  // isolation buys nothing there; leaving HOME at the real home restores keychain access
  // and resolves the single global account correctly. Linux keychains (Secret Service /
  // D-Bus) are not HOME-path-based, so keep the redirect there for multi-account isolation.
  if (process.platform === 'linux') next.HOME = home
  // Claude's native install lives at `$HOME/.local/bin`. With the home redirected,
  // CC computes that as `<home>/.local/bin` (a junction to the real ~/.local) but
  // PATH still carries the *real* home's `.local/bin`, so `/doctor` falsely warns
  // "Native installation ... is not in your PATH". Add the redirected bin dir
  // (deduped, under the env's existing path key) so the self-check passes. The
  // real entry stays first, so which `claude` actually resolves is unchanged.
  const localBin = path.join(home, '.local', 'bin')
  const pathKey = Object.keys(next).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const curPath = next[pathKey] ?? ''
  const already = curPath.split(path.delimiter).some((p) => p.toLowerCase() === localBin.toLowerCase())
  if (!already) next[pathKey] = curPath ? `${curPath}${path.delimiter}${localBin}` : localBin
  return next
}

function escapeShellArg(str: string): string {
  return str.replace(/[\\"$`]/g, '\\$&')
}

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
function escapeRegExp(str: string): string {
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
 *       buffer (`bufferSetupLine`, below), not just the current chunk — a
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
const SSH_REMOTE_ACCOUNT_MAX = 254
const SSH_REMOTE_ACCOUNT_DISPLAY_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
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
  if (!decoded || decoded.length > SSH_REMOTE_ACCOUNT_MAX) return undefined
  // Display-charset gate: an email address only. Anything else (a hostile
  // host trying to plant markup / control chars in the label) is dropped.
  return SSH_REMOTE_ACCOUNT_DISPLAY_RE.test(decoded) ? decoded : undefined
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

// === #242 tier 4: host-side tmux archive cache ===
//
// Tier 4 pushes the SAME v3.7b release asset tier 3 would have curled, over
// the SSH tunnel itself, for remotes with no outbound egress at all. The
// host downloads each arch's archive AT MOST ONCE (per app install) into
// `app.getPath('userData')/tmux-cache/`, sha256-verifying it against the
// SAME `TMUX_STAGE_SHA256` constants ssh-tmux-stage.ts uses, and reuses the
// cached file for every later session that needs that arch. `userData`
// (not `getDataDirectory()`, the pattern github-update.ts uses for the
// ~100-200MB installer) is fine here — this archive is a few hundred KB and
// is not itself an executable staged for direct execution on THIS machine.

function tmuxCacheDir(): string {
  return path.join(app.getPath('userData'), 'tmux-cache')
}

function tmuxCachePath(arch: TmuxStageTarget): string {
  return path.join(tmuxCacheDir(), `tmux-${arch}.tar.gz`)
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Read a previously-cached archive for `arch`, re-verifying its sha256
 * before trusting it. A cache file that fails verification (disk
 * corruption, a manual edit, a leftover from a since-changed pinned tag) is
 * deleted rather than returned, so the caller re-downloads instead of
 * repeatedly pushing a bad archive down every future session to this arch.
 */
function readCachedTmuxArchive(arch: TmuxStageTarget): Buffer | null {
  try {
    const p = tmuxCachePath(arch)
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p)
    if (sha256Hex(buf) !== TMUX_STAGE_SHA256[arch]) {
      try { fs.unlinkSync(p) } catch { /* best-effort */ }
      return null
    }
    return buf
  } catch {
    return null
  }
}

/**
 * Download the v3.7b release asset for `arch` from the SAME pinned URL
 * ssh-tmux-stage.ts's remote script would have curled, sha256-verify it
 * against the SAME embedded digest, and cache it on success. Resolves
 * `null` (never rejects) on ANY failure -- network error, non-2xx status,
 * or a digest mismatch -- so the caller's fallback path (fall through to the
 * unwrapped launch) is a single, uniform check regardless of WHY the bytes
 * couldn't be obtained.
 */
/**
 * Per-request timeout for the tier-4 archive fetch -- applied to BOTH the
 * initial request and the redirect hop. Matches httpsDownload's shape
 * (github-update.ts:515, its 'timeout' handler ~:640) rather than inventing
 * a second one: a bare `https.get(url, cb)` with no `timeout` option and no
 * `req.on('timeout')` handler never gives up on a stalled connection on its
 * own (#242 finding F1). A few-hundred-KB release asset over a healthy link
 * completes in low single-digit seconds; 20s is generous without eating
 * meaningfully into DOWNLOAD_TIMEOUT_MS's 45s flow-level backstop
 * (pty-manager.ts's SSH branch, attemptTmuxPush).
 */
const TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS = 20000

/**
 * Hard ceiling on the accumulated response body -- mirrors httpsDownload's
 * `maxBytes` parameter (github-update.ts:515). The real v3.7b release asset
 * is a few hundred KB; capping at a few MB catches a hostile/misbehaving
 * host serving an unbounded body long before it becomes a meaningful memory
 * concern (#242 finding F5). Checked ON THE WIRE in the `data` handler, not
 * after landing -- same reasoning as httpsDownload's own comment on this.
 */
const TMUX_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Follow-up adversarial pass (coverage MAJOR): exported for tests.
 *
 * Every guard in this function was previously unreachable from the suite --
 * `attemptTmuxPush` goes through the `tmuxArchiveResolver` seam, which tests
 * stub ABOVE this level, so raising TMUX_ARCHIVE_MAX_BYTES to
 * Number.MAX_SAFE_INTEGER, or deleting the https-only redirect refusal
 * outright, left the entire targeted suite green. This is the function whose
 * unbounded body was a round-4 BLOCKER; its guards must be able to fail a test.
 * Exported (rather than reached through a new seam) so the tests drive the real
 * https path with a mocked `https.get`.
 */
export function _downloadAndCacheTmuxArchiveForTest(arch: TmuxStageTarget): Promise<Buffer | null> {
  return downloadAndCacheTmuxArchive(arch)
}

function downloadAndCacheTmuxArchive(arch: TmuxStageTarget): Promise<Buffer | null> {
  // #242 finding F6: same URL parts buildTmuxStageScript's remote curl/wget
  // fragment builds its `_url` from (ssh-tmux-stage.ts) -- see
  // ssh-tmux-push.test.ts's regression test tying the two together.
  const url = tmuxStageAssetUrl(arch)
  const collect = (res: import('http').IncomingMessage, resolve: (v: Buffer | null) => void, redirectsLeft: number, currentUrl: string): void => {
    // GitHub release assets 302 to a signed S3 URL -- one redirect hop is
    // the real-world shape; refuse to follow more than a couple to avoid an
    // unbounded chain against a misbehaving/hostile host.
    const loc = res.headers.location
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirectsLeft > 0) {
      res.resume()
      // #242 round-2 MAJOR fix: `https.get` THROWS SYNCHRONOUSLY (not via
      // 'error') when its URL argument is not https or is relative/malformed
      // -- verified in this worktree (`https.get('http://x')` ->
      // ERR_INVALID_PROTOCOL; `https.get('/relative')` -> ERR_INVALID_URL).
      // `loc` here is a `Location` header taken straight from the response,
      // i.e. attacker/proxy-controlled -- a captive portal or misbehaving
      // proxy answering with a 302 to an `http://` login page or a relative
      // path would throw OUT of this response callback, past the try/catch
      // that wraps only the FIRST request below, into
      // process.on('uncaughtException') (debug-logger.ts) which re-throws
      // anything that isn't EPIPE/EIO -> Electron main process death.
      // Resolve `loc` against the CURRENT request's URL first (so a
      // relative Location is handled the way browsers/curl handle it, not
      // rejected outright) and refuse anything that resolves to a
      // non-https scheme, THEN wrap the redirect `https.get` call itself in
      // a try/catch -- the initial call already has one; this hop must not
      // be the exception.
      let nextUrl: URL
      try {
        nextUrl = new URL(loc, currentUrl)
      } catch {
        resolve(null)
        return
      }
      if (nextUrl.protocol !== 'https:') {
        resolve(null)
        return
      }
      try {
        // #242 finding F1: the redirect hop needs the SAME timeout handling
        // as the initial request below -- httpsDownload's shape
        // (github-update.ts:640) covers both hops, not just the first.
        const redirectReq = https.get(nextUrl, { timeout: TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS }, (res2) => collect(res2, resolve, redirectsLeft - 1, nextUrl.toString()))
        redirectReq.on('error', () => resolve(null))
        redirectReq.on('timeout', () => { try { redirectReq.destroy(new Error('tmux tier-4 download timeout')) } catch {} })
      } catch {
        resolve(null)
      }
      return
    }
    if (!res.statusCode || res.statusCode >= 400) {
      res.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    // #242 finding F5: track accumulated length on the wire and bail past
    // TMUX_ARCHIVE_MAX_BYTES -- destroy(), not resume(), so the socket
    // actually stops instead of draining an unbounded body to /dev/null.
    let received = 0
    let overLimit = false
    res.on('data', (c: Buffer) => {
      if (overLimit) return
      received += c.length
      if (received > TMUX_ARCHIVE_MAX_BYTES) {
        overLimit = true
        logError(`[ssh] tmux tier-4 download for arch=${arch} exceeded the ${TMUX_ARCHIVE_MAX_BYTES}-byte cap -- discarding`)
        res.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    res.on('end', () => {
      if (overLimit) return

      const buf = Buffer.concat(chunks)
      if (sha256Hex(buf) !== TMUX_STAGE_SHA256[arch]) {
        logError(`[ssh] tmux tier-4 download for arch=${arch} failed sha256 verification -- discarding`)
        resolve(null)
        return
      }
      try {
        fs.mkdirSync(tmuxCacheDir(), { recursive: true })
        fs.writeFileSync(tmuxCachePath(arch), buf)
      } catch (err) {
        // Cache write failing doesn't invalidate the verified bytes already
        // in hand -- this session's push still proceeds, just re-downloads
        // next time.
        logError(`[ssh] tmux tier-4 cache write failed for arch=${arch}: ${(err as Error)?.message ?? err}`)
      }
      resolve(buf)
    })
    res.on('error', () => resolve(null))
  }
  return new Promise((resolve) => {
    try {
      // #242 finding F1: httpsDownload's shape (github-update.ts:515/:640) --
      // the `timeout` option alone does not abort anything; only this
      // `req.on('timeout')` handler, destroying the request, actually does.
      const req = https.get(url, { timeout: TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS }, (res) => collect(res, resolve, 2, url))
      req.on('error', () => resolve(null))
      req.on('timeout', () => { try { req.destroy(new Error('tmux tier-4 download timeout')) } catch {} })
    } catch {
      resolve(null)
    }
  })
}

/** Cache hit first; only reaches the network on a miss/failed verification. */
async function getOrDownloadTmuxArchive(arch: TmuxStageTarget): Promise<Buffer | null> {
  const cached = readCachedTmuxArchive(arch)
  if (cached) return cached
  return downloadAndCacheTmuxArchive(arch)
}

// #242 round-3 MAJOR fix (test coverage): attemptTmuxPush calls this
// indirection rather than getOrDownloadTmuxArchive directly, so tests can
// stub the tier-4 archive source (cache hit or fresh download) without
// touching the real filesystem/network -- mirrors the `_set*ForTest` seam
// pattern already used elsewhere in this codebase (see
// claude-account-identity.ts's `_setRootsForTest`). Reassigned ONLY by
// `_setTmuxArchiveResolverForTest`; every production code path always goes
// through the real `getOrDownloadTmuxArchive`.
let tmuxArchiveResolver: (arch: TmuxStageTarget) => Promise<Buffer | null> = getOrDownloadTmuxArchive

/** Test-only: override (or, passing `null`, restore) the tier-4 archive
 *  source `attemptTmuxPush` calls, so a test can drive a full push without
 *  hitting disk or the network. */
export function _setTmuxArchiveResolverForTest(fn: ((arch: TmuxStageTarget) => Promise<Buffer | null>) | null): void {
  tmuxArchiveResolver = fn ?? getOrDownloadTmuxArchive
}

/**
 * #242 finding F1 (b): per-session nonce, keyed by sessionId, set once at
 * spawn time (see spawnPty's SSH branch) and read by both the setup/stage/
 * push writers (to bake it into the scripts they build) and the onData
 * parsers (to require it in the sentinels they accept). Cleared in
 * cleanupSessionResources so a stale nonce can never leak into a future,
 * unrelated spawn of the same sessionId.
 */
const sshNonceBySession = new Map<string, string>()

/** Test-only: read the REAL per-session nonce spawnPty generated, so a test
 *  can construct a genuinely nonce-carrying sentinel to drive the real flow
 *  end to end, rather than guessing/hardcoding a value that would never
 *  match production randomId() output. */
export function _getSshNonceForTest(sessionId: string): string | undefined {
  return sshNonceBySession.get(sessionId)
}

/** Test-only: whether this session still has a captured end-remote target. Pins
 *  the lifecycle fix that the target must SURVIVE a natural PTY exit (a transient
 *  drop, so a later End can still reach the host) and be dropped only on a
 *  deliberate close (killPty) -- adversarial review 2026-08-18. */
export function _hasSshTargetForTest(sessionId: string): boolean {
  return sshTargetBySession.has(sessionId)
}

/**
 * #242 finding I1: per-session buffer for the not-yet-terminated tail of
 * the `setup ok` completion sentinel line, mirroring `sshOscBuffers`/
 * `extractSshOscSentinels` above -- same per-session map shape, same
 * accumulate-then-clear discipline, same size cap. A real SSH link
 * routinely segments a single logical line across multiple PTY chunks
 * (`setup ok <nonce> tmux=pa` | `th\r\n`); `parseTmuxSentinel`'s
 * chunk-boundary discipline (require the captured token be immediately
 * followed by a line terminator) correctly refuses to match a truncated
 * read off the FIRST chunk alone, but nothing re-parsed the SECOND chunk
 * once the (pre-fix) bare-substring completion latch had already fired off
 * the first one -- the tmux probe was then lost silently for the rest of
 * the session on every segmented line, which is exactly the shape a real
 * SSH connection produces (live-test repro, #242 finding I1). Buffering the
 * accumulated text (not just the latest chunk) and re-testing the SAME
 * nonce-bearing regex against it on every chunk, until it actually
 * resolves, closes that gap.
 */
const MAX_SETUP_LINE_BUFFER = 4096

/**
 * ROUND-3 CORRECTION. The first cut of this buffer covered only the two
 * setup-ok latches, leaving the tier-3/4 stage sentinel and the tier-4 arch
 * probe parsing the raw chunk -- so I1 stayed live on exactly the tiers a
 * tmux-less remote depends on. Proven in review by driving the real flow: a
 * stage `ok path=` split across two chunks never resolves, the flow stalls to
 * the 20s STAGE_TIMEOUT and silently loses tmux; an arch probe split across
 * two chunks leaves detectedArch null, so tier 4 is unreachable on any
 * segmenting link.
 *
 * Each sentinel gets its OWN buffer rather than sharing one, because they can
 * interleave: the arch probe and the stage result are emitted by the same
 * remote fragment and may arrive in one chunk, in either order, or split.
 * Sharing a buffer would let one sentinel's resolve-and-clear discard the
 * other's partial line.
 */
type SshLineBufferKind = 'setup' | 'stage' | 'arch'
const sshLineBuffers = new Map<string, string>()
const sshLineBufferKey = (sessionId: string, kind: SshLineBufferKind): string => `${sessionId}:${kind}`

/**
 * Accumulate `chunk` onto session `sessionId`'s setup-line buffer and return
 * the FULL combined text callers should parse against instead of `chunk`
 * alone -- mirroring `extractSshOscSentinels` above, which parses the
 * complete combined text first and caps only what it RETAINS for next time.
 * ROUND-2 CORRECTION: an earlier version capped the RETURNED value at
 * `MAX_SETUP_LINE_BUFFER` too, not just what got stored -- so a genuine,
 * correctly-nonced sentinel followed by more than the cap's worth of trailing
 * bytes in the SAME chunk was silently dropped from the text actually
 * parsed, and the session never latched setupDone at all (regression proven
 * in review). The sentinel is not guaranteed to be near the end of the
 * combined text -- trailing output in the same chunk is exactly the failure
 * mode this correction closes -- so only the STORED copy (what the next
 * chunk will be appended to) is capped, keeping its tail. A remote that
 * never emits the line's terminating `\r`/`\n` (hostile, or simply chatty
 * pre-setup output) must not grow the stored buffer without bound for the
 * rest of the session.
 */
function bufferSshLine(sessionId: string, kind: SshLineBufferKind, chunk: string): string {
  const key = sshLineBufferKey(sessionId, kind)
  const combined = (sshLineBuffers.get(key) ?? '') + chunk
  sshLineBuffers.set(
    key,
    combined.length > MAX_SETUP_LINE_BUFFER ? combined.slice(combined.length - MAX_SETUP_LINE_BUFFER) : combined
  )
  return combined
}

/** Back-compat alias for the setup-ok latches, which read more clearly named. */
function bufferSetupLine(sessionId: string, chunk: string): string {
  return bufferSshLine(sessionId, 'setup', chunk)
}

/** Drop one of `sessionId`'s sentinel buffers once that sentinel has resolved --
 *  nothing left to accumulate for it for the rest of the session. */
function clearSshLineBuffer(sessionId: string, kind: SshLineBufferKind): void {
  sshLineBuffers.delete(sshLineBufferKey(sessionId, kind))
}

function clearSetupLineBuffer(sessionId: string): void {
  clearSshLineBuffer(sessionId, 'setup')
}

/** Teardown: drop EVERY sentinel buffer for the session. Called from
 *  cleanupSessionResources -- a per-kind clear on resolve is not enough,
 *  because a session can die with a sentinel still unresolved. */
function clearAllSshLineBuffers(sessionId: string): void {
  for (const kind of ['setup', 'stage', 'arch'] as const) clearSshLineBuffer(sessionId, kind)
}

/** Test-only: read the current length of `sessionId`'s setup-line buffer
 *  (mirrors `_getSshNonceForTest`'s role) -- `undefined` once cleared/never
 *  populated. Lets tests assert the buffer is actually bounded and actually
 *  torn down, rather than just asserting on end-to-end launch behaviour that
 *  a leak/unbounded-growth mutation would leave unchanged. */
export function _getSetupLineBufferLenForTest(
  sessionId: string,
  kind: SshLineBufferKind = 'setup',
): number | undefined {
  return sshLineBuffers.get(sshLineBufferKey(sessionId, kind))?.length
}

interface PtySession {
  ptyProcess: pty.IPty
  sessionId: string
}

// Buffer writes for PTYs that haven't spawned yet (e.g., partner terminal initially hidden)
const pendingWrites = new Map<string, string[]>()

/**
 * Sessions whose PTY exists but is still the bare shell, waiting for the launch
 * line queued 300ms behind it. A write that lands in that window used to go
 * straight to the shell, and a trailing `\r` submitted it as a SHELL COMMAND --
 * an Ask Conductor question typed at a session that was still starting was
 * executed by PowerShell instead of being asked of Claude. `writePty` buffers
 * while a session is in here, and the launch timer replays once the real
 * program owns the terminal.
 */
const launchPendingSessions = new Set<string>()

export interface SSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  password?: string
  postCommand?: string
  sudoPassword?: string
  /**
   * #242 tier 5: true when this spawn respawns a session that had
   * previously reached `claude-running` over THIS SSH config — set by the
   * renderer session store (never persisted to disk; see Session.
   * sshReachedClaudeRunning in sessionStore.ts) when it re-spawns, e.g. via
   * the Restart control after a dropped connection. Consumed by
   * writeClaudeCmd via buildSshClaudeFlags (ssh-tmux.ts) to decide whether
   * the bare (non-tmux) launch should carry `--continue`. Undefined/false
   * on a session's first-ever spawn, where there is no prior conversation
   * to continue.
   */
  reconnect?: boolean
  /**
   * SSH tmux enhancement (item 1): "Detachable" (persistent remote session)
   * toggle, from SshConfig.detachable. DEFAULT ON — only an explicit `false`
   * disables the #242 tmux-persistence ladder (no detection, no staging, no
   * silent install), leaving a bare `claude` that resumes via `--continue`
   * on reconnect. Owner requirement: tmux must never be installed silently,
   * so persistence is user-controlled by this flag.
   */
  detachable?: boolean
  /**
   * SSH tmux enhancement (item 3): remote OS. 'windows' selects the Windows
   * setup path (PowerShell delivery + CONOUT$ shim + cmd.exe launch, no tmux);
   * 'auto'/'unix'/undefined keep the POSIX path unchanged. PROTOTYPE.
   */
  remoteOs?: 'auto' | 'unix' | 'windows'
}

/**
 * Per-session SSH flow controller exposed via IPC. Renderer triggers
 * stage transitions in manual mode by calling these.
 */
export interface SshFlowController {
  runPostCommand: () => void
  launchClaude: () => void
  skip: () => void
  destroy: () => void
  /** item 5 (resume cascade, "no host"): called from the shared PTY onExit when
   *  the ssh process dies. If the flow never reached a good terminal state
   *  (i.e. the connection failed at/around connect), emit `failed` with a
   *  'connection' reason so the overlay can offer Retry rather than sitting on
   *  a dead "connecting…". A no-op once claude-running/shell-only/skipped. */
  handlePtyExit: () => void
  /** Returns the latest emitted state, used by the renderer overlay
   * on mount to catch up if it missed earlier emits. */
  getState: () => { state: SshFlowState; info?: string }
}

const sshFlows = new Map<string, SshFlowController>()

/** Public accessor for IPC handlers. */
export function getSshFlow(sessionId: string): SshFlowController | undefined {
  return sshFlows.get(sessionId)
}

export type SshFlowState =
  | 'connecting'           // SSH still starting / authenticating
  | 'awaiting-postcommand' // host shell ready, postCommand configured, awaiting user click
  | 'awaiting-claude'      // host or inner shell ready, awaiting user click to launch claude
  | 'running-postcommand'  // postCommand in flight
  | 'running-setup'        // setup blob in flight
  | 'running-claude'       // claudeCmd written, claude UI not yet detected
  | 'claude-running'       // claude UI confirmed; no more prompts needed
  | 'shell-only'           // session is shell-only and we're done
  | 'skipped'              // user clicked skip; pty is theirs to drive manually
  | 'failed'               // setup timed out or post-command errored

function emitSshFlowState(win: BrowserWindow, sessionId: string, state: SshFlowState, info?: string): void {
  if (win.isDestroyed()) return
  try {
    win.webContents.send(`ssh:flowState:${sessionId}`, { state, info })
  } catch { /* renderer gone */ }
}

/**
 * SSH tmux enhancement (items 8/9/10): push per-session persistence status +
 * the remote account descriptor to the renderer. Separate from the flow-state
 * channel because these outlive the connect flow (they label the session in
 * the sidebar/header for its whole life) and update the session store, not the
 * transient overlay. Fire-and-forget; a destroyed window is a no-op.
 */
function emitSshSessionInfo(win: BrowserWindow, sessionId: string, info: { tmuxPersistent?: boolean; remoteAccount?: string }): void {
  if (win.isDestroyed()) return
  try {
    win.webContents.send(`ssh:sessionInfo:${sessionId}`, info)
  } catch { /* renderer gone */ }
}

const ptySessions = new Map<string, PtySession>()

// Codex-provider telemetry sources: keyed by sessionId, stopped on PTY exit / kill.
const codexTelemetrySources = new Map<string, TelemetrySource>()

// T8b (bug #5): exact-conversation resume target captured at the TOP of a
// respawn (in-session Restart / Switch-account), keyed by sessionId. Captured
// BEFORE killPty so the live conversation's uuid + its real cwd are read off
// the just-bound transcript before the old run's async endRun clears the
// binder map. Consumed (and deleted) once in the Claude launch builder, and
// deleted in killPty so a stale target can never leak into an unrelated future
// spawn. Fail-open: a null/missing entry => unchanged existing resume behaviour.
const lastResumeTarget = new Map<string, { uuid: string; cwd: string }>()

function getLastResumeTarget(sessionId: string): { uuid: string; cwd: string } | undefined {
  return lastResumeTarget.get(sessionId)
}

function clearLastResumeTarget(sessionId: string): void {
  lastResumeTarget.delete(sessionId)
}

// SSH tmux enhancement (item 4): the connection target for each live SSH
// session, captured at spawn so endSshRemote can open a SEPARATE ssh exec to
// kill the remote tmux session + sidecars without touching the live PTY (where
// the keystrokes would land in Claude). Cleared on DELIBERATE close (killPty),
// NOT on a natural PTY exit: after a transient drop the tab stays (Retry), and
// a later "End remote" must still be able to reach the host to kill the
// now-detached remote -- clearing it on every exit made End a silent no-op
// after any wifi blip (adversarial review, 2026-08-18).
// #572: the saved SSH password (when the session authed that way) rides along
// so End can actually reach a password-only host -- see endSshRemote. It stays
// in this main-process map exactly as long as the target itself (cleared on
// deliberate close), is never IPC'd, logged or embedded in argv, and is only
// ever WRITTEN to the End exec's own PTY in answer to a real password prompt.
const sshTargetBySession = new Map<string, { username: string; host: string; port: number; password?: string }>()

// SSH tmux enhancement (items 1/4): sessions whose launch actually wrapped in a
// tmux persistence session (`tmuxWrapped` at writeClaudeCmd). The remote for
// these SURVIVES a local PTY teardown, so close/quit must DETACH, never destroy:
//   - killPty must NOT type the U8 in-band `rm` cleanup down the live PTY -- for
//     a tmux-wrapped launch the foreground is Claude, so the bytes land in its
//     composer (LF doesn't submit) and are left PRE-TYPED in a session the user
//     chose to leave running; the End-remote exec already removes the sidecars.
//   - gracefulExitPty (app quit) must NOT send `/exit` -- inside tmux that quits
//     Claude and tears the session down; killing the local PTY detaches instead.
// Both are the exact regressions the persistence feature introduced against the
// pre-existing close/quit paths (adversarial review, 2026-08-18). Cleared on
// deliberate close alongside sshTargetBySession.
const sshTmuxWrappedBySession = new Set<string>()

/**
 * SSH tmux enhancement (item 4): deliberately END a persistent remote session.
 * Opens a fresh, non-interactive ssh exec (buildSshExecArgs) that runs
 * buildRemoteTmuxKillCommand -- `tmux kill-session -t ccc-<sid>` (both
 * host-authored tmux-bin forms) plus sidecar cleanup -- then exits. Fire-and-
 * forget with a bounded lifetime; the caller kills the local PTY separately.
 *
 * A no-op when we have no target for the session (never an SSH session, or
 * already cleaned up).
 *
 * #572: on a key/agent host this is the original BatchMode execFile. On a host
 * whose session authed by SAVED PASSWORD, BatchMode made End a SILENT NO-OP --
 * the exec failed fast, the remote tmux+claude survived, and every "ended"
 * session kept ~350MB of the host's RAM forever (the mongminer exhaustion,
 * 2026-08-30: a box with zero visible sessions held two orphaned claudes).
 * Password targets now run the SAME argv (minus BatchMode, plus
 * NumberOfPasswordPrompts=1) under a small dedicated PTY, answer exactly one
 * real password prompt with the session's saved password, and wait for exit.
 * The prompt match reuses the connect flow's tightened rule: strip escapes
 * first (ConPTY glues them onto the prompt -- the RC9 lesson), then require
 * the last non-empty line to END with `password:`/`password?` so a mid-line
 * mention of passwords (the usual MOTD shape) can't trigger the write. A
 * banner line deliberately ENDING in `password:` would still fire it — that
 * is accepted, because the write's only possible destination is this PTY,
 * which dials the credential's own host-key-verified host (accept-new
 * REFUSES a changed key): a premature write to the password's owner, never a
 * third-party leak (adversarial pass, 2026-08-30).
 *
 * Returns the outcome so callers that care (the live matrix) can await it;
 * the IPC caller stays fire-and-forget.
 */
const END_REMOTE_TIMEOUT_MS = 12000
const END_REMOTE_PASSWORD_TIMEOUT_MS = 20000
const END_REMOTE_PASSWORD_PROMPT_RE = /password[:?]\s*$/i
export function endSshRemote(sessionId: string): Promise<'completed' | 'failed' | 'no-target'> {
  const target = sshTargetBySession.get(sessionId)
  if (!target) return Promise.resolve('no-target')
  const bin = os.platform() === 'win32' ? 'ssh.exe' : 'ssh'
  if (target.password) {
    // Password-auth host: PTY + one answered prompt (see doc above).
    logInfo(`[ssh] ${sessionId}: ending remote session (password host; kill exec under a dedicated PTY)`)
    return new Promise((resolve) => {
      let settled = false
      let child: pty.IPty | null = null
      const done = (r: 'completed' | 'failed', why: string): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        try { child?.kill() } catch { /* already gone */ }
        logInfo(`[ssh] ${sessionId}: end-remote (password) ${r} (${why})`)
        resolve(r)
      }
      const deadline = setTimeout(() => done('failed', 'timeout'), END_REMOTE_PASSWORD_TIMEOUT_MS)
      try {
        // Argv build INSIDE the executor's try (adversarial pass): a sync throw
        // here must resolve 'failed' like every other failure, not escape as an
        // exception into a fire-and-forget IPC caller.
        const args = buildSshExecArgs(target, buildRemoteTmuxKillCommand(sessionId), os.platform(), { batchMode: false })
        child = pty.spawn(bin, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.homedir(), env: process.env as Record<string, string> })
      } catch (err) {
        done('failed', `spawn: ${(err as Error)?.message ?? err}`)
        return
      }
      let passwordSent = false
      let tail = ''
      child.onData((d) => {
        // Bounded rolling tail; the prompt always sits at the end of it.
        tail = (tail + d).slice(-2048)
        // `settled` too (adversarial pass): after the timeout killed the child,
        // a final ConPTY flush ending in a prompt-shaped line must not write
        // into the dead PTY from inside the emitter.
        if (settled || passwordSent) return
        const lines = stripAnsiForSentinel(tail).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
        const last = lines[lines.length - 1] ?? ''
        if (END_REMOTE_PASSWORD_PROMPT_RE.test(last)) {
          passwordSent = true
          // CR/LF stripped: a saved password cannot legitimately contain one
          // (single-line field), and an embedded newline would otherwise split
          // this into extra PTY lines. try/catch: the exit/data race can leave
          // the PTY closed mid-callback, and a throw here is inside node-pty's
          // emitter — main-process uncaughtException territory.
          try {
            child!.write(`${target.password!.replace(/[\r\n]/g, '')}\r`)
          } catch {
            /* PTY already closed; onExit/timeout settles the outcome */
          }
        }
      })
      child.onExit(({ exitCode }) => done(exitCode === 0 ? 'completed' : 'failed', `exit=${exitCode}`))
    })
  }
  // Key/agent host: the original fire-fast BatchMode exec, now with an
  // awaitable outcome.
  return new Promise((resolve) => {
    try {
      const args = buildSshExecArgs(target, buildRemoteTmuxKillCommand(sessionId), os.platform())
      logInfo(`[ssh] ${sessionId}: ending remote session (tmux kill-session + sidecar cleanup over a separate exec)`)
      const child = execFile(bin, args, { timeout: END_REMOTE_TIMEOUT_MS, windowsHide: true }, (err) => {
        if (err) logInfo(`[ssh] ${sessionId}: end-remote exec exited non-zero (host was already gone, or refused key auth): ${err.message}`)
        else logInfo(`[ssh] ${sessionId}: end-remote exec completed`)
        resolve(err ? 'failed' : 'completed')
      })
      // Never let a stuck child keep a handle alive; execFile's own timeout also
      // covers this, but unref so it can't hold the process open.
      try { child.unref() } catch { /* noop */ }
    } catch (err) {
      logError(`[ssh] ${sessionId}: endSshRemote failed to dispatch: ${(err as Error)?.message ?? err}`)
      resolve('failed')
    }
  })
}

/** Test-only: seed an End target without a live spawn (unit tests for #572). */
export function _setSshTargetForTest(sessionId: string, target: { username: string; host: string; port: number; password?: string }): void {
  sshTargetBySession.set(sessionId, target)
}

// === SSH OSC sentinel parser ===
//
// Remote SSH sessions can't write status files to the local host, so the
// SSH statusline shim (deployed during remote setup; lives in
// providers/claude/ssh-shim.ts) emits an OSC sentinel to /dev/tty containing
// the status JSON. The sentinel travels back through the SSH PTY stream to
// this process.
//
// We extract sentinels from each chunk before forwarding the cleaned data to
// xterm, then dispatch the parsed JSON via statusline-watcher's existing pipeline.
const SSH_OSC_PREFIX = '\x1b]9999;CMSTATUS='
const SSH_OSC_TERMINATOR = '\x07'
const MAX_OSC_BUFFER = 32 * 1024  // cap to prevent runaway memory on malformed streams
const sshOscBuffers = new Map<string, string>()

/**
 * Strip SSH OSC sentinels from a PTY data chunk.
 * Returns the cleaned chunk (sentinels removed). Parsed sentinel payloads
 * are dispatched to statusline-watcher synchronously.
 *
 * Handles partial sentinels split across chunks via per-session buffering.
 */
function extractSshOscSentinels(sessionId: string, chunk: string): string {
  const combined = (sshOscBuffers.get(sessionId) || '') + chunk
  let cleaned = ''
  let i = 0
  while (i < combined.length) {
    const start = combined.indexOf(SSH_OSC_PREFIX, i)
    if (start === -1) {
      cleaned += combined.slice(i)
      sshOscBuffers.delete(sessionId)
      return cleaned
    }
    cleaned += combined.slice(i, start)
    const end = combined.indexOf(SSH_OSC_TERMINATOR, start + SSH_OSC_PREFIX.length)
    if (end === -1) {
      // Partial sentinel — buffer the leftover for the next chunk
      const leftover = combined.slice(start)
      if (leftover.length > MAX_OSC_BUFFER) {
        // Likely a false start or junk — drop the buffer
        sshOscBuffers.delete(sessionId)
      } else {
        sshOscBuffers.set(sessionId, leftover)
      }
      return cleaned
    }
    const json = combined.slice(start + SSH_OSC_PREFIX.length, end)
    try { dispatchSSHStatuslineUpdate(json) } catch { /* ignore */ }
    i = end + SSH_OSC_TERMINATOR.length
  }
  sshOscBuffers.delete(sessionId)
  return cleaned
}

/**
 * Resolve the claude command for PTY usage.
 * If legacyVersion is provided and enabled, uses the managed install binary.
 * Otherwise checks for native CLI (claude.exe) first, then npm wrapper (claude.cmd).
 */
export function resolveClaudeForPty(legacyVersion?: { enabled: boolean; version: string }): { cmd: string; args: string[] } {
  return resolveClaudeBinary(legacyVersion)
}

/**
 * Resolve path to the resume-picker.js script.
 * Deployed to ResourcesDirectory/scripts/ by deployStatuslineScript().
 */
function getResumePickerPath(): string | null {
  try {
    const scriptPath = path.join(getResourcesDirectory(), 'scripts', 'resume-picker.js')
    if (fs.existsSync(scriptPath)) return scriptPath
  } catch { /* resources dir may not be configured yet */ }
  return null
}

export function spawnPty(
  win: BrowserWindow,
  sessionId: string,
  options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: SSHOptions
    shellOnly?: boolean
    /** Terminal-only launcher: command + args run once when the shell opens. */
    terminalOptions?: { command?: string; args?: string; hasSecretArg?: boolean; elevated?: boolean }
    /** Secret argument resolved from the OS keychain in the IPC handler (main only). */
    terminalSecret?: string
    /** Command-button secrets for this shell, keyed by command id (main only). */
    commandSecrets?: Record<string, string>
    /** Ask Conductor's opening question. Travels in the spawn ENV; the launch
     *  line carries only a reference to it (see askPromptRef). */
    askPrompt?: string
    /** True when this session is an Ask Conductor one-shot (session.kind ===
     *  'ask'). Threaded explicitly rather than inferred from askPrompt, which
     *  is empty for a question-less Ask launch and cleared on every restart
     *  (#266 MAJOR-5): those inferences armed a watchdog on an ephemeral,
     *  badge-less surface. */
    isAsk?: boolean
    elevated?: boolean
    configLabel?: string
    /** Config id that owns the session. Stamped onto the session-log row for per-config filtering. */
    configId?: string
    /**
     * Task 9: per-config logging opt-out. DEFAULT-TRUE — only an explicit `false`
     * disables run registration for this session (the global settings flag and
     * shellOnly/ssh/provider gates still apply). The SessionDialog UI toggle that
     * binds this is a later task (T16); this field is plumbed end-to-end now.
     */
    loggingEnabled?: boolean
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    // Widened to string — the IPC schema's charset guard (/^[a-zA-Z0-9_-]+$/) is the real contract.
    effortLevel?: string
    // Per-config permission mode -> `--permission-mode`. 'default'/'' => no flag.
    // IPC schema constrains to the CLI's own mode choices.
    permissionMode?: string
    // Advanced escape hatch appended verbatim to the claude command. IPC schema
    // charset-guards it (no shell metacharacters) and rejects CCC-managed flags.
    extraArgs?: string
    disableAutoMemory?: boolean
    model?: string
    /** Per-session account isolation: spawn claude under this profile's CLAUDE_CONFIG_DIR. */
    profileId?: string
    /** v1.5 P6: when true, register session into MCP server's codex_review opt-in set. */
    enableCodexReview?: boolean
    /**
     * T8b (bug #5): app-relaunch exact-conversation resume. The renderer passes
     * the persisted {uuid,cwd} on a restored session so the respawn resumes the
     * SAME conversation it was on at quit (not the newest in the cwd's folder).
     * In-session Restart/Switch DO NOT set this — main self-captures via
     * lastResumeTarget. Fail-open: ignored if the transcript/cwd no longer exist.
     */
    resume?: { uuid: string; cwd: string }
    provider?: 'claude' | 'codex'
    codexOptions?: {
      model?: string
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
    }
  }
): void {
  logInfo(`[pty] Spawning PTY for session ${sessionId} (ssh=${!!options?.ssh}, shellOnly=${!!options?.shellOnly}, cwd=${options?.cwd || 'default'})`)

  // T8b (bug #5): in-session Restart / Switch-account REUSE this sessionId and
  // call spawnPty synchronously after killing the old PTY. The old run's
  // endRun() (which clears the binder's per-session bind) fires ASYNC, after we
  // return — so READ the live conversation's resume target HERE, before
  // killPty, while the binder still holds it. Only for Claude non-shell, non-SSH
  // sessions (the binder only tracks Claude transcripts). Fail-open: any miss
  // leaves no entry and the spawn falls back to existing behaviour.
  // NOTE: stored into lastResumeTarget AFTER killPty (which clears the map), so
  // a fresh capture survives its own kill instead of being wiped by it.
  let capturedResumeTarget: { uuid: string; cwd: string } | null = null
  if (!options?.ssh && !options?.shellOnly && (options?.provider ?? 'claude') === 'claude') {
    try {
      // #480: resume ONLY from an EXACT (authenticated) bind. The previous
      // getLatestTranscriptPath() also returned heuristic binds — a newest-file
      // scan of the shared per-repo transcript folder — which resumed a SIBLING
      // card's conversation when several cards ran in one repo. An exact-only
      // capture means "resume the conversation the hook confirmed for THIS
      // session, or start fresh"; a fresh start beats reopening a stranger.
      const binder = getTranscriptBinder()
      let latest = binder?.getExactResumeTarget(sessionId) ?? null
      // Hooks-off fallback: when no EXACT source can ever arrive (hooks disabled
      // or gateway down), fall back to the heuristic bind and WARN. In that
      // degraded config there is no authenticated source, so best-effort resume
      // beats never resuming — but it can cross if cards share a repo folder.
      if (!latest && !isExactBindSourceActive()) {
        latest = binder?.getLatestTranscriptPath(sessionId) ?? null
        if (latest) {
          logWarn(`[pty] #480 hooks-off resume fallback for ${sessionId}: hooks inactive, using heuristic bind ${latest} (best-effort; may cross if multiple cards share this repo)`)
        }
      }
      if (latest) {
        capturedResumeTarget = resolveResumeTargetFromTranscript(latest)
      }
    } catch (err) {
      logWarn(`[pty] T8b resume-target capture failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
    }
  }

  killPty(sessionId)

  if (capturedResumeTarget) {
    lastResumeTarget.set(sessionId, capturedResumeTarget)
    logInfo(`[pty] T8b captured resume target for ${sessionId}: uuid=${capturedResumeTarget.uuid} cwd=${capturedResumeTarget.cwd}`)
  }

  const cols = options?.cols || 120
  const rows = options?.rows || 30

  let ptyProcess: pty.IPty

  // Hoisted to function scope so the shared post-spawn tail (session-log capture)
  // can read them for EVERY branch (ssh / codex / claude / shell-only). They were
  // previously declared inside the codex/claude branches and so were out of scope
  // at capture?.start() in the tail -> a latent ReferenceError on spawn-with-logging.
  const resolvedCwd = resolveCwd(options?.cwd)
  // FIX 4: the directory Claude is ACTUALLY launched in. Defaults to the
  // configured resolvedCwd, but the Claude branch overrides it to the resume
  // target's real cwd (claudeCwd) when an exact-resume applies. runStart()'s
  // projectCwd + the heuristic binder's registerRun() must use THIS so the run
  // is stamped with — and the 20s fallback scans — the folder Claude ran in.
  let effectiveLaunchCwd = resolvedCwd
  // Part A: the resume uuid an exact-resume applied (function-scoped so the
  // deterministic resume-bind at the registerRun site below can see it). Null
  // unless the Claude branch resolved an exact-resume launch.
  let resumeUuidForBind: string | null = null
  let resolvedProfileId: string | undefined = undefined

  // See `launchPendingSessions`. A session with a launch line is not ready for
  // input until that line has been written, so hold writes until then and flush
  // here. Always paired with `launchPendingSessions.delete` so a failed or
  // raced launch releases the hold instead of buffering forever.
  let launchWriteScheduled = false
  const releaseLaunchHold = () => {
    launchPendingSessions.delete(sessionId)
    const pending = pendingWrites.get(sessionId)
    if (!pending) return
    logInfo(`[pty] Replaying ${pending.length} buffered write(s) for ${sessionId}`)
    for (const data of pending) {
      // Same chunking rule the live path uses: a paste larger than
      // WRITE_CHUNK_SIZE overflows/truncates ConPTY's input buffer if written in
      // one go. Holding a write must not change how it is delivered.
      if (data.length > WRITE_CHUNK_SIZE) writeChunked(sessionId, ptyProcess, data)
      else ptyProcess.write(data)
    }
    pendingWrites.delete(sessionId)
  }
  /**
   * The launch never landed (the PTY was killed/replaced inside the window, or
   * the launch write threw). There is no program to deliver held writes to, so
   * drop them with the hold -- leaving them buffered orphans them: nothing
   * replays that buffer, and it survives until session teardown.
   */
  const abandonLaunchHold = () => {
    launchPendingSessions.delete(sessionId)
    const dropped = pendingWrites.get(sessionId)?.length ?? 0
    if (dropped > 0) logWarn(`[pty] Dropping ${dropped} held write(s) for ${sessionId}: launch never completed`)
    pendingWrites.delete(sessionId)
  }

  if (options?.ssh) {
    // Defensive guard: Codex over SSH is not yet supported. The renderer-side
    // dialog prevents this combination, but guard here in case of direct IPC calls.
    if ((options?.provider ?? 'claude') === 'codex') {
      throw new Error('Codex over SSH is not supported in v1.5.0 (planned for v1.5.x). Switch the session to local or pick the Claude provider.')
    }

    // SSH session: spawn ssh command, then chain claude after cd
    const ssh = options.ssh
    // SSH tmux enhancement (item 1): the "Detachable" toggle. DEFAULT ON --
    // only an explicit `false` opts out of the #242 tmux-persistence ladder.
    // When off: no tier-3/4 staging (proceedAfterSetup skips it, so nothing is
    // ever installed on the remote) AND no wrap even if the host already has
    // tmux (writeClaudeCmd's gate), leaving a bare `claude` that resumes via
    // `--continue` on reconnect.
    const persistenceEnabled = ssh.detachable !== false
    // Lift: SSH setup script + per-session settings path live on the
    // ClaudeProvider's SSH-capable surface (see providers/claude/ssh-shim.ts).
    const claudeProvider = getProvider('claude')
    if (!isSshCapable(claudeProvider)) throw new Error('Claude provider must be SSH-capable')
    // Base ssh argv (target, port, TTY, host-key policy) + a win32-only
    // ControlMaster/ControlPath override (#241) + the Conductor MCP reverse
    // tunnel, built in ./ssh-args so the exact flag list is unit-tested. The
    // tunnel host-side target is 127.0.0.1, not `localhost`: the MCP server binds
    // IPv4-only (conductor-mcp-server.ts listens on '127.0.0.1'), but Windows
    // resolves `localhost` IPv6-first (::1) -- a dead address that would
    // ECONNREFUSED and kill the channel ("socket connection closed unexpectedly"
    // on the remote MCP client).
    // #24: a STABLE per-session remote listen port for the MCP reverse tunnel,
    // so multiple sessions to the SAME host don't collide on one fixed port.
    // Forward `-R <remoteMcpPort>:127.0.0.1:<localMcpPort>` and bake the remote
    // Claude's MCP URL with the same per-session port (setupOpts below).
    const localMcpPort = getConductorMcpPort()
    const remoteMcpPort = getRemoteMcpPort(sessionId, localMcpPort)
    const sshArgs = buildSshArgs(ssh, localMcpPort, os.platform(), remoteMcpPort)

    // HTTP Hooks Gateway: when enabled, tunnel the gateway's loopback port so
    // Claude Code inside the SSH session can reach it via http://localhost:<port>.
    // Register the session secret up-front so the generated setup script can
    // bake the URL + X-CCC-Hook-Token header into the remote settings file.
    // HOOKS INJECTION DISABLED — the Live Activity feed UI was cut in
    // commit c957e5d, leaving the gateway running with no consumer. We
    // were still injecting `hooks` blocks into per-session settings,
    // which made every Pre/PostToolUse call from Claude Code fire at
    // http://localhost:<port>/hook/<sid> — fine on local sessions, but
    // on SSH the `-R port:localhost:port` reverse tunnel often can't be
    // established (sshd's AllowTcpForwarding etc.) and every tool call
    // logs a ECONNREFUSED. Re-enable when a consumer feature ships
    // (live activity v2, hook-driven analytics, etc.) and revisit the
    // SSH tunnel-failure UX.
    const gw = getGateway()
    const gwStatus = gw?.status()
    void gw; void gwStatus
    const hooksConfig: { port: number; secret: string } | null = null

    const sshBinary = os.platform() === 'win32' ? 'ssh.exe' : 'ssh'

    // SSH sessions never designate a canvas worktree (their cwd is remote); pass
    // a clone with any inherited CCC_SESSION_WORKTREE removed, never process.env
    // by reference (which we must not mutate).
    const sshEnv = { ...(process.env as Record<string, string>) }
    delete sshEnv.CCC_SESSION_WORKTREE
    ptyProcess = pty.spawn(sshBinary, sshArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: sshEnv,
      useConpty: true
    })

    // SSH manual flow state machine. The renderer shows an in-pane
    // overlay with explicit "Run post-connect command" / "Launch Claude"
    // / "Skip" buttons. Each click triggers one of the writer helpers
    // below via SshFlowController IPC. An idle-data fallback timer
    // (1.5 s of no PTY data) advances "running-X → next" automatically
    // once the user-gated chain has started, so users never have to
    // click more than twice per session.
    //
    // The legacy auto-detection state machine has been removed — manual
    // flow + idle fallback covers every permutation (vanilla SSH,
    // SSH+postCommand, shellOnly variants) without watching the PTY
    // stream for shell-prompt regexes, eliminating the entire class of
    // "setup blob pasted into running Claude" bugs.

    let passwordSent = false
    let sudoPasswordSent = false
    let setupSent = false
    let setupDone = false
    let setupShellReady = false
    let postCommandSent = false
    let postCommandShellReady = false
    let containerSetupSent = false
    let containerSetupDone = false
    let containerSetupShellReady = false
    let claudeSent = false
    let claudeRunning = false
    // #25: rolling tail of recent PTY output, so the idle-fallback can tell a
    // running-but-marker-less claude from one that exited to a bare shell.
    let recentSshTail = ''
    // #242 finding F1 (b), BLOCKER (adversarial review round 5): per-session
    // nonce, generated ONCE here via randomId() (src/shared/id.ts -- the
    // repo's CSPRNG helper, NOT Math.random) and baked into every setup/
    // stage/push script this flow writes. Every sentinel the parsers below
    // accept must carry it -- SECOND layer only, defeated by an attacker who
    // can also read the tty (and so can copy the nonce verbatim). #242
    // round-3 correction (I3): what survives that stronger attacker is now
    // the SAME for every tier -- ON_PATH_TMUX_BIN_EXPR (tier 1) and
    // STAGED_TMUX_BIN_EXPR (tier 2/3/4), both fixed host-authored literals
    // (ssh-tmux.ts) that never read a wire-reported path at all. A copied
    // nonce buys the attacker nothing beyond forcing CCC to pick between
    // those two fixed tokens -- there is no longer a wire-reported operand
    // for tier 1/2 to substitute (see parseTmuxSentinel's own doc comment).
    // Registered in sshNonceBySession so the (test-only) _getSshNonceForTest
    // accessor and cleanupSessionResources' teardown can both reach it.
    const sshNonce = randomId()
    sshNonceBySession.set(sessionId, sshNonce)
    // item 4: remember this session's connection target so a deliberate End can
    // reach the host over a separate exec. Cleared in cleanupSessionResources.
    sshTargetBySession.set(sessionId, { username: ssh.username, host: ssh.host, port: ssh.port, password: ssh.password })
    // #242 round-3 correction (I3): which entry of buildTmuxLaunchCommand's
    // fixed literal table to use, once a 'setup ok'/stage/push sentinel
    // reports a usable tmux -- never a wire-reported path. `null` means "not
    // found" or "not yet known" -- writeClaudeCmd treats both the same way,
    // writing the bare claudeCmd. `'onpath'` (tier 1, parseTmuxSentinel's
    // `path` class) selects `ON_PATH_TMUX_BIN_EXPR`; `'staged'` (tier 2's
    // `home` class, OR tier 3/4's stage/push `ok`) selects
    // `STAGED_TMUX_BIN_EXPR` -- both are the SAME fixed remote location, so
    // tier 2 and tier 3/4 share one outcome here.
    let detectedTmuxSource: 'onpath' | 'staged' | null = null
    // item 10: the remote account descriptor parsed off the setup-ok sentinel
    // (charset/length-capped, display-only). Emitted to the renderer on latch
    // and re-sent alongside the persistence flag at launch.
    let remoteAccount: string | undefined = undefined
    // #242 tier 3: staging flags. `stagingAttempted` gates a SINGLE staging
    // attempt per session regardless of which setup path (host vs
    // container) reaches it -- host and container setup never both run in
    // the same session (see writeContainerSetupCmd/runPostCommand), so one
    // flag is enough. `stagingSent`/`stagingDone` mirror the setupSent/
    // setupDone idempotency shape used for the other writers.
    let stagingAttempted = false
    let stagingSent = false
    let stagingDone = false
    let stagingTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    // #242 tier 4: arch learned from the probe writeTmuxStageCmd fires
    // alongside the tier-3 staging command (see buildArchProbeCommandBracketed)
    // -- known well before a possible `fail=download` sentinel arrives, since
    // `uname` resolves near-instantly while curl/wget's failure (no egress)
    // typically takes longer. Stays null if the probe's reply never arrives
    // (chunk loss, non-standard remote shell) or reports an arch tier 4
    // doesn't recognise -- either way, attemptTmuxPush never runs and the
    // flow degrades to exactly its pre-tier-4 behaviour (bare launch).
    let detectedArch: TmuxStageTarget | null = null
    // #242 round-3 MINOR fix: `detectedArch === null` cannot distinguish
    // "not yet resolved" from "resolved to an unrecognised arch" -- both
    // leave detectedArch null, so gating re-parses on THAT condition kept
    // re-running the arch-probe regex against every later PTY chunk for the
    // rest of the session, and unrelated later output shaped like the
    // sentinel could set detectedArch long after the probe. This latch
    // flips true the first time `parseArchProbeSentinel` returns anything
    // other than `undefined` (a real match OR an unrecognised-combo `null`),
    // so the onData gate below considers the probe resolved either way.
    let archProbeResolved = false
    // Tier 4 push flags, mirroring stagingSent/stagingDone's idempotency
    // shape. Only ever set when detectedArch is known AND tier 3 reported
    // fail=download specifically -- see the stage-sentinel handler below.
    let pushSent = false
    let pushDone = false
    let pushTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    // #242 finding F1 (adversarial review round 4, BLOCKER): separate timer
    // for the DOWNLOAD phase specifically -- armPushSentinelTimeout (below)
    // is reached only from runChunkedWrite's onDone, i.e. only once every
    // chunk has actually been WRITTEN. Between `pushSent = true` and the
    // archive-resolver's promise settling (a network fetch that can stall
    // indefinitely -- a dead/slow HTTPS response, a hung proxy) there was no
    // timer of any kind: attemptTmuxPush's own doc comment promises tier 4
    // is "never a NEW way for the flow to get stuck with claude never
    // launched", and an unbounded download phase broke exactly that.
    let downloadTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    // #242 finding F3 (adversarial review round 4, MAJOR): flips true at the
    // TOP of flowController.destroy() so any write callback still reachable
    // from a timer destroy() couldn't clear in time (an anonymous setTimeout
    // with no stored handle, or one whose handle a future edit forgets to
    // clear) bails instead of driving ptyProcess.write() into a PTY destroy()
    // just tore down -- the exact invariant destroy() exists to enforce
    // (mirrors setupTimeoutHandle/idleFallbackHandle already being cleared
    // there).
    let destroyed = false
    // Tracks whether we're now in the inner shell (after postCommand
    // completed — e.g. inside the docker container). Drives whether
    // launchClaude() runs the container-setup re-run path or the
    // direct host setup path.
    let inInnerShell = false
    let currentFlowState: SshFlowState = 'connecting'
    let currentFlowInfo: string | undefined = undefined
    const SETUP_TIMEOUT_MS = 10000
    let setupTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    // #242 tier 3: generous vs. SETUP_TIMEOUT_MS -- staging downloads a
    // ~1MB archive over the SSH connection itself before it can even start
    // verifying/installing, so a slow link needs materially more room than
    // the node setup blob (which touches no network). On timeout we treat
    // it exactly like an explicit fail=* sentinel: fall through to the bare
    // launch rather than leaving the flow stuck with claude never written.
    const STAGE_TIMEOUT_MS = 20000
    // #242 tier 4: a full push is a ~1.27 MB base64 transfer driven through
    // runChunkedWrite at WRITE_CHUNK_SIZE(256B)/WRITE_CHUNK_DELAY(12ms) --
    // roughly a minute of byte-chunking ALONE, before accounting for the
    // remote shell actually executing ~650+ individual `echo … >> file`
    // lines (each a fork+exec) as they arrive. Generous on purpose; a
    // push that's still genuinely in flight must never be mistaken for a
    // hung one.
    const PUSH_TIMEOUT_MS = 120000
    // #242 finding F1 (adversarial review round 4, BLOCKER): the DOWNLOAD
    // phase (host-side fetch/cache-lookup of the archive, BEFORE a single
    // chunk is written) had no timeout of its own -- see
    // downloadTimeoutHandle's doc comment above. Sized well under
    // PUSH_TIMEOUT_MS: this only bounds a network fetch/disk read of a
    // few-hundred-KB file (or a cache hit, which is synchronous), nowhere
    // near the ~60s+ the chunked transfer itself is budgeted for.
    const DOWNLOAD_TIMEOUT_MS = 45000

    const setFlowState = (s: SshFlowState, info?: string) => {
      // Follow-up adversarial pass (lifecycle MAJOR): `destroyed` used to gate
      // only the PTY WRITES, not this emit. A flow torn down mid-tier (the
      // download promise, a push abort) still resolved afterwards and emitted
      // onto `ssh:flowState:<sessionId>` -- a channel a RESPAWNED session with
      // the same id is already subscribed to, so the dead flow's
      // 'running-claude'/failure state painted the new session's overlay and
      // could falsely latch "reached claude-running" on it (which then adds
      // --continue with no conversation to continue). A destroyed flow emits
      // nothing: it no longer exists as far as the renderer is concerned.
      if (destroyed) return
      currentFlowState = s
      currentFlowInfo = info
      logInfo(`[ssh] ${sessionId}: flow → ${s}${info ? ` (${info})` : ''}`)
      emitSshFlowState(win, sessionId, s, info)
    }

    // Idle-data fallback. Every onData re-arms a 1.5 s timer; when it
    // fires (no PTY data for 1.5 s), we advance state based on the
    // current sentinel/flag state. This is independent of the
    // shell-prompt regex — bash prompts with non-standard PS1s
    // sometimes never match the regex, and silence after a burst of
    // setup/MOTD output is a robust "shell is idle, ready for next
    // command" signal regardless of styling.
    const IDLE_FALLBACK_MS = 1500
    let idleFallbackHandle: ReturnType<typeof setTimeout> | null = null
    let receivedAnyData = false
    const armIdleFallback = () => {
      // Follow-up adversarial pass (lifecycle MAJOR): destroy() clears this
      // timer, but any data arriving during the PTY's teardown grace window
      // re-armed it immediately afterwards -- resurrecting the whole ladder
      // (up to a 'claude-running' emit) on a session that no longer exists.
      if (destroyed) return
      if (idleFallbackHandle) clearTimeout(idleFallbackHandle)
      idleFallbackHandle = setTimeout(() => {
        idleFallbackHandle = null
        if (!receivedAnyData) return
        logInfo(`[ssh] ${sessionId}: idle timer fired in state=${currentFlowState} info=${currentFlowInfo ?? 'none'} flags={setupSent:${setupSent},setupDone:${setupDone},postCommandSent:${postCommandSent},postCommandShellReady:${postCommandShellReady},containerSetupSent:${containerSetupSent},containerSetupDone:${containerSetupDone},claudeSent:${claudeSent},sudoPassword:${!!sudoPassword},sudoPasswordSent:${sudoPasswordSent}}`)

        // connecting → awaiting-{postcommand|claude} or shell-only.
        if (currentFlowState === 'connecting') {
          // Do not advance over a waiting auth prompt: the pane being quiet is
          // exactly what a password prompt looks like. Stay in connecting and
          // re-arm — the prompt resolving (auto-type or the user typing)
          // produces output that re-enters the ladder normally. BOUNDED: if
          // the sticky line is stale (a host whose real post-login prompt
          // strips to '' never overwrites it), the cap lets the fallback
          // advance on the fire after the cap (~13.5s) instead of
          // wedging the session here forever. Logged once per engagement.
          if (PASSWORD_PROMPT_RE.test(lastPromptLineSeen) && authHoldFires < MAX_AUTH_HOLD_FIRES) {
            authHoldFires++
            if (authHoldFires === 1) {
              logInfo(`[ssh] ${sessionId}: idle ${IDLE_FALLBACK_MS}ms but an auth prompt is waiting — holding in connecting (bounded)`)
            }
            armIdleFallback()
            return
          }
          logInfo(`[ssh] ${sessionId}: idle ${IDLE_FALLBACK_MS}ms → advancing from connecting`)
          if (ssh.postCommand) setFlowState('awaiting-postcommand', 'idle-fallback')
          else if (options?.shellOnly) setFlowState('shell-only', 'idle-fallback')
          else setFlowState('awaiting-claude', 'host (fallback)')
          return
        }

        // running-setup (host) + setupDone → write next stage.
        if (
          currentFlowState === 'running-setup'
          && currentFlowInfo === 'host'
          && setupDone
          && !setupShellReady
        ) {
          setupShellReady = true
          logInfo(`[ssh] ${sessionId}: idle after host setup ok → writing claudeCmd`)
          // Host setup runs only because user clicked Launch Claude (on
          // host). Proceed to claude (via tier-3 staging first if tmux
          // wasn't found) — don't chain to postCommand even if configured.
          // shellOnly is ignored: the click is consent.
          if (!claudeSent) proceedAfterSetup()
          return
        }

        // running-postcommand + we've seen the inner shell idle →
        // advance to awaiting-claude (manual) or container setup (auto).
        // sudoGate dropped: 1.5 s of true idle is sufficient signal
        // that the user is past any sudo prompt (sudo would still be
        // generating output until accepted). Stale keychain creds
        // were also producing false negatives here.
        if (
          currentFlowState === 'running-postcommand'
          && postCommandSent
          && !postCommandShellReady
        ) {
          postCommandShellReady = true
          inInnerShell = true
          logInfo(`[ssh] ${sessionId}: idle after postCommand → inner shell ready`)
          // User decides next via overlay (Launch Claude vs Skip).
          setFlowState('awaiting-claude', 'inner')
          return
        }

        // running-setup (container) + containerSetupDone → write claudeCmd.
        // shellOnly is intentionally not gated here: in manual flow the
        // user clicked Launch Claude (which is what triggered container
        // setup); in auto flow we only reach this branch via
        // writeContainerSetupCmd() which is already shellOnly-gated upstream.
        if (
          currentFlowState === 'running-setup'
          && currentFlowInfo === 'container'
          && containerSetupDone
          && !containerSetupShellReady
          && !claudeSent
        ) {
          containerSetupShellReady = true
          logInfo(`[ssh] ${sessionId}: idle after container setup ok → writing claudeCmd`)
          proceedAfterSetup()
          return
        }

        // running-claude → claude-running (fallback). Lenient
        // box-drawing detection above usually catches Claude's UI
        // rendering, but some output paths (alternate screen buffer
        // with NO_FLICKER, slow terminals, etc.) don't expose those
        // markers in our data stream. Once claudeCmd has been
        // written and the PTY has gone quiet for 1.5 s, Claude is
        // almost certainly running — flip the latch so the overlay
        // can disappear and no more auto-writes ever fire.
        if (currentFlowState === 'running-claude' && claudeSent) {
          // #25: don't FALSE-GREEN. If the pane has dropped back to a bare shell
          // prompt, claude exited (e.g. the first-run trust prompt was declined,
          // or claude crashed) — surface it as failed instead of latching
          // claude-running. Conservative detector: never mis-flags a running
          // claude (whose UI uses ❯/box drawing, not a bare $/#).
          if (looksLikeShellPromptTail(recentSshTail)) {
            logError(`[ssh] ${sessionId}: idle after claudeCmd but pane is a bare shell → claude exited (not latching claude-running)`)
            setFlowState('failed', 'claude exited to shell')
            return
          }
          logInfo(`[ssh] ${sessionId}: idle after claudeCmd → assuming claude-running (fallback)`)
          claudeRunning = true
          setFlowState('claude-running', 'idle-fallback')
          return
        }
      }, IDLE_FALLBACK_MS)
    }
    const remotePath = ssh.remotePath || '~'
    // Clickable question options (CC >= 2.1.195) default OFF in CCC -- the
    // clickable layer misfires inside xterm.js. Read fresh per spawn so the
    // Settings toggle applies to the next session without a restart.
    const spawnCfg = readConfig<{ clickableQuestions?: boolean; disableBackgroundTasks?: boolean; theme?: string; classicTerminalCopyPaste?: boolean }>('settings')
    const clickableQuestions = spawnCfg?.clickableQuestions === true
    // #546: classic terminal copy/paste (default on) must reach the REMOTE Claude
    // too. The local spawn sets CLAUDE_CODE_DISABLE_MOUSE=1 +
    // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 (spawn.ts) so xterm owns the mouse →
    // classic drag-selection + right-click copy/paste. Over SSH the local env
    // never crosses, so these ride the remote launch line as env-prefix tokens
    // just like the sibling *_MOUSE_CLICKS var below. Without them the remote
    // Claude keeps SGR mouse tracking on, xterm forwards drags to Claude, and
    // selection is dead — no parity with a local session.
    const classicTerminalCopyPaste = spawnCfg?.classicTerminalCopyPaste !== false
    // item 3: PROTOTYPE Windows remote. Isolated behind this flag; every branch
    // below falls back to the unchanged POSIX path for auto/unix/undefined.
    const isWindowsRemote = ssh.remoteOs === 'windows'
    // The host's light/dark scheme rides the REMOTE launch line as COLORFGBG
    // (book item 34). The local spawn puts it in the shell's env; over SSH the
    // local env never reaches the remote, so it is a prefix on the command that
    // starts claude -- quoted for POSIX (the value carries a `;`), bare inside
    // the Windows `set "..."` wrapper. The tmux wrap single-quotes the whole
    // inner command and escapes embedded quotes, so it survives that too.
    const sshHostColorScheme = resolveHostColorScheme(spawnCfg?.theme, nativeTheme.shouldUseDarkColors)
    const claudeEnvVars = [
      options?.disableAutoMemory ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' : '',
      // #546: mirror buildClaudeLocalSpawn — classic mode → xterm owns the mouse.
      classicTerminalCopyPaste ? 'CLAUDE_CODE_DISABLE_MOUSE=1' : '',
      classicTerminalCopyPaste ? 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1' : '',
      clickableQuestions ? '' : 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
      spawnCfg?.disableBackgroundTasks !== false ? 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1' : '',
      colorFgBgEnvToken(sshHostColorScheme, isWindowsRemote ? 'windows-cmd' : 'posix'),
    ].filter(Boolean)
    const claudeEnvPrefix = claudeEnvVars.join(' ')
    // Flags common to POSIX + Windows (everything EXCEPT --settings/--mcp-config,
    // which differ by path shape: POSIX adds them inline below; the Windows
    // builder re-adds them with %USERPROFILE% paths). The remote shell differs:
    // POSIX single-quotes the model id (zsh globs `opus[1m]` otherwise, #144),
    // but cmd.exe does NOT strip single quotes, so modelFlag()'s POSIX form gave
    // a Windows launch a model id WITH literal quotes (adversarial review,
    // 2026-08-18). cmd.exe uses DOUBLE quotes (claude.cmd strips them), so the
    // Windows branch double-quotes via a local var -- the `${options.model}`
    // shape the #144 source-scan forbids (correctly, for POSIX) never appears,
    // and this is genuinely a different shell. effort/permissionMode/extraArgs
    // are charset-safe in both shells (extraArgs is IPC-charset-guarded against
    // every cmd + POSIX metachar).
    const winModelId = options?.model ?? ''
    const claudeModelCommonFlag = isWindowsRemote
      ? (winModelId ? `--model "${winModelId}"` : '')
      : modelFlag(options?.model, false)
    const claudeCommonFlags = [
      options?.effortLevel ? `--effort ${options.effortLevel}` : '',
      claudeModelCommonFlag,
      options?.permissionMode && options.permissionMode !== 'default' ? `--permission-mode ${options.permissionMode}` : '',
      options?.extraArgs && options.extraArgs.trim() ? options.extraArgs.trim() : '',
    ].filter(Boolean).join(' ')
    const claudeFlags = [
      // --settings loads per-session config so concurrent sessions to the same
      // host don't clobber each other's statusline sessionId binding.
      `--settings ${claudeProvider.getSshSettingsPath(sessionId)}`,
      // P7.8: --mcp-config carries the conductor MCP entry. Claude CLI ignores
      // mcpServers in --settings files (P7.7.3) so this is the canonical site
      // for the conductor registration on SSH. The URL bakes ?cccSessionId
      // (P7.7.10) so the host's MCP server can resolve the CCC session from
      // the SSE transport without trusting an LLM-supplied arg.
      `--mcp-config ${claudeProvider.getSshMcpConfigPath(sessionId)}`,
      options?.effortLevel ? `--effort ${options.effortLevel}` : '',
      // --model pins the Claude model for this session. Empty string in
      // the config form means "no override" — the CLI picks whatever
      // the user's plan exposes by default. Single-quoted (#144): 1M-context
      // ids contain brackets (`opus[1m]`) which zsh parses as a glob class,
      // aborting the remote command with "no matches found". The remote shell
      // is always POSIX here, so POSIX escaping applies regardless of the
      // local platform (hence isWin32: false).
      modelFlag(options?.model, false),
      // Per-config permission mode. 'default'/'' => no flag (Claude's own default).
      options?.permissionMode && options.permissionMode !== 'default' ? `--permission-mode ${options.permissionMode}` : '',
      // Advanced escape hatch: extra CLI args verbatim (IPC-charset-guarded).
      options?.extraArgs && options.extraArgs.trim() ? options.extraArgs.trim() : '',
    ].filter(Boolean).join(' ')
    const claudeCmd = isWindowsRemote
      // item 3: cmd.exe launch (set X=Y&& claude --settings "%USERPROFILE%\.claude\..."). No
      // tmux wrap ever (Windows has none); writeClaudeCmd appends --continue on reconnect.
      ? buildWindowsClaudeCommand({ sessionId, envPrefixVars: claudeEnvVars, extraFlags: claudeCommonFlags, continueFlag: '' })
      : [claudeEnvPrefix, 'claude', claudeFlags].filter(Boolean).join(' ')
    const password = ssh.password
    const postCommand = ssh.postCommand
    const sudoPassword = ssh.sudoPassword

    // Tight password-prompt match: `password:` or `password?` at the trimmed
    // end of the last line. Previously we matched any chunk containing the
    // word "password", which fires on MOTDs like "Your password expires in
    // 30 days" — the password then gets written into the PTY as stray input
    // before the real prompt arrives, leaking it visibly into the terminal.
    const PASSWORD_PROMPT_RE = /password[:?]\s*$/i
    // Shell prompt match for the cd/setup gate. Real bash PS1s usually end
    // `$`/`#`/`>`/`~` with no whitespace before the sigil (e.g. `user@h:~$ `),
    // so we can't require pre-whitespace — but we DO exclude lines containing
    // Claude Code's `❯` glyph via lastPromptLineForClaude below. setupDone is the
    // hard latch that prevents any retrigger regardless.
    const SHELL_PROMPT_RE = /[$#>~]\s*$/
    // The last prompt-shaped line seen on this PTY, kept for the idle fallback:
    // an ssh auth prompt is EXACTLY a stretch of output silence, and the
    // fallback used to advance `connecting → awaiting-claude` over a waiting
    // password prompt (the "asks to Launch Claude at the password prompt" bug,
    // 2026-08-27 — the prompt itself went undetected because the ConPTY title
    // OSC glued to it defeated the old escape stripping; see ui-detection.ts).
    // Detection is fixed there; this guard is belt-and-braces so the
    // CONNECT-TIME idle path cannot walk past a visible auth prompt (including
    // a manual-entry session with no saved password). The postCommand sudo
    // path keeps its existing idle behavior. The hold is BOUNDED (below): a
    // host whose post-login prompt strips to '' (a ❯-glyph PS1, a 2-char
    // escape lead) would otherwise leave a stale "password:" sticky and wedge
    // the flow in connecting forever.
    let lastPromptLineSeen = ''
    // Consecutive idle-fallback fires spent holding for an auth prompt; reset
    // by every data chunk. At the cap the fallback advances anyway (release is
    // the fire after the cap, (MAX+1) x 1.5s = ~13.5s),
    // so a stale sticky delays a quiet host but can never wedge it.
    let authHoldFires = 0
    const MAX_AUTH_HOLD_FIRES = 8

    /**
     * Writers for the four discrete SSH stages. The manual
     * SshFlowController calls these on user button clicks; the idle
     * fallback calls them when chaining the next stage of an already
     * user-consented sequence. Every writer is idempotent — subsequent
     * calls are no-ops once its `*Sent` flag is set, so an over-eager
     * renderer click or repeated idle fire can't double-fire.
     */
    const writeHostSetupCmd = () => {
      if (setupSent) return
      setupSent = true
      setFlowState('running-setup', 'host')
      logInfo(`[ssh] ${sessionId}: writing host setupCmd`)
      setupTimeoutHandle = setTimeout(() => {
        setupTimeoutHandle = null
        if (!setupDone) {
          logError(`[ssh] ${sessionId}: setup ok not received within ${SETUP_TIMEOUT_MS}ms`)
          setFlowState('failed', 'host setup timeout')
        }
      }, SETUP_TIMEOUT_MS)
      setTimeout(() => {
        // configureRemoteSettings → assertSafeRemotePath throws on a bad path.
        // Catch it HERE: an uncaught throw in a setTimeout is re-thrown by the
        // global handler and crashes main (adversarial review, #188). Fail the
        // flow instead. The IPC schema already rejects bad paths up front; this
        // is defence-in-depth for any path that reaches here.
        try {
          const s = readConfig<{ statusLineEnabled?: boolean; conductorToolsEnabled?: boolean }>('settings')
          const setupOpts = {
            includeStatusLine: s?.statusLineEnabled !== false,
            includeConductorMcp: s?.conductorToolsEnabled !== false,
            remoteMcpPort, // #24: bake the remote MCP URL with the per-session port
          }
          // item 3: Windows uses the PowerShell-delivered setup (no POSIX
          // base64/stty, no tmux); auto/unix keep the POSIX path unchanged.
          const setupCmd = isWindowsRemote
            ? getWindowsRemoteSetupCommand(sessionId, setupOpts, sshNonce)
            : claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig, setupOpts, sshNonce)
          ptyProcess.write(setupCmd + '\r')
        } catch (err) {
          logError(`[ssh] ${sessionId}: host setup failed: ${(err as Error)?.message ?? err}`)
          setFlowState('failed', 'host setup error')
        }
      }, 200)
    }

    const writePostCommand = () => {
      if (postCommandSent || !postCommand) return
      postCommandSent = true
      setFlowState('running-postcommand')
      logInfo(`[ssh] ${sessionId}: writing post-command`)
      setTimeout(() => ptyProcess.write(postCommand + '\r'), 200)
    }

    const writeContainerSetupCmd = () => {
      if (containerSetupSent) return
      containerSetupSent = true
      setFlowState('running-setup', 'container')
      logInfo(`[ssh] ${sessionId}: re-running setup inside container`)
      setupTimeoutHandle = setTimeout(() => {
        setupTimeoutHandle = null
        if (!containerSetupDone) {
          logError(`[ssh] ${sessionId}: container setup ok not received within ${SETUP_TIMEOUT_MS}ms`)
          setFlowState('failed', 'container setup timeout')
        }
      }, SETUP_TIMEOUT_MS)
      setTimeout(() => {
        // See writeHostSetupCmd: a throw here would crash main via the global
        // handler; fail the flow instead (adversarial review, #188).
        try {
          const s = readConfig<{ statusLineEnabled?: boolean; conductorToolsEnabled?: boolean }>('settings')
          const setupOpts = {
            includeStatusLine: s?.statusLineEnabled !== false,
            includeConductorMcp: s?.conductorToolsEnabled !== false,
            remoteMcpPort, // #24: bake the remote MCP URL with the per-session port
          }
          // item 3: Windows uses the PowerShell-delivered setup (no POSIX
          // base64/stty, no tmux); auto/unix keep the POSIX path unchanged.
          const setupCmd = isWindowsRemote
            ? getWindowsRemoteSetupCommand(sessionId, setupOpts, sshNonce)
            : claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig, setupOpts, sshNonce)
          ptyProcess.write(setupCmd + '\r')
        } catch (err) {
          logError(`[ssh] ${sessionId}: container setup failed: ${(err as Error)?.message ?? err}`)
          setFlowState('failed', 'container setup error')
        }
      }, 300)
    }

    // #242 round-2 MINOR fix: `runningClaudeInfo` lets a caller that just
    // resolved a tier-3 staging failure (or timeout) carry that reason
    // forward onto the 'running-claude' state this function emits, instead
    // of it being silently overwritten. Before this fix, the staging
    // sentinel handler called setFlowState('running-setup',
    // `tmux-stage-fail:<reason>`) and then IMMEDIATELY called
    // writeClaudeCmd(), whose own setFlowState('running-claude') fired in
    // the same tick -- both IPC messages went out, but any renderer that
    // paints only the CURRENT state (not a log of every emit) never showed
    // the reason. Passing it through here means the state a listener
    // actually observes carries the info.
    const writeClaudeCmd = (runningClaudeInfo?: string) => {
      // Follow-up adversarial pass (lifecycle MAJOR): bail at the TOP, not just
      // in the deferred write callback below. Reached from a resolving download
      // / push promise after teardown, the old code still ran the whole body --
      // emitting flow state and session-info onto the id's channels and
      // mutating sshTmuxWrappedBySession -- and only the final write was
      // suppressed. Everything this function does is meaningless for a
      // destroyed flow, and harmful once the id has been respawned.
      if (destroyed) return
      // Idempotent. shellOnly is intentionally NOT gated: this writer
      // only runs after the user clicked Launch Claude (or after a
      // user-consented chain reached this stage), so the click is
      // their explicit consent regardless of any saved shellOnly flag.
      if (claudeSent) return
      claudeSent = true
      // #242: wrap in `tmux new-session -A` when detection found a binary
      // on the remote, so a dropped SSH connection survives -- reconnecting
      // and running this exact flow again lands on the SAME command, and
      // `-A` attaches to the still-running claude instead of launching a
      // second one. No wrap when detection found nothing (host has no tmux
      // and no staged fallback) -- the bare claudeCmd is unchanged from
      // pre-#242 behaviour.
      let cmdToWrite = claudeCmd
      let tmuxWrapped = false
      // item 1: even a detected tmux is NOT used when persistence is off.
      if (persistenceEnabled && detectedTmuxSource) {
        // #242 round-3 correction (I3): buildTmuxLaunchCommand no longer
        // takes a tmuxBin at all -- it picks ON_PATH_TMUX_BIN_EXPR /
        // STAGED_TMUX_BIN_EXPR from `staged` alone, so there is no
        // wire-reported operand left for this sink to trust. The try/catch
        // stays as defence-in-depth: writeClaudeCmd is reached from
        // setTimeout callbacks (armIdleFallback, ~line 546/583) AND directly
        // from the onData listener -- an uncaught throw from either is
        // re-thrown by the global uncaughtException handler and crashes main
        // (adversarial review, #188, same shape documented on
        // assertNotOptionLike in ssh-args.ts).
        try {
          cmdToWrite = buildTmuxLaunchCommand({ sessionId, innerCmd: claudeCmd, staged: detectedTmuxSource === 'staged', reconnect: !!ssh.reconnect })
          tmuxWrapped = true
        } catch (err) {
          logError(`[ssh] ${sessionId}: tmux launch command build failed, writing bare claudeCmd instead: ${(err as Error)?.message ?? err}`)
        }
      }
      // #242 tier 5: `--continue` on a reconnect, but ONLY for the bare
      // (non-tmux-wrapped) launch -- see buildSshClaudeFlags's doc comment
      // (ssh-tmux.ts) for why `tmuxWrapped` (the ACTUAL outcome of the wrap
      // attempt above, not merely `detectedTmuxSource`) is the right gate: a
      // build-error in the try/catch above also means no tmux is in play
      // for this write, even though a binary WAS detected.
      const continueFlag = buildSshClaudeFlags({ reconnect: !!ssh.reconnect, tmuxInPlay: tmuxWrapped })
      if (continueFlag) cmdToWrite = `${cmdToWrite} ${continueFlag}`
      // #242 tier 5: resolveRunningClaudeInfo defaults the reason to
      // 'probe=none' when this call carries no explicit one AND the launch
      // ended up unwrapped -- every live tier-3/4 failure path already
      // passes its own reason (stage-fail/push-fail) straight into
      // runningClaudeInfo, but a defence-in-depth default means ANY future
      // call site that reaches here unwrapped with no reason still tells
      // the renderer SOMETHING rather than emitting 'running-claude' with
      // no info at all -- the "failing silently" gap this tier closes.
      // item 7 (resume-outcome messaging): on a reconnect that actually
      // reattached (tmux in play), surface a friendly 'reattach' marker instead
      // of the silent success (undefined) so the overlay can say "reconnecting
      // to your session" rather than "launching Claude". Only when there is no
      // failure reason to show (tmuxWrapped ⇒ runningClaudeInfo is undefined).
      const runInfo = resolveRunningClaudeInfo(runningClaudeInfo, tmuxWrapped)
      setFlowState('running-claude', (ssh.reconnect && tmuxWrapped) ? 'reattach' : runInfo)
      // items 8/9: authoritative persistence signal for THIS session -- whether
      // the launch actually wrapped in tmux. Re-send the account alongside so a
      // renderer that missed the latch push still gets both.
      emitSshSessionInfo(win, sessionId, { tmuxPersistent: tmuxWrapped, remoteAccount })
      // Track locally so close/quit (killPty, gracefulExitPty) DETACH rather
      // than destroy this session's surviving remote -- see the map's doc above.
      if (tmuxWrapped) sshTmuxWrappedBySession.add(sessionId)
      else sshTmuxWrappedBySession.delete(sessionId)
      logInfo(`[ssh] ${sessionId}: writing claudeCmd${tmuxWrapped ? ' (tmux-wrapped)' : ''}${continueFlag ? ' (+continue)' : ''}`)
      setTimeout(() => {
        // #242 finding F3 (adversarial review round 4, MAJOR): this write is
        // reachable from a leaked timer (stagingTimeoutHandle/
        // pushTimeoutHandle/downloadTimeoutHandle -- all now cleared in
        // destroy(), but a future timer added to this ladder could just as
        // easily forget to be) firing AFTER the session was torn down.
        // `destroyed` bails before ever attempting the write; the try/catch
        // is defence-in-depth against any OTHER reason ptyProcess.write()
        // might throw post-teardown (killPty's own write wraps in the same
        // /* best-effort */ shape for exactly this reason).
        if (destroyed) return
        try {
          ptyProcess.write(cmdToWrite + '\r')
          // Follow-up adversarial pass (fail-posture MAJOR): arm the
          // wrapped-launch watchdog only once the wrapped command has actually
          // been written -- see tmuxLaunchWatchUntil's doc comment.
          if (tmuxWrapped) tmuxLaunchWatchUntil = Date.now() + TMUX_LAUNCH_WATCH_MS
        } catch (err) {
          logError(`[ssh] ${sessionId}: writeClaudeCmd's write failed post-schedule: ${(err as Error)?.message ?? err}`)
        }
      }, 200)
    }

    /**
     * Follow-up adversarial pass (fail-posture MAJOR): the umbrella fallback for
     * a tmux-wrapped launch that the remote refuses.
     *
     * The stage/push scripts smoke-test the binary they install with `tmux -V`
     * and `tmux new-session -d`, and their doc comments claim that surfaces the
     * "missing or unsuitable terminal" (terminfo) failure. It does not: a
     * DETACHED new-session never opens a client tty, so terminfo is never
     * consulted, and the pinned static build ships without compiled-in fallback
     * entries. On a remote with no terminfo database for $TERM -- the minimal
     * container that is exactly this tier's target -- staging reports `ok`, the
     * ATTACHED launch then dies with `open terminal failed`, and tier 2 selects
     * the same binary on every later connect. Nothing recovered: claude never
     * started, and Launch Claude is inert once `claudeSent` latched.
     *
     * Rather than teach the smoke test to predict every way a remote can refuse
     * to run tmux (terminfo, an already-nested session, a wrong-arch or
     * truncated binary, a tmux too old for `new-session -A`), watch the PTY for
     * a short window after the wrapped launch and fall back to the BARE launch
     * the moment the remote says it failed. That is safe precisely because a
     * failed wrap means nothing is running: the pane is back at a shell prompt.
     *
     * The window is deliberately short and closes the instant claude latches, so
     * this can never fire against claude's own output; every pattern below is a
     * message a shell or tmux emits about the command we just typed.
     */
    const TMUX_LAUNCH_WATCH_MS = 6000
    /** Deadline (epoch ms) until which the wrapped launch is being watched; 0 = not watching. */
    let tmuxLaunchWatchUntil = 0
    let tmuxLaunchFellBack = false
    /**
     * Round-2 adversarial pass (MAJOR): the first cut of this regex matched
     * bare `command not found` / `permission denied` / `is a directory`
     * anywhere in the chunk, which fires on output that has nothing to do with
     * the wrap -- claude's own `EACCES: permission denied` startup stderr, and
     * (worse) the transcript redraw when a RECONNECT successfully attaches to a
     * live session, since a coding transcript routinely contains those exact
     * words. The cost of a false positive is not cosmetic: the bare claude line
     * is typed into a pane where claude is already running (so it lands in the
     * composer as a chat message) and the session is dropped from
     * sshTmuxWrappedBySession, which turns a later close into a KILL of the
     * remote rather than a detach.
     *
     * Split in two, so a generic error only counts when it is demonstrably
     * about tmux:
     *  - UNAMBIGUOUS: phrases only tmux itself emits; match anywhere.
     *  - GENERIC: shell/exec failures that must share a LINE with the word
     *    `tmux` (every wrapped launch names the binary, so a real failure to
     *    run it always does).
     * `no server running on` was dropped entirely: buildTmuxLaunchCommand's own
     * `|| <fresh create>` leg already self-heals that race, and reacting to it
     * here fought the wrapper for the same case.
     */
    const TMUX_LAUNCH_FAILED_UNAMBIGUOUS_RE = /open terminal failed|sessions should be nested|missing or unsuitable terminal/i
    const TMUX_LAUNCH_FAILED_GENERIC_RE = /^[^\r\n]*\btmux\b[^\r\n]*(command not found|not found|permission denied|exec format error|cannot execute binary file|is a directory)/im
    const handleWrappedLaunchFailure = (data: string): void => {
      if (destroyed || tmuxLaunchFellBack || !tmuxLaunchWatchUntil) return
      if (Date.now() > tmuxLaunchWatchUntil) { tmuxLaunchWatchUntil = 0; return }
      if (claudeRunning) { tmuxLaunchWatchUntil = 0; return }
      // Round-2 adversarial pass (MAJOR): claude's UI appearing in THIS chunk is
      // proof the wrap worked, and it is checked BEFORE the failure match --
      // the claudeRunning latch below runs later in the same handler, so on a
      // reattach the transcript's own text used to be judged before the UI that
      // accompanied it. Any chunk carrying claude's UI closes the window for
      // good.
      if (detectClaudeUi(data, claudeSent)) { tmuxLaunchWatchUntil = 0; return }
      const m = data.match(TMUX_LAUNCH_FAILED_UNAMBIGUOUS_RE) ?? data.match(TMUX_LAUNCH_FAILED_GENERIC_RE)
      if (!m) return
      tmuxLaunchFellBack = true
      tmuxLaunchWatchUntil = 0
      logError(`[ssh] ${sessionId}: tmux-wrapped launch was refused by the remote (${m[0]}) -- falling back to a bare claude launch`)
      // The wrap is off for this session: correct the persistence signal the
      // wrapped write already emitted, and stop close/quit from trying to
      // DETACH from a tmux session that was never created.
      sshTmuxWrappedBySession.delete(sessionId)
      emitSshSessionInfo(win, sessionId, { tmuxPersistent: false, remoteAccount })
      // Reconnecting with no tmux in play is exactly the case tier 5 exists
      // for, so the bare retry carries --continue when this spawn is a respawn.
      const bareFlags = buildSshClaudeFlags({ reconnect: !!ssh.reconnect, tmuxInPlay: false })
      const bareCmd = bareFlags ? `${claudeCmd} ${bareFlags}` : claudeCmd
      setFlowState('running-claude', 'tmux-launch-refused')
      try {
        ptyProcess.write(bareCmd + '\r')
      } catch (err) {
        logError(`[ssh] ${sessionId}: bare-launch fallback write failed: ${(err as Error)?.message ?? err}`)
      }
    }

    /**
     * #242 tier 3: write the curl/wget staging fragment. Reached only when
     * tier 1/2 (PATH, ~/.claude/bin) both missed -- see proceedAfterSetup.
     * Idempotent like the other writers; the timeout is the fallback path
     * for a sentinel that never arrives (dead download, a `sh` that
     * doesn't support a construct we assumed, etc.) -- either way we must
     * still reach writeClaudeCmd so the session isn't left stuck forever.
     */
    const writeTmuxStageCmd = () => {
      if (stagingSent) return
      stagingSent = true
      stagingAttempted = true
      setFlowState('running-setup', 'tmux-stage')
      logInfo(`[ssh] ${sessionId}: tmux not found on remote -- staging via curl/wget (#242 tier 3)`)
      stagingTimeoutHandle = setTimeout(() => {
        stagingTimeoutHandle = null
        if (!stagingDone) {
          stagingDone = true
          logError(`[ssh] ${sessionId}: tmux stage sentinel not received within ${STAGE_TIMEOUT_MS}ms -- falling through to bare launch`)
          writeClaudeCmd('tmux-stage-fail:timeout')
        }
      }, STAGE_TIMEOUT_MS)
      setTimeout(() => {
        // #242 finding F3 (adversarial review round 4, MAJOR): bail before
        // ever touching ptyProcess if the session was torn down while this
        // was scheduled -- same reasoning as writeClaudeCmd's write-callback
        // above.
        if (destroyed) return
        // #242 M5 correction (adversarial review round 5): buildTmuxStageCommand
        // is pure, but it is NOT argument-free and it CAN throw -- it takes
        // `sshNonce` and calls assertSafeTmuxStageConstants (ssh-tmux-stage.ts),
        // which validates the nonce's charset among other module constants.
        // In production that nonce is always a valid randomId() (guaranteed
        // by construction, so this throw is not expected to fire), but the
        // guard against a future call site passing something else is exactly
        // why the try/catch below exists -- same shape every other PTY writer
        // in this function uses (adversarial review, #188 shape).
        try {
          // #242 tier 4: fire the arch probe ALONGSIDE staging, not only
          // after a fail=download sentinel arrives. `uname` resolves near-
          // instantly; curl/wget's failure on an egress-less host typically
          // takes longer (DNS timeout, connect timeout) -- sending the probe
          // now means detectedArch is very likely already known by the time
          // (if ever) tier 3 reports fail=download, with zero added latency
          // on the critical path (a separate write, not a blocking round
          // trip). A probe write failing to build/send is swallowed exactly
          // like a stage write failure would be -- it only ever degrades
          // tier 4 to "arch unknown, don't attempt the push", never blocks
          // tier 3 itself.
          try {
            // #242 round-3 MINOR fix: bracketed in stty -echo/stty echo, the
            // same treatment buildTmuxStageCommand's payload gets, so the
            // probe command and its plaintext reply are not the one thing on
            // this ladder still visible in the user's pane. See
            // buildArchProbeCommandBracketed's doc comment for why it's
            // bracketed rather than base64-wrapped like the stage command.
            ptyProcess.write(buildArchProbeCommandBracketed() + '\r')
          } catch (err) {
            logError(`[ssh] ${sessionId}: tmux arch probe failed to send (tier 4 disabled for this session): ${(err as Error)?.message ?? err}`)
          }
          ptyProcess.write(buildTmuxStageCommand(sshNonce) + '\r')
        } catch (err) {
          logError(`[ssh] ${sessionId}: tmux stage command build failed, falling through to bare launch: ${(err as Error)?.message ?? err}`)
          stagingDone = true
          if (stagingTimeoutHandle) {
            clearTimeout(stagingTimeoutHandle)
            stagingTimeoutHandle = null
          }
          writeClaudeCmd('tmux-stage-fail:build-error')
        }
      }, 200)
    }

    /**
     * #242 tier 4: push a pre-downloaded/cached, sha256-verified tmux
     * archive down the live PTY as base64, for a remote tier 3 could not
     * reach because it has NO outbound egress at all. Reached ONLY from the
     * tier-3 stage-sentinel handler below, and only when `arch` is known
     * (see the arch probe fired alongside writeTmuxStageCmd above) -- never
     * from a code path that could fire without it. Idempotent (`pushSent`)
     * like every other writer in this flow.
     *
     * On ANY failure to obtain bytes (no cache, download failed, digest
     * mismatch) or to build/drive the push command, falls through to
     * writeClaudeCmd exactly like a tier-3 failure would -- tier 4 is a
     * best-effort extra rung on the ladder, never a NEW way for the flow to
     * get stuck with claude never launched.
     */
    const attemptTmuxPush = (arch: TmuxStageTarget) => {
      if (pushSent) return
      pushSent = true
      // #242 finding F1 (adversarial review round 4, BLOCKER): arm the
      // download-phase timeout IMMEDIATELY -- before the host-side resolver
      // (cache lookup or network fetch) has even started -- so a resolver
      // that never settles (a stalled HTTPS response) cannot leave this
      // session wedged forever with claude never launched. Cleared in the
      // resolver's `.then()`/`.catch()` below BEFORE the `pushDone` guard
      // runs, so a buffer that arrives after the timeout already fired is
      // still correctly discarded rather than acted on twice.
      downloadTimeoutHandle = setTimeout(() => {
        downloadTimeoutHandle = null
        if (pushDone) return
        pushDone = true
        logError(`[ssh] ${sessionId}: tmux archive download/cache lookup did not settle within ${DOWNLOAD_TIMEOUT_MS}ms -- falling through to bare launch`)
        writeClaudeCmd('tmux-push-fail:download-timeout')
      }, DOWNLOAD_TIMEOUT_MS)
      setFlowState('running-setup', 'tmux-push')
      logInfo(`[ssh] ${sessionId}: tmux download failed on remote (no egress) -- pushing cached/downloaded archive down the PTY (#242 tier 4, arch=${arch})`)
      // #242 round-2 MAJOR fix: PUSH_TIMEOUT_MS used to be armed HERE, before
      // even the host-side download/cache lookup ran -- so a slow (first-run,
      // possibly-proxied) download ate the SAME 120s budget as the ~60s+
      // chunked transfer that follows it, and nothing stopped a still-running
      // runChunkedWrite when the timer fired anyway: writeClaudeCmd wrote
      // `claude ...\r` into the PTY while base64 chunk lines were still being
      // written, interleaving the launch command into the middle of the
      // payload. Fixed two ways, belt-and-braces:
      //   1. The timer is armed ONLY once every chunk has actually been
      //      written (see the `onDone` hook below) -- from then on the only
      //      thing left to wait for is the remote decoding/verifying/
      //      installing and echoing its sentinel, which is what
      //      PUSH_TIMEOUT_MS is actually sized for.
      //   2. `isAlive` folds in `!pushDone`, so ANY path that sets pushDone
      //      (this timer, a download failure, a build error) makes the NEXT
      //      liveness check inside runChunkedWrite bail before its next
      //      write.
      // #242 round-3 MAJOR fix: (2) above only ever protected THIS function's
      // OWN write loop -- it said nothing about a Launch-Claude click landing
      // on `proceedAfterSetup`/`flowController.launchClaude` from OUTSIDE
      // this function while pushSent is true and pushDone is still false
      // (the entire multi-second-to-multi-minute window this transfer is
      // open). That path bypassed runChunkedWrite's isAlive check entirely --
      // it called writeClaudeCmd() directly, mid-transfer. Both call sites
      // now carry their own `if (pushSent && !pushDone) return` guard (same
      // shape as their pre-existing stagingSent/stagingDone guard), which is
      // what actually makes "there is no longer a window where writeClaudeCmd
      // can fire while a chunk write is still in flight" true.
      const armPushSentinelTimeout = () => {
        if (pushDone) return
        pushTimeoutHandle = setTimeout(() => {
          pushTimeoutHandle = null
          if (!pushDone) {
            pushDone = true
            logError(`[ssh] ${sessionId}: tmux push sentinel not received within ${PUSH_TIMEOUT_MS}ms -- falling through to bare launch`)
            writeClaudeCmd('tmux-push-fail:timeout')
          }
        }, PUSH_TIMEOUT_MS)
      }
      // #242 round-3 MAJOR fix (test coverage): calls the injectable
      // `tmuxArchiveResolver` seam rather than `getOrDownloadTmuxArchive`
      // directly, so tests can drive a full push without touching disk or
      // the network (see `_setTmuxArchiveResolverForTest`). Identical in
      // production -- the seam defaults to the real function.
      tmuxArchiveResolver(arch).then((buf) => {
        // #242 finding F1: clear the download-phase timeout BEFORE the
        // pushDone guard below runs -- a resolver that settles just as (or
        // just after) the timeout fires must not leave a stray timer
        // running; the guard immediately after still discards a buffer
        // that arrives too late to matter.
        if (downloadTimeoutHandle) {
          clearTimeout(downloadTimeoutHandle)
          downloadTimeoutHandle = null
        }
        // Timeout (or some other path) may have already resolved this
        // attempt by the time the download/cache lookup settles -- never
        // act twice.
        if (pushDone) return
        if (!buf) {
          pushDone = true
          logError(`[ssh] ${sessionId}: no cached/downloadable tmux archive for arch=${arch} -- falling through to bare launch`)
          writeClaudeCmd('tmux-stage-fail:download')
          return
        }
        try {
          const pushCmd = buildTmuxPushCommand({ arch, tarGzBase64: buf.toString('base64'), nonce: sshNonce })
          const totalLen = pushCmd.length
          // #242 round-3 MINOR fix: runChunkedWrite's onDone alone can't
          // tell "all bytes landed" apart from "bailed mid-transfer" (a
          // respawn replaced the PTY, or a write threw) -- tracking the last
          // onProgress byte count here is how attemptTmuxPush tells them
          // apart below, so an ABORTED transfer can be recovered from
          // (restore echo, drop the partial payload file) instead of being
          // treated identically to a clean finish.
          let bytesLanded = 0
          // #242 round-2 MAJOR fix: onProgress fires once per chunk (~4961
          // times for a ~1.27 MB payload at WRITE_CHUNK_SIZE=256B) -- forwarding
          // every call straight to setFlowState/emitSshFlowState would be
          // ~5000 log lines + ~5000 IPC sends for one push, and that work runs
          // inside the SAME 12ms per-chunk timer loop the fixed-budget
          // timeout above is racing. Throttle to one emit per INTEGER percent
          // change (~100 emits total) -- runChunkedWrite's own per-chunk
          // contract (pty-chunked-write.test.ts) is untouched; only this
          // call site's use of it is throttled.
          let lastPct = -1
          runChunkedWrite(pushCmd, {
            write: (slice) => ptyProcess.write(slice),
            // Same identity-guarded liveness check writeChunked/writeEnvelopeChunked
            // use -- a respawn replaces ptyProcess under the same sessionId --
            // PLUS `!pushDone`, so the sentinel timer (armed below, once
            // every byte has landed) or any other path that resolves this
            // attempt can stop an in-flight write; see this function's own
            // doc comment above for the interleaving hazard this closes.
            // #242 M3 (adversarial review round 5): also gate on `!destroyed`
            // -- the ptySessions identity check alone is keyed on caller
            // discipline (killPty deletes the map entry in the SAME
            // synchronous frame it kills the pty), not on an invariant. A
            // direct `getSshFlow(id).destroy()` (bypassing killPty) flips
            // `destroyed` without ever touching the ptySessions map entry,
            // so the identity check alone would still report "alive" and let
            // this write land on a flow that has explicitly torn itself down.
            isAlive: () => ptySessions.get(sessionId)?.ptyProcess === ptyProcess && !pushDone && !destroyed,
            onProgress: (sent, total) => {
              bytesLanded = sent
              const pct = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 100
              if (pct === lastPct) return
              lastPct = pct
              setFlowState('running-setup', `staging tmux ${pct}%`)
            },
            onDone: () => {
              if (pushDone) return
              // #242 round-3 MINOR fix: runChunkedWrite's contract guarantees
              // the LAST onProgress call reports `sent === data.length`
              // exactly on a full, successful write -- anything less means
              // this attempt bailed before finishing (isAlive went false, or
              // a write threw). An aborted transfer must not be treated like
              // a clean finish-then-wait-for-sentinel: the remote is still
              // sitting at `stty -echo` with up to ~1.27 MB of partial
              // base64 in $PUSH_ACCUMULATOR_PATH, and arming
              // PUSH_TIMEOUT_MS on top of that would, 120s later, write the
              // claude launch command into a no-echo shell with a dangling
              // temp file still on disk.
              const completed = bytesLanded === totalLen
              // #242 M3: same `!destroyed` addition as isAlive above -- a
              // flow torn down via a direct destroy() call (not killPty)
              // must not have its recovery/sentinel-arming writes land here
              // either.
              const stillLive = ptySessions.get(sessionId)?.ptyProcess === ptyProcess && !destroyed
              if (!completed) {
                if (stillLive) {
                  try {
                    // #242 finding F2 (adversarial review round 4, MAJOR):
                    // the last bytes actually delivered are an arbitrary
                    // mid-line slice of an `echo '<base64...` chunk write --
                    // the OPENING single quote landed, its CLOSING quote did
                    // not, so the remote's line discipline is sitting inside
                    // a still-open string. Writing the recovery text straight
                    // after that (the pre-fix shape) becomes literal content
                    // inside that open quote, and so does writeClaudeCmd's
                    // `claude ...\r` a moment later -- the session hangs at a
                    // '>' continuation prompt with echo still off instead of
                    // falling through to the bare launch. Send an interrupt
                    // as its OWN write FIRST: a Ctrl-C makes the remote
                    // shell's line discipline discard the dangling partial
                    // line (the same mechanism as pressing Ctrl-C to abandon
                    // a half-typed command at an interactive prompt) before
                    // the recovery command is ever typed, so it lands as
                    // real, executable shell text.
                    ptyProcess.write('\x03')
                    // Restore echo and drop the partial accumulator file --
                    // best-effort; this recovery write failing is no worse
                    // than the abort itself, so it falls through to the bare
                    // launch regardless.
                    ptyProcess.write(`stty echo 2>/dev/null; rm -f "$${PUSH_ACCUMULATOR_VAR}"\r`)
                  } catch { /* best-effort recovery; falling through regardless */ }
                }
                pushDone = true
                logError(`[ssh] ${sessionId}: tmux push aborted mid-transfer (${bytesLanded}/${totalLen} bytes) -- falling through to bare launch`)
                writeClaudeCmd('tmux-push-fail:aborted')
                return
              }
              // Full, clean finish. Only start waiting for the remote's
              // completion sentinel if this attempt is still open AND the
              // PTY we just finished writing to is still the live one -- a
              // session that died mid-transfer already has nothing further
              // to wait for, and arming a timer that can only ever write
              // into a stale/replaced PTY would be a new hazard of exactly
              // the kind this fix closes.
              if (stillLive) {
                armPushSentinelTimeout()
              }
            },
          })
        } catch (err) {
          pushDone = true
          logError(`[ssh] ${sessionId}: tmux push command build failed, falling through to bare launch: ${(err as Error)?.message ?? err}`)
          writeClaudeCmd('tmux-push-fail:build-error')
        }
      }).catch((err) => {
        // #242 finding F4 (adversarial review round 4, MINOR; correction in
        // round 5, M4): the production resolver (getOrDownloadTmuxArchive) is
        // fully try/catch'd and can never reject, but `tmuxArchiveResolver`
        // is an injectable test seam (_setTmuxArchiveResolverForTest) -- a
        // rejecting resolver here would otherwise be an UNHANDLED REJECTION.
        // debug-logger.ts's `process.on('unhandledRejection')` handler only
        // LOGS it and returns -- it does NOT re-throw and cannot kill main;
        // that re-throw behaviour belongs to the SEPARATE
        // `process.on('uncaughtException')` handler, which only fires on a
        // synchronous throw, never on a rejected promise (an earlier version
        // of this comment conflated the two). This `.catch()` is still worth
        // having even though nothing here would crash main: without it, a
        // rejecting resolver leaves this session silently wedged until
        // DOWNLOAD_TIMEOUT_MS (45s) fires instead of falling through in the
        // same tick.
        if (downloadTimeoutHandle) {
          clearTimeout(downloadTimeoutHandle)
          downloadTimeoutHandle = null
        }
        if (pushDone) return
        pushDone = true
        logError(`[ssh] ${sessionId}: tmux archive resolver rejected, falling through to bare launch: ${(err as Error)?.message ?? err}`)
        writeClaudeCmd('tmux-push-fail:download-error')
      })
    }

    /**
     * Single choke point every setup-completion path (host AND container,
     * idle-fallback AND prompt-detection, AND a Launch-Claude re-click that
     * lands on already-completed setup -- see launchClaude's `setupDone`
     * branch, wired through here in the #242 round-2 fix) now calls instead
     * of writeClaudeCmd directly. If tier 1/2 already found a tmux binary
     * (detectedTmuxSource set), or staging already ran once this session,
     * proceed straight to the claude launch exactly as before #242 tier 3
     * existed. Otherwise this is the FIRST time we've learned tmux is
     * missing -- try staging it before giving up and launching bare.
     */
    const proceedAfterSetup = () => {
      if (claudeSent) return
      // #242 round-3 MINOR fix: the choke point itself had no
      // staging-in-flight guard -- launchClaude() got one (`if (stagingSent
      // && !stagingDone) return`) because a second click is an obvious
      // re-entry path, but proceedAfterSetup is ALSO reached from four other
      // call sites (idle-fallback after host/container setup, and the
      // prompt-detection branches further down in onData), each latched only
      // by its own `setupShellReady`/`containerSetupShellReady` flag -- not
      // by staging state. Those flags prevent that SPECIFIC site from firing
      // twice, but nothing stopped a DIFFERENT site (e.g. the container path)
      // from reaching this function while the host path's staging attempt is
      // still mid-curl, and falling straight through to writeClaudeCmd()
      // below. Mirroring launchClaude's guard here means the invariant does
      // not depend on "host and container setup never both run in one
      // session" holding forever -- it holds even if that assumption breaks.
      if (stagingSent && !stagingDone) return
      // #242 round-3 MAJOR fix: same shape, for the tier-4 push. A tier-4
      // push can be in flight for up to ~PUSH_TIMEOUT_MS (120s, plus however
      // long the ~1.27 MB chunked transfer itself takes) while claudeSent is
      // still false -- reaching proceedAfterSetup during that window (e.g.
      // via the idle-fallback branches, which are NOT latched by push
      // state) fell straight through to writeClaudeCmd() below, writing
      // `claude ...\r` into the PTY while base64 chunk lines were still
      // arriving and corrupting the in-flight transfer. Only the push's own
      // sentinel/timeout/build-error handler (not this choke point) may
      // call writeClaudeCmd from here on while a push is open.
      if (pushSent && !pushDone) return
      // item 1: skip tier-3/4 staging entirely when persistence is off -- this
      // is the "no silent tmux install" guarantee; go straight to bare claude.
      // item 3: also skip on a Windows remote -- the POSIX staging ladder
      // (`stty`/`uname`/`base64 -d | sh`) is meaningless on cmd.exe and, since
      // the Windows setup deliberately reports tmux=none, this gate would fire
      // and type ~3 KB of POSIX shell into cmd.exe + stall 20s + show a false
      // "Installing tmux…" overlay. Windows never persists via tmux; go straight
      // to the bare cmd.exe launch (adversarial review, 2026-08-18).
      if (persistenceEnabled && !isWindowsRemote && !detectedTmuxSource && !stagingAttempted) {
        writeTmuxStageCmd()
        return
      }
      writeClaudeCmd()
    }

    /**
     * Manual-flow controller. Renderer triggers stage transitions via
     * IPC; main calls these to advance.
     */
    const flowController: SshFlowController = {
      getState: () => ({ state: currentFlowState, info: currentFlowInfo }),
      runPostCommand: () => {
        // postCommand flows (e.g. asustor `sudo docker exec -it ctr bash`)
        // SKIP host setup entirely. Reasoning:
        //   - claude runs inside the container, not the host. The
        //     ~/.claude/settings file claude reads is the one inside
        //     the container, written by the container-setup step.
        //   - NAS hosts (Asustor, Synology, etc.) often don't have
        //     `node` installed on the bare host. Setup blob silently
        //     fails (2>/dev/null), no `setup ok` arrives, the 10 s
        //     timeout fires and the flow goes 'failed' — even though
        //     the user only wanted to enter the container.
        // Users who want claude on the bare HOST can use "Launch
        // Claude on host" instead, which DOES run host setup.
        if (currentFlowState !== 'awaiting-postcommand') return
        writePostCommand()
      },
      launchClaude: () => {
        // #242 round-2 MAJOR fix: tier-3 staging can be in flight for up to
        // STAGE_TIMEOUT_MS (20s) while claudeSent is still false, a window
        // that didn't exist pre-#242 (claudeSent used to flip true in the
        // same tick setup completed). A second Launch-Claude click in that
        // window used to write a fresh claude command into a PTY that's
        // mid-curl. No-op until the in-flight attempt's own sentinel/timeout
        // handler resolves it -- that handler (not a re-click) is the only
        // thing allowed to call writeClaudeCmd from here on.
        if (stagingSent && !stagingDone) return
        // #242 round-3 MAJOR fix: same shape, for the tier-4 push. Without
        // this, a Launch-Claude click during the ~60-120s tier-4 base64
        // transfer falls through (inInnerShell false, setupSent true,
        // setupDone true) straight into the setupDone branch below ->
        // proceedAfterSetup() -- which the fix just above this one also now
        // guards, but a defence-in-depth guard at BOTH call sites means the
        // invariant doesn't depend on proceedAfterSetup being the only path
        // that can reach writeClaudeCmd while a push is open.
        if (pushSent && !pushDone) return
        // Two paths depending on whether we already entered the inner
        // shell. Inner shell → container setup + claudeCmd. Host shell
        // (no postCommand or user skipped it) → host setup + claudeCmd.
        // shellOnly is intentionally ignored: the user just clicked
        // Launch Claude — that IS their consent, overriding any saved
        // shellOnly preference on the config.
        if (inInnerShell) {
          writeContainerSetupCmd()
        } else if (!setupSent) {
          writeHostSetupCmd()
        } else if (setupDone) {
          // Setup already done from a prior runPostCommand → claude now.
          // #242 round-2 MAJOR fix: routed through proceedAfterSetup, not
          // writeClaudeCmd directly -- pre-#242 this branch was effectively
          // inert (claudeSent flipped true in the same tick setup
          // completed), so it never got exercised by tier-3 staging. Left
          // as a direct writeClaudeCmd() call, this path skipped staging
          // entirely even when tier 1/2 had reported tmux=none.
          proceedAfterSetup()
        }
      },
      skip: () => {
        setFlowState('skipped')
      },
      handlePtyExit: () => {
        // Only a connection failure BEFORE a good terminal state matters here.
        // A mid-session drop (already claude-running) is left to the user's
        // Restart; a deliberate close destroys the flow first, so this never
        // runs for it (sshFlows no longer has the session by onExit time).
        if (
          currentFlowState === 'claude-running'
          || currentFlowState === 'shell-only'
          || currentFlowState === 'skipped'
          || currentFlowState === 'failed'
        ) return
        setFlowState('failed', 'connection')
      },
      destroy: () => {
        // #242 finding F3 (adversarial review round 4, MAJOR): flip this
        // FIRST -- writeClaudeCmd's/writeTmuxStageCmd's write-callbacks
        // check this flag before ever touching ptyProcess, so they bail
        // even in the window between this call starting and the
        // clearTimeout calls below actually running.
        destroyed = true
        if (setupTimeoutHandle) {
          clearTimeout(setupTimeoutHandle)
          setupTimeoutHandle = null
        }
        if (idleFallbackHandle) {
          clearTimeout(idleFallbackHandle)
          idleFallbackHandle = null
        }
        // #242 finding F3 (adversarial review round 4, MAJOR): stagingTimeoutHandle
        // was the one timer on this ladder NOT cleared here -- it outlives
        // session teardown and, unguarded, drives a full claude-launch write
        // into the PTY destroy() just tore down (proved: "WRITES AFTER
        // DESTROY" logged from exactly this timer in the reviewer's probe).
        // pushTimeoutHandle and downloadTimeoutHandle have the identical
        // shape (armed, never cleared on teardown), so all three are
        // cleared together here, next to the two timers that already were.
        if (stagingTimeoutHandle) {
          clearTimeout(stagingTimeoutHandle)
          stagingTimeoutHandle = null
        }
        if (pushTimeoutHandle) {
          clearTimeout(pushTimeoutHandle)
          pushTimeoutHandle = null
        }
        if (downloadTimeoutHandle) {
          clearTimeout(downloadTimeoutHandle)
          downloadTimeoutHandle = null
        }
        sshFlows.delete(sessionId)
      },
    }
    sshFlows.set(sessionId, flowController)

    ptyProcess.onData((rawData) => {
      if (win.isDestroyed()) return
      // Strip SSH statusline OSC sentinels before forwarding to xterm.
      // Parsed sentinels are dispatched to the statusline pipeline as a side effect.
      const data = extractSshOscSentinels(sessionId, rawData)
      getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
      win.webContents.send(`pty:data:${sessionId}`, data)

      // Follow-up adversarial pass (lifecycle MAJOR): once the flow is
      // destroyed, terminal bytes still belong on the renderer's data channel
      // (above) but NOTHING below this line does -- every latch, sentinel
      // parse, settings-patch write and claude launch beneath is flow logic for
      // a session that has been torn down. Proven reachable: destroying
      // mid-tier-3 and then feeding the stage sentinel drove a
      // buildTmuxBinPatchCommand write into the dead PTY and re-armed the idle
      // fallback. The individual `destroyed` guards on setFlowState /
      // writeClaudeCmd / armIdleFallback stay as defence in depth for the
      // promise-driven call sites that never pass through here.
      if (destroyed) return

      // Follow-up adversarial pass (fail-posture MAJOR): watch a tmux-wrapped
      // launch for a remote refusal and fall back to the bare launch. No-op
      // unless a wrapped command was just written -- see its doc comment.
      handleWrappedLaunchFailure(data)

      // Arm the idle-data fallback. Re-arms on every chunk so the timer
      // tracks the most recent activity. The handler itself decides
      // whether to advance state — many of our transitions are gated on
      // sentinel flags (setupDone, containerSetupDone, etc.) that only
      // become true after specific output. We re-arm here for all
      // states except claude-running (handled by the backstop below)
      // since once Claude is running we never want auto-writes again.
      if (data.length > 0 && !claudeRunning) {
        receivedAnyData = true
        recentSshTail = (recentSshTail + data).slice(-800) // #25: for claude-exit detection in the fallback
        // Fresh output resets the auth-hold budget: the hold cap only counts
        // CONSECUTIVE quiet fallback fires, so a genuinely waiting prompt that
        // repaints keeps its full hold window.
        authHoldFires = 0
        armIdleFallback()
      }

      // HARD LATCH: detect Claude Code UI. Two regexes, gated on phase:
      //
      //   STRICT (any phase): long box-drawing rules `╭─{5,}` or
      //   `╰─{5,}`. Required to be conservative before claudeSent so
      //   a fancy bash prompt (Powerlevel10k uses `╭─` with 1-2
      //   dashes) doesn't latch us early and block setup.
      //
      //   LENIENT (claudeSent only): single-dash `╭─` / `╰─` / any
      //   `❯` / vertical `┃│`. Safe at this stage — we've already
      //   written claudeCmd, so any box drawing is almost certainly
      //   Claude rendering its UI rather than the original bash
      //   prompt (which would have already triggered state advance
      //   earlier).
      if (!claudeRunning) {
        if (detectClaudeUi(data, claudeSent)) {
          claudeRunning = true
          if (setupTimeoutHandle) {
            clearTimeout(setupTimeoutHandle)
            setupTimeoutHandle = null
          }
          logInfo(`[ssh] ${sessionId}: Claude UI detected — claudeRunning latched`)
          if (currentFlowState !== 'claude-running') setFlowState('claude-running')
        }
      }

      // Step 1 completion sentinel: the remote node script writes
      // `setup ok <nonce> tmux=<class>\n` to stdout right before exiting.
      //
      // #242 findings I1+I2 correction: the completion latch used to be a
      // bare `data.includes('setup ok')` substring check against the
      // CURRENT chunk only -- two independent bugs shared that one line.
      // I2: a write-only attacker (no read access to the tty, so no way to
      // learn this session's nonce) could feed the literal text "setup ok"
      // and latch completion early with no usable tmux ever recorded,
      // silently losing persistence AND forcing an unwanted tier-3 staging
      // attempt (network fetch + a write into ~/.claude/bin) on a host that
      // already had tmux. I1: even for a GENUINE sentinel, a real SSH link
      // routinely splits this line across multiple PTY chunks -- the bare
      // substring check fired on chunk 1 alone, latching `setupDone` before
      // the (correctly chunk-boundary-safe) tmux-class parse could ever see
      // the completed line in chunk 2, so the class was silently lost for
      // the rest of the session.
      //
      // The fix for both: the completion latch is now gated on the SAME
      // nonce-bearing, chunk-boundary-safe match `parseTmuxSentinel` uses
      // for the tmux class itself, run against the ACCUMULATED per-session
      // buffer (`bufferSetupLine`, not just this chunk) -- so a bare/wrong
      // sentinel can never latch completion at all, and a genuine one
      // latches exactly once the full line (nonce + resolved class) has
      // actually arrived, however many chunks that took. We only consider
      // sentinels seen AFTER setupSent as completion — otherwise an earlier
      // sentinel echoed by a previous session in the same long-running
      // shell could spuriously latch this on connect.
      if (setupSent && !setupDone) {
        const combined = bufferSetupLine(sessionId, data)
        const tmuxResult = parseTmuxSentinel(combined, sshNonce)
        if (tmuxResult !== undefined) {
          setupDone = true
          clearSetupLineBuffer(sessionId)
          // `null` (explicit 'none') CLEARS detected state; a class STAGES
          // it -- see parseTmuxSentinel's doc comment for why `??` cannot
          // be used here (adversarial review, #242 MINOR).
          detectedTmuxSource = tmuxResult === null ? null : (tmuxResult === 'path' ? 'onpath' : 'staged')
          if (setupTimeoutHandle) {
            clearTimeout(setupTimeoutHandle)
            setupTimeoutHandle = null
          }
          logInfo(`[ssh] ${sessionId}: host setup ok received (tmux=${tmuxResult ?? 'none'})`)
          // item 10: stamp + push the remote account descriptor (if the sentinel
          // carried a decodable, display-valid one).
          const hostAcct = parseSetupAccountSentinel(combined, sshNonce)
          if (hostAcct) { remoteAccount = hostAcct; emitSshSessionInfo(win, sessionId, { remoteAccount }) }
        }
      }

      // Container setup completion: same sentinel, same nonce-gated/buffered
      // latch as the host branch above, but we only consider it after the
      // second setupCmd was written (inside the container).
      if (containerSetupSent && !containerSetupDone) {
        const combined = bufferSetupLine(sessionId, data)
        const tmuxResult = parseTmuxSentinel(combined, sshNonce)
        if (tmuxResult !== undefined) {
          containerSetupDone = true
          clearSetupLineBuffer(sessionId)
          detectedTmuxSource = tmuxResult === null ? null : (tmuxResult === 'path' ? 'onpath' : 'staged')
          if (setupTimeoutHandle) {
            clearTimeout(setupTimeoutHandle)
            setupTimeoutHandle = null
          }
          logInfo(`[ssh] ${sessionId}: container setup ok received (tmux=${tmuxResult ?? 'none'})`)
          const contAcct = parseSetupAccountSentinel(combined, sshNonce)
          if (contAcct) { remoteAccount = contAcct; emitSshSessionInfo(win, sessionId, { remoteAccount }) }
        }
      }

      // #242 tier 4: the arch probe fired alongside writeTmuxStageCmd. Not
      // gated on stagingDone (arch is useful the instant it's known, and
      // must be known BEFORE the stage sentinel resolves for
      // attemptTmuxPush below to ever fire) -- only on stagingSent (the
      // probe is never sent otherwise) and on !archProbeResolved.
      //
      // #242 round-3 MINOR fix: this used to gate on `detectedArch ===
      // null`, which cannot tell "not yet resolved" apart from "resolved to
      // an unrecognised combo" -- both leave detectedArch null, so the
      // regex kept re-running against every later PTY chunk for the rest of
      // the session, and unrelated later output shaped like the sentinel
      // could set detectedArch long after the real probe. `archProbeResolved`
      // latches the FIRST time parseArchProbeSentinel returns anything other
      // than `undefined` (a real match OR an unrecognised-combo `null`), so
      // a stray later repeat can never re-parse or overwrite the result.
      if (stagingSent && !archProbeResolved) {
        // Parse the accumulated text, not this chunk (#242 I1 round-3): a probe
        // split across two chunks otherwise leaves detectedArch null and makes
        // tier 4 unreachable on any link that segments the line.
        const archResult = parseArchProbeSentinel(bufferSshLine(sessionId, 'arch', data))
        if (archResult !== undefined) {
          archProbeResolved = true
          clearSshLineBuffer(sessionId, 'arch')
          detectedArch = archResult
          logInfo(`[ssh] ${sessionId}: tmux tier-4 arch probe resolved -> ${detectedArch ?? 'unrecognised'}`)
        }
      }

      // #242 tier 3: the staging fragment's own completion sentinel. Only
      // considered once writeTmuxStageCmd has actually run (stagingSent)
      // and only the FIRST match counts (stagingDone) -- same shape as the
      // setup-ok latches above. `ok path=` sets detectedTmuxSource ='staged'
      // (so the upcoming writeClaudeCmd wraps in tmux); `fail=<reason>`
      // surfaces the reason via emitSshFlowState info and leaves
      // detectedTmuxSource null, so writeClaudeCmd falls through to the unwrapped launch
      // exactly as it already does for tier 1/2's tmux=none -- UNLESS tier 4
      // can take over: reason is specifically 'download' (no egress, the
      // one failure mode tier 4 exists for) AND the arch probe above already
      // resolved a recognised arch. Any other reason (arch/digest/extract/
      // terminfo/timeout/build-error/unsafe-path), or an unknown arch,
      // behaves exactly as it did before tier 4 existed.
      if (stagingSent && !stagingDone) {
        // Accumulated text, not this chunk (#242 I1 round-3) -- a split
        // `ok path=` otherwise never resolves and the flow stalls to the 20s
        // STAGE_TIMEOUT, silently losing tmux on exactly the tiers a
        // tmux-less remote depends on.
        const stageResult = parseTmuxStageSentinel(bufferSshLine(sessionId, 'stage', data), sshNonce)
        if (stageResult !== undefined) {
          stagingDone = true
          clearSshLineBuffer(sessionId, 'stage')
          if (stagingTimeoutHandle) {
            clearTimeout(stagingTimeoutHandle)
            stagingTimeoutHandle = null
          }
          if (stageResult.ok) {
            detectedTmuxSource = 'staged' // tier 3 staged this path
            logInfo(`[ssh] ${sessionId}: tmux staged ok -> ${stageResult.path}`)
            // #242 finding F3 (MAJOR, adversarial review round 5): patch the
            // ALREADY-WRITTEN settings-<safeSid>.json's CCC_TMUX_BIN before
            // the claude launch write below -- see buildTmuxBinPatchCommand's
            // doc comment (ssh-shim.ts) for why this is required (tiers 3/4
            // run strictly after configureRemoteSettings baked in the
            // tier-1/2 probe result, which is empty on exactly the hosts
            // tier 3 exists to serve). Deliberately NOT passed
            // `stageResult.path` (#242 finding F1(a), round-2 correction) --
            // buildTmuxBinPatchCommand computes the fixed
            // `$HOME/.claude/bin/tmux` location on the REMOTE, at the same
            // trust boundary buildTmuxLaunchCommand's STAGED_TMUX_BIN_EXPR
            // uses, rather than trusting this wire-reported value. Best-
            // effort: a failed/throwing write here must not block the claude
            // launch that follows -- the statusline degrading is strictly
            // better than the session never launching at all.
            try {
              ptyProcess.write(buildTmuxBinPatchCommand(sessionId) + '\r')
            } catch (err) {
              logError(`[ssh] ${sessionId}: tmux CCC_TMUX_BIN settings patch failed to send (statusline may not reflect tmux): ${(err as Error)?.message ?? err}`)
            }
            writeClaudeCmd()
          } else if (stageResult.reason === 'download' && detectedArch) {
            logInfo(`[ssh] ${sessionId}: tmux staging failed (download, no egress) -- attempting tier-4 push instead`)
            attemptTmuxPush(detectedArch)
          } else {
            logInfo(`[ssh] ${sessionId}: tmux staging failed (${stageResult.reason}) -- falling back to bare launch`)
            // #242 round-2 MINOR fix: pass the reason straight to
            // writeClaudeCmd rather than calling
            // setFlowState('running-setup', `tmux-stage-fail:...`) here --
            // that call was immediately overwritten in the same tick by
            // writeClaudeCmd's own setFlowState('running-claude'), so a
            // renderer watching current state only ever saw the LATER
            // state with no reason attached.
            writeClaudeCmd(`tmux-stage-fail:${stageResult.reason}`)
          }
          return
        }
      }

      // #242 tier 4: the push's own completion sentinel -- reuses the EXACT
      // same parser and sentinel shape as tier 3 (buildTmuxPushControlScript
      // emits the identical `ccc-tmux-stage ok/fail` text), so pty-manager
      // needs no second parser. Gated on pushSent/pushDone the same way the
      // tier-3 block above is gated on stagingSent/stagingDone.
      if (pushSent && !pushDone) {
        // Accumulated text, not this chunk (#242 I1 round-3). Reuses the
        // 'stage' buffer deliberately: tier 4 only runs after tier 3 has
        // resolved and cleared it, and both emit the identical sentinel shape,
        // so there is no interleaving to keep apart between these two.
        const pushResult = parseTmuxStageSentinel(bufferSshLine(sessionId, 'stage', data), sshNonce)
        if (pushResult !== undefined) {
          pushDone = true
          clearSshLineBuffer(sessionId, 'stage')
          if (pushTimeoutHandle) {
            clearTimeout(pushTimeoutHandle)
            pushTimeoutHandle = null
          }
          if (pushResult.ok) {
            detectedTmuxSource = 'staged' // tier 4 staged this path
            logInfo(`[ssh] ${sessionId}: tmux pushed ok -> ${pushResult.path}`)
            // #242 finding F3: same CCC_TMUX_BIN patch as the tier-3 ok
            // branch above -- see that branch's comment.
            try {
              ptyProcess.write(buildTmuxBinPatchCommand(sessionId) + '\r')
            } catch (err) {
              logError(`[ssh] ${sessionId}: tmux CCC_TMUX_BIN settings patch failed to send (statusline may not reflect tmux): ${(err as Error)?.message ?? err}`)
            }
            writeClaudeCmd()
          } else {
            logInfo(`[ssh] ${sessionId}: tmux push failed (${pushResult.reason}) -- falling back to bare launch`)
            writeClaudeCmd(`tmux-push-fail:${pushResult.reason}`)
          }
          return
        }
      }

      // The current chunk's prompt-shaped last line, computed once for the
      // password check, the sudo check, and the stage transitions below. The
      // STICKY copy (lastPromptLineSeen) feeds the idle fallback's auth-prompt
      // guard; a chunk whose last line strips to '' (a bare \r\n ack, a pure
      // control-sequence repaint) does not clear it — the prompt is still on
      // screen through those.
      const promptLineNow = lastPromptLineForClaude(data)
      if (promptLineNow !== '') lastPromptLineSeen = promptLineNow

      // Auto-type SSH password only on a real password prompt, not any MOTD
      // line containing the word.
      if (!passwordSent && password && PASSWORD_PROMPT_RE.test(promptLineNow)) {
        passwordSent = true
        setTimeout(() => {
          ptyProcess.write(password + '\r')
        }, 100)
        return
      }

      // Auto-type sudo password on a real sudo prompt only. Variants sudo
      // emits: `[sudo] password for X:`, `password for X:`, `Password:`.
      // End-of-line match avoids false-triggering on a log message that
      // happens to mention `[sudo]` or `password for`.
      if (!sudoPasswordSent && sudoPassword && postCommandSent && !claudeSent) {
        const promptLine = promptLineNow
        if (promptLine && /(\[sudo\].*password.*:|password for .+:|^password:)\s*$/i.test(promptLine)) {
          sudoPasswordSent = true
          setTimeout(() => {
            ptyProcess.write(sudoPassword + '\r')
          }, 100)
          return
        }
      }

      // BACKSTOP — once Claude is running, no more auto-writes EVER.
      if (claudeRunning) {
        if (currentFlowState !== 'claude-running') setFlowState('claude-running')
        return
      }

      const lastLine = promptLineNow
      const sawShellPrompt = !!lastLine && SHELL_PROMPT_RE.test(lastLine)

      // ---- STAGE TRANSITION DETECTION ----
      // Manual flow: shell-prompt detection only emits "awaiting-X"
      // states. The user's overlay click triggers the next writer.
      // Once a user-consented chain has started (host setup or
      // postCommand fired), the chain auto-continues on prompt
      // detection — the user already consented at the start.

      // First shell prompt after login → emit awaiting-postcommand /
      // awaiting-claude / shell-only and wait for user click.
      if (
        !setupSent
        && !postCommandSent
        && sawShellPrompt
        && (currentFlowState === 'connecting' || currentFlowState === 'skipped')
      ) {
        if (postCommand) {
          setFlowState('awaiting-postcommand')
        } else if (options?.shellOnly) {
          setFlowState('shell-only')
        } else {
          setFlowState('awaiting-claude', 'host')
        }
        return
      }

      // Host setup done + fresh shell prompt → write claudeCmd.
      // Setup ran because user clicked Launch Claude on the host;
      // claude is the only sensible next stage.
      if (setupSent && setupDone && !setupShellReady && sawShellPrompt) {
        setupShellReady = true
        if (!claudeSent) proceedAfterSetup()
        return
      }

      // Inner shell prompt after postCommand → emit awaiting-claude.
      // User picks Launch Claude (→ container setup → claudeCmd) or
      // Skip (→ drops to inner shell).
      if (
        postCommandSent
        && !postCommandShellReady
        && sawShellPrompt
        && (!sudoPassword || sudoPasswordSent)
      ) {
        postCommandShellReady = true
        inInnerShell = true
        setFlowState('awaiting-claude', 'inner')
        return
      }

      // Container setup done + inner shell prompt → write claudeCmd.
      // Reaches here only via launchClaude() in the inner shell, so
      // the user already consented to claude.
      if (
        containerSetupSent
        && containerSetupDone
        && !containerSetupShellReady
        && !claudeSent
        && sawShellPrompt
      ) {
        containerSetupShellReady = true
        proceedAfterSetup()
      }
    })
  } else if ((options?.provider ?? 'claude') === 'codex' && !options?.shellOnly) {
    captureCodexSpawnIdentity(sessionId)
    // Codex local session — spawn `codex` directly. Codex itself owns the
    // REPL, so there is no shell-wrap-then-cd-then-launch dance like Claude
    // requires. cwd is propagated through pty.spawn options.
    // shellOnly falls through to the Claude branch below so the user gets a
    // plain shell, regardless of provider selection.
    //
    // Copilot review on PR #31 (p9.15): buildSpawnCommand or pty.spawn can
    // throw before onExit is wired up (binary missing, ConPTY init failure,
    // node-pty resolver miss). Clean up the spawn-identity map entry on
    // failure so it doesn't leak.
    try {
      const provider = getProvider('codex')
      const { cmd: spawnCmd, args: spawnArgs, env: spawnEnv } = provider.buildSpawnCommand({
        sessionId,
        provider: 'codex',
        cwd: options?.cwd,
        cols,
        rows,
        useResumePicker: options?.useResumePicker,
        codexOptions: options?.codexOptions,
        // Same light/dark signal the local Claude spawn gets (book item 34).
        hostColorScheme: resolveHostColorScheme(
          readConfig<{ theme?: string }>('settings')?.theme,
          nativeTheme.shouldUseDarkColors,
        ),
      })
      logInfo(`[pty-manager] Launching Codex PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}`)
      // Codex sessions never designate a canvas worktree; drop any inherited hint.
      delete (spawnEnv as Record<string, string>).CCC_SESSION_WORKTREE
      // Capture timestamp before spawn so the watch-and-claim window starts no later than PTY launch.
      const codexSpawnTimestamp = Date.now()
      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: spawnEnv,
        useConpty: true,
      })
      ptyProcess.onData((data) => {
        if (win.isDestroyed()) return
        getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
        win.webContents.send(`pty:data:${sessionId}`, data)
      })
      // Start rollout watch-and-claim telemetry. Updates are dispatched to the
      // renderer (statusline:update) identically to how Claude statusline
      // updates flow through statusline-watcher.ts. (Tokenomics is no longer fed
      // from telemetry ticks — the indexing worker reads raw transcripts.)
      const codexTelSrc = provider.ingestSessionTelemetry(
        sessionId,
        { cwd: resolvedCwd, spawnTimestamp: codexSpawnTimestamp },
        (data) => {
          // Copilot review on PR #31 (p9.17): decorate at the send site so
          // the renderer receives accountColour. decorateStatuslineWithColour
          // is a no-op when the payload carries no accountEmail (Codex
          // telemetry currently does not), so this is safe + future-proof.
          // Tokenomics no longer ingests from telemetry ticks (the worker
          // indexes raw transcripts on its own timer); only the renderer send
          // remains.
          const decorated = decorateStatuslineWithColour(data)
          if (!win.isDestroyed()) win.webContents.send('statusline:update', decorated)
        },
      )
      codexTelemetrySources.set(sessionId, codexTelSrc)
    } catch (err) {
      clearCodexSpawnIdentity(sessionId)
      throw err
    }
  } else {
    // Local session — delegate binary + env construction to the provider.
    // The post-spawn shell-write (cd + claude command) stays here; only the
    // bare shell + env comes from the provider.
    const shellOnly = options?.shellOnly
    const provider = getProvider('claude')
    // Read classicTerminalCopyPaste + theme fresh on every spawn (default true /
    // dark when absent). The theme drives COLORFGBG so Claude's startup theme
    // auto-detection matches CCC; 'system' follows the OS via nativeTheme.
    const claudeSpawnSettings = readConfig<{ classicTerminalCopyPaste?: boolean; theme?: string; clickableQuestions?: boolean; disableBackgroundTasks?: boolean }>('settings')
    const classicTerminalCopyPaste = claudeSpawnSettings?.classicTerminalCopyPaste !== false
    // Clickable question options (CC >= 2.1.195) default OFF in CCC.
    const clickableQuestions = claudeSpawnSettings?.clickableQuestions === true
    // Background tasks/agents disabled by default so a stray Ctrl+B / bg can't strand a session.
    const disableBackgroundTasks = claudeSpawnSettings?.disableBackgroundTasks !== false
    const hostColorScheme = resolveHostColorScheme(
      claudeSpawnSettings?.theme,
      nativeTheme.shouldUseDarkColors,
    )
    const { cmd: spawnCmd, args: spawnArgs, env: spawnEnv } = provider.buildSpawnCommand({
      sessionId,
      cwd: options?.cwd,
      cols,
      rows,
      shellOnly: options?.shellOnly,
      elevated: options?.elevated ?? options?.terminalOptions?.elevated,
      terminalSecret: options?.terminalSecret,
      commandSecrets: options?.commandSecrets,
      legacyVersion: options?.legacyVersion,
      effortLevel: options?.effortLevel,
      disableAutoMemory: options?.disableAutoMemory,
      model: options?.model,
      useResumePicker: options?.useResumePicker,
      agentsConfig: options?.agentsConfig,
      classicTerminalCopyPaste,
      clickableQuestions,
      disableBackgroundTasks,
      hostColorScheme,
      askPrompt: options?.askPrompt,
    })
    const wantProfileId = options?.profileId
    // Validate before the join. This is the FOURTH site with the resolver shape,
    // and the only one that is inline rather than a named function, which is why
    // it was missed when the other three were guarded. `pty:spawn` types
    // profileId as `z.string().optional()` — a type check, not a charset one — so
    // a renderer-supplied `../x` reaches here. Without this, getProfileConfigDir
    // throws and the spawn hard-fails; with it, a crafted id takes the existing
    // warn-and-fall-back-to-primary branch below, matching the other three
    // resolvers and keeping that throw genuinely unreachable.
    if (wantProfileId && isValidProfileId(wantProfileId) && fs.existsSync(getProfileConfigDir(wantProfileId))) {
      resolvedProfileId = wantProfileId
    } else if (wantProfileId) {
      logWarn(`[profiles] session ${sessionId}: profile dir missing or invalid for profileId=${wantProfileId}; falling back to primary/default`)
    }
    // Clobber-proofing: a non-shell Claude session never runs on the bare global
    // home -- fall back to the captured primary profile.
    if (!shellOnly && !resolvedProfileId) {
      const primary = getPrimaryProfileId()
      if (primary && fs.existsSync(getProfileConfigDir(primary))) resolvedProfileId = primary
    }
    // Home selection (Bug 2): EVERY session of an account -- shell-only (plain
    // shells + the add-account login flow) AND interactive Claude -- runs in the
    // account's shared PROFILE home. That way concurrent sessions of one account
    // share ONE rotating-OAuth credential store and coordinate token refreshes the
    // way a normal single-account install does. The old per-session-home model gave
    // each session a private COPY of the credential; the first refresh rotated the
    // token and invalidated every other copy, forcing a re-auth on resume.
    // Auth-outside-CCC fix: before a session reads the primary account's profile
    // home, pull a fresher global token (e.g. a /login the user ran OUTSIDE CCC)
    // into it so this session starts on the live token. Primary-only + email-guarded;
    // no-op otherwise.
    try { syncPrimaryCredentialsWithGlobal() } catch { /* best-effort */ }
    let home: string | null = null
    if (resolvedProfileId) {
      try { setupProfileLinks(resolvedProfileId) } catch (e) { logWarn(`[profiles] session ${sessionId}: home refresh failed: ${e}`) }
      home = getProfileConfigDir(resolvedProfileId)
    }
    const finalSpawnEnv = withProfileHome(spawnEnv, home)
    // Give the resume-picker (run inside this PTY) the CONFIG dir so it can read
    // session-state.json and label conversations with their CCC work name
    // (customName). Read-only, best-effort — never block the spawn (#130).
    try { finalSpawnEnv.CCC_CONFIG_DIR = getConfigDir() } catch { /* best-effort */ }
    // Session isolation + Agent Canvas (ADR-016): CCC DESIGNATES where this
    // session's guard worktree lives — `<worktree base>/<ccc-session-short>`,
    // derived from the CONFIGURED project directory and CCC's own session id,
    // never from anything the agent writes — tells the guard through
    // CCC_SESSION_WORKTREE, and (below, once the project itself is registered
    // as a served root) designates the same path as a pending canvas root, so
    // a mockup the agent writes into its own worktree is renderable by
    // htmlPath. Interactive Claude sessions only: the canvas is bound to those.
    // Null when the project is not a primary git checkout (the guard has
    // nothing to anchor to there either).
    const designatedWorktree = !shellOnly && !isHomeOrAncestor(resolvedCwd)
      ? designatedWorktreeDir(resolvedCwd, sessionId)
      : null
    // Set only when THIS session designates; otherwise DELETE any value inherited
    // from CCC's own environment (a dev CCC launched from inside a guarded tile
    // inherits the outer tile's CCC_SESSION_WORKTREE — it must not leak into a
    // shell-only / home-project / non-designated session and misdirect its guard).
    if (designatedWorktree) finalSpawnEnv.CCC_SESSION_WORKTREE = designatedWorktree
    else delete finalSpawnEnv.CCC_SESSION_WORKTREE
    logInfo(`[profiles] session ${sessionId} account spawn: requestedProfileId=${wantProfileId ?? '(none)'} resolvedProfileId=${resolvedProfileId ?? '(none/bare-global)'} shellOnly=${shellOnly} USERPROFILE=${home ?? '(real home)'}`)
    // Reliable, drift-immune account identity: capture once at spawn from the
    // session's profile (or the default ~/.claude.json), never re-read.
    // B3: capture is deferred until AFTER the interactive Claude pty.spawn
    // succeeds (see below) so a spawn throw can't leak the per-session map entry,
    // and shell-only sessions (no Claude) never capture.

    if (shellOnly) {
      logInfo(`[pty-manager] Launching shell-only PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}${options?.elevated ? ' (elevated)' : ''}`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: finalSpawnEnv,
        useConpty: true
      })

      // Explicitly cd to ensure the shell is in the right directory
      // (PowerShell profiles can change cwd before the user sees the prompt)
      const isWin = os.platform() === 'win32'
      // Through the shared helper, NOT a local re-escape. This line is the
      // shell-only twin of the Claude launch path and carries the identical
      // value (resolveCwd of the config's workingDirectory) into the identical
      // PowerShell construct — so the hand-rolled ASCII-only doubling here was
      // the same injection, reachable the same way, and it fires on the `cd`
      // before any binary runs. -LiteralPath because Set-Location otherwise
      // treats its argument as a WILDCARD: a real directory named `proj[1m]`
      // never matches, and the session silently starts in the wrong place.
      const cdCmd = isWin
        ? `Set-Location -LiteralPath ${quoteArgForShell(resolvedCwd, true)}`
        : `cd ${quoteArgForShell(resolvedCwd, false)} 2>/dev/null; clear`

      // Terminal-only first-run command. `{secret}` becomes a REFERENCE to the
      // CCC_ARG_SECRET env var (set from the keychain in buildClaudeLocalSpawn),
      // never the secret itself — see terminal-launch-line.ts for the contract.
      const launchLine = buildTerminalLaunchLine(options?.terminalOptions, isWin)

      launchWriteScheduled = true
      launchPendingSessions.add(sessionId)
      setTimeout(() => {
        // Liveness guard: a kill / Restart / app-quit can land inside this 300ms
        // window — writing to a dead or already-replaced PTY here would throw
        // inside the timer (uncaught in main). Only write when our PTY is still
        // the registered one.
        if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) { abandonLaunchHold(); return }
        try {
          ptyProcess.write(cdCmd + '\r')
          // Queued straight after the cd: the shell runs them in order, so the
          // command always starts in the configured directory.
          if (launchLine) {
            logInfo(`[pty-manager] shell-only first-run command for ${sessionId}: ${launchLine}`)
            ptyProcess.write(launchLine + '\r')
          }
          releaseLaunchHold()
        } catch { abandonLaunchHold() /* session died mid-launch */ }
      }, 300)
    } else {
      // Launch Claude Code interactive mode.
      // Spawn a shell first, explicitly cd to the project directory, then run claude.
      // We must cd explicitly because:
      //   1. PowerShell profiles can change the working directory before our command runs
      //   2. WinPTY may not always propagate cwd correctly
      //   3. Spawning claude.cmd directly via pty.spawn fails to propagate cwd on Windows
      // Without the explicit cd, conversations get stored under the wrong project hash
      // and won't appear when the user tries to /resume.
      const { cmd } = resolveClaudeForPty(options?.legacyVersion)

      // T8b (bug #5): EXACT-CONVERSATION RESUME.
      //
      // `claude --resume <uuid>` is cwd-SCOPED: it only resolves a conversation
      // from the LAUNCH cwd's mangled ~/.claude/projects/<mangled> folder, and
      // needs both <uuid>.jsonl AND a same-name companion dir there. The CLI only
      // creates that companion dir LAZILY (first subagent/workflow), so a
      // direct-work conversation lacks one — CCC therefore ENSURES it on demand
      // (see below) rather than requiring it. The default resume-picker /
      // newest-in-folder behaviour can also pick a STALE conversation when the
      // live one ran under a DIFFERENT cwd (e.g. a git worktree). So we must do
      // BOTH: pass --resume <uuid> AND override the launch cwd to the directory
      // the conversation actually ran in (read out of the JSONL — the mangled
      // folder name is lossy and not reversible).
      //
      // Effective target precedence (all fail-open):
      //   options.resume          (app-relaunch: persisted on the restored session)
      //   lastResumeTarget        (in-session Restart / Switch-account: self-captured)
      //
      // The whole override is gated by the pure resolveResumeLaunch() helper:
      // transcript file present AND the RAW target cwd is a real directory
      // (stat'd directly — NOT via the homedir-fallback resolveCwd). A missing
      // companion dir is NO LONGER a gate — the helper creates it best-effort so
      // a direct-work conversation stays resumable. ANY OTHER miss → drop resume
      // entirely and fall back to existing behaviour. We never launch --resume
      // from os.homedir() (a deleted worktree therefore falls back, it does not
      // silently retarget home).
      let resumeUuid: string | undefined = undefined
      let claudeCwd = resolvedCwd
      // Precedence: app-relaunch persisted target wins over the self-captured
      // one. The self-captured target is consumed unconditionally below so it
      // can never apply to a later, unrelated spawn of this sessionId.
      const persistedTarget = options?.resume
      const selfCapturedTarget = getLastResumeTarget(sessionId)
      clearLastResumeTarget(sessionId)
      const effectiveTarget = persistedTarget ?? selfCapturedTarget
      // FIX 3: `discoveryOn` (binder present == logging on) gates ONLY the
      // self-captured path — that path's target ORIGINATES from the binder, so
      // without it there is nothing to capture. The app-relaunch path uses the
      // PERSISTED options.resume + on-disk file checks and needs no binder, so
      // logging-off users still get exact-resume on relaunch. (When the target
      // is self-captured the binder is inherently present anyway.)
      const usingPersisted = !!persistedTarget
      const discoveryOn = usingPersisted || !!getTranscriptBinder()
      if (effectiveTarget && (options?.provider ?? 'claude') === 'claude' && discoveryOn) {
        // FIX 1 + FIX 2: the cwd/path existence gate lives in the pure, tested
        // resolveResumeLaunch() helper. It stats the RAW captured cwd directly
        // (no homedir-fallback resolver), so a DELETED worktree → null → fall
        // back to picker/direct. We never launch --resume from os.homedir().
        const launch = resolveResumeLaunch(effectiveTarget, {
          existsSync: fs.existsSync,
          statSync: (p) => fs.statSync(p),
          homedir: os.homedir,
          mangleCwdToProjectDir,
          projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
          // Best-effort: ensure a direct-work conversation (no subagent/workflow,
          // hence no companion dir from the CLI) is resumable. Never throws.
          ensureCompanionDir: (projectDir, uuid) => { ensureCompanionDir(projectDir, uuid, nodeFsCompanionDeps) },
        })
        if (launch) {
          resumeUuid = launch.resumeUuid
          claudeCwd = launch.claudeCwd
          // FIX 4: propagate the override to function scope so the subsequent
          // runStart/registerRun stamp + scan the folder Claude actually ran in.
          effectiveLaunchCwd = claudeCwd
          // Part A: capture the resume uuid at function scope so the registerRun
          // site can bind the exact transcript IMMEDIATELY (deterministic
          // resume-bind), independent of the hooks/statusline/heuristic race.
          resumeUuidForBind = launch.resumeUuid
          logInfo(`[pty] T8b exact resume for ${sessionId}: uuid=${resumeUuid} cwd=${claudeCwd} (was ${resolvedCwd})`)
        } else {
          // #535: the exact gate failed. When the ONLY reason is a deleted
          // worktree cwd, the conversation transcript still exists under the
          // worktree's mangled project folder — relocate it into the surviving
          // configured cwd's folder and resume there rather than opening fresh.
          const recovered = recoverOrphanResumeLaunch(effectiveTarget, resolvedCwd, {
            existsSync: fs.existsSync,
            statSync: (p) => fs.statSync(p),
            mkdirp: (dir) => { fs.mkdirSync(dir, { recursive: true }) },
            renameFile: (src, dst) => { fs.renameSync(src, dst) },
            copyFile: (src, dst) => { fs.copyFileSync(src, dst) },
            removeFile: (p) => { fs.rmSync(p, { force: true }) },
            pid: () => process.pid,
            warn: (msg) => { logWarn(msg) },
            homedir: os.homedir,
            mangleCwdToProjectDir,
            projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
            isHomeOrAncestor,
            ensureCompanionDir: (projectDir, uuid) => { ensureCompanionDir(projectDir, uuid, nodeFsCompanionDeps) },
          })
          if (recovered) {
            resumeUuid = recovered.resumeUuid
            claudeCwd = recovered.claudeCwd
            effectiveLaunchCwd = claudeCwd
            resumeUuidForBind = recovered.resumeUuid
            logInfo(`[pty] T8b ORPHAN-RECOVERED resume for ${sessionId}: uuid=${resumeUuid} relocated to cwd=${claudeCwd} (dead worktree was ${effectiveTarget.cwd})`)
          } else {
            logInfo(`[pty] T8b resume target dropped for ${sessionId} (fail-open existence check; no orphan recovery) — uuid=${effectiveTarget.uuid} cwd=${effectiveTarget.cwd}`)
          }
        }
      }

      logInfo(`[pty-manager] Launching Claude via shell in PTY: ${spawnCmd} -> ${cmd} cwd=${claudeCwd} (resumePicker=${!!options?.useResumePicker}, resume=${resumeUuid ?? 'none'})`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: claudeCwd,
        env: finalSpawnEnv,
        useConpty: true
      })

      // B3: capture identity ONLY after the spawn succeeds — if pty.spawn throws,
      // no map entry is created (no leak), and shell-only sessions never reach
      // here. resolvedProfileId is undefined when no explicit or primary profile
      // resolved, so identity comes from the default account in that case.
      captureClaudeAccount(sessionId, resolvedProfileId)
      pushAccountIdentity(sessionId)
      // Watch for a mid-session account change (user runs /login in the terminal
      // without a respawn), so the strip/card/statusline follow the new account.
      startWatchingAccountIdentity(sessionId, resolvedProfileId)

      // codex_review is authorised globally (2 Aug decision): every LOCAL Claude
      // session registers. Availability is still governed at tool-registration
      // time by the global Codex master + conductor tool toggles
      // (conductor-mcp-server createServer), and SSH sessions never reach this
      // branch, so the tool keeps running only against paths that exist on this
      // machine. The per-config enableCodexReview flag is retired (ignored).
      //
      // SECURITY (adversarial review, #188): register the ACTUAL launch cwd
      // (`claudeCwd`, post-resume-override) — not the pre-override `resolvedCwd`
      // — and REFUSE to register when that cwd is the bare home directory. A
      // config whose workingDirectory is '.', empty, or a stale/deleted path
      // makes resolveCwd() silently fall back to os.homedir(); registering that
      // would let a prompt-injected session review ~/.ssh, ~/.claude, ~/.aws via
      // mode:'paths' (containment holds, but the ROOT is wrong). Since universal
      // opt-in removed the per-config gate that used to bound this, block it at
      // the source: no legitimate review targets the bare home dir.
      if (isHomeOrAncestor(claudeCwd)) {
        logWarn(`[pty] codex_review NOT registered for ${sessionId}: launch cwd resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home). Set a real project directory to enable review.`)
      } else {
        registerCodexReviewSession(sessionId, claudeCwd)
      }

      // The Agent Canvas serving allowlist rides the same decision, for the same
      // reason — but NOT against the same directory (adversarial review,
      // 2026-08-15, second pass).
      //
      // `claudeCwd` is TRANSCRIPT-DERIVED whenever an exact-resume applies. It
      // starts as `resolvedCwd` and is then overwritten with
      // `resolveResumeLaunch(effectiveTarget).claudeCwd`, which is
      // `target.cwd` — and `target` is either the persisted `options.resume` or
      // the self-captured `resolveResumeTargetFromTranscript()`, whose cwd is
      // THE FIRST `cwd` STRING IN THE TRANSCRIPT JSONL, verbatim. That file is
      // one the agent can write. So an agent that rewrites its own transcript's
      // first line to `"cwd":"C:\\Users\\<u>\\.claude"` and creates the matching
      // mangled projects directory names its own served root the next time the
      // user hits Restart or Switch-account. `isHomeOrAncestor` does not catch
      // it: `~/.claude` is a CHILD of home, not an ancestor. From there
      // `canvas_render { htmlPath: '…/.claude/.credentials.json' }` reads the
      // OAuth token and the pre-allowed `canvas_snapshot` reads it back out of
      // the DOM. The previous fix moved the registration to this file and
      // claimed "no served root is derived from transcript content any more";
      // moving the CALL did not change where the VALUE came from.
      //
      // So the canvas root is `resolvedCwd` — `resolveCwd(options.cwd)`, the
      // session's CONFIGURED project directory, which no transcript can reach —
      // and never the resume override. The cost is bounded and known: a session
      // that exact-resumes a conversation from OUTSIDE its configured project
      // directory can serve nothing (renders are refused, not misdirected).
      //
      // codex_review above deliberately keeps `claudeCwd`: changing what it
      // reviews is a separate behavioural decision, and its exposure is
      // different in kind (it reads for a review the user reads, with no
      // pre-allowed tool reading the bytes back). It is flagged, not changed.
      if (isHomeOrAncestor(resolvedCwd)) {
        logWarn(`[pty] canvas serving root NOT registered for ${sessionId}: the configured project directory resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home).`)
        setCanvasRootRefusal(sessionId, describeCanvasRootRefusal('home-or-ancestor', resolvedCwd))
      } else if (!registerCanvasUatRoot(sessionId, resolvedCwd)) {
        // Floor-checked again inside the store (absolute, real, a directory, not
        // home, not a volume root, not a dot-dir under home, not the resources
        // directory) — two independent refusals rather than one, because this is
        // the only thing standing between a prompt-injected agent and a file
        // read with the app's privileges.
        //
        // NAME the floor that refused (#371). "Refused by the canvas store" in a
        // log file, with the agent told to write where it already wrote, is an
        // undiagnosable dead end for the one configuration the resources-dir
        // floor exists for.
        const reason = canvasRootRefusalReason(sessionId, resolvedCwd)
        const explanation = reason ? describeCanvasRootRefusal(reason, resolvedCwd) : 'the canvas store refused it.'
        logWarn(`[pty] canvas serving root NOT registered for ${sessionId} (${reason ?? 'unknown'}): ${explanation}`)
        setCanvasRootRefusal(sessionId, explanation)
      }

      // The worktree designation is INDEPENDENT of the project root (#371). It
      // used to sit in the same else-if chain, so a project directory refused
      // by any floor also cost the session its worktree root — even though
      // `<parent>/ccc-wt/<sid>` neither contains nor sits under the resources
      // directory and would have been accepted. One refusal, not two.
      //
      // PENDING: the store consults it only once it exists as a real, un-linked
      // directory (canvas-store.designateCanvasWorktreeRoot). The path is CCC's,
      // the contents are the agent's own; nothing an agent can write moves it
      // (ADR-016).
      if (designatedWorktree) {
        if (designateCanvasWorktreeRoot(sessionId, designatedWorktree)) {
          logInfo(`[pty] canvas: designated session worktree ${designatedWorktree} for ${sessionId} (served once it exists)`)
        } else {
          logWarn(`[pty] canvas: designated session worktree ${designatedWorktree} for ${sessionId} was refused by the canvas store floor.`)
        }
      }

      // Explicitly cd to the project directory, then launch Claude.
      // The cd is critical — it ensures Claude sees the correct project directory
      // regardless of PowerShell profile scripts or PTY cwd propagation issues.
      // The command string + cwd escaping is built by the pure
      // buildClaudeLaunchCommand() helper below; it uses `claudeCwd` (the
      // resume-target override when active, else resolvedCwd).

      // Build extra CLI flags (--effort, --settings). --name is deliberately
      // NOT passed: the current Claude CLI treats `--name "<label>"` as the
      // [prompt] positional, so the label gets sent as the user's first
      // message. Our own UI already shows the session label — there's no
      // benefit to passing it to Claude.
      let extraFlags = ''
      if (options?.effortLevel) {
        extraFlags += ` --effort ${options.effortLevel}`
      }
      // MUST be quoted (#144): 1M-context ids contain brackets (`opus[1m]`),
      // which zsh treats as a glob class and aborts the whole launch line.
      // modelFlag builds the entire flag so this site cannot interpolate the
      // raw value by accident. (--effort / --permission-mode need no quoting:
      // their IPC guards — a `^[a-zA-Z0-9_-]+$` charset and a fixed enum —
      // exclude every glob and shell metacharacter.)
      const mFlag = modelFlag(options?.model, os.platform() === 'win32')
      if (mFlag) extraFlags += ` ${mFlag}`
      // Per-config permission mode. 'default'/'' => no flag (Claude's own default).
      if (options?.permissionMode && options.permissionMode !== 'default') {
        extraFlags += ` --permission-mode ${options.permissionMode}`
      }
      // Advanced escape hatch: extra CLI args verbatim (IPC-charset-guarded, no
      // shell metacharacters, CCC-managed flags rejected at the IPC seam).
      if (options?.extraArgs && options.extraArgs.trim()) {
        extraFlags += ` ${options.extraArgs.trim()}`
      }

      // P7.7.2: seed a per-session settings file for hooks/statusLine
      // overrides. P7.7.3: also seed a per-session MCP config file
      // (--mcp-config), because claude.exe ignores mcpServers in --settings
      // and reads it ONLY from --mcp-config or ~/.claude.json.
      //
      // Read the app settings ONCE for this spawn: the settings block, the MCP
      // block and the canvas-plugin block below all key off them, and reading
      // fresh per spawn is what lets a Settings toggle apply to the next
      // session without an app restart.
      const appSettings = readConfig<{ disableClaudeWorkflows?: boolean; statusLineEnabled?: boolean; conductorToolsEnabled?: boolean }>('settings')
      // Built-in tools master (onboarding p6 / Settings): also gates the
      // canvas workflow plugin + pre-allowed canvas tools — without the
      // conductor MCP entry there is nothing for either to talk to.
      const conductorOn = appSettings?.conductorToolsEnabled !== false
      try {
        // v1.5.12: thread the CCC AppSettings.disableClaudeWorkflows flag
        // through so Claude Code's dynamic-workflow feature can be killed
        // at the per-session level without the user hand-editing
        // ~/.claude/settings.json.
        const disableWorkflows = !!appSettings?.disableClaudeWorkflows
        // Master status-line switch (onboarding p4 / Settings -> Status line):
        // absent means ON (pre-upgrade configs). Off = no resourcesDir, so the
        // per-session clone gets no statusLine key and Claude runs without the
        // bundled script. Sessions already running keep theirs until restarted.
        const statusLineOn = appSettings?.statusLineEnabled !== false
        const sesPath = writeLocalSessionSettings(sessionId, {
          disableWorkflows,
          resourcesDir: statusLineOn ? getResourcesDirectory() : undefined,
          // SEC-BATCH FLAG (2026-08-14): pre-allow CCC's own canvas tools so
          // the render->review loop doesn't stall in approval prompts (the VM
          // transcript lost 11 minutes to one). Additive allow only — a user
          // deny still wins under Claude's permission semantics.
          allowCanvasTools: conductorOn,
        })
        // injectHooks rewrites the per-session settings file to point Claude's
        // hook events at our local gateway, which drives the session attention
        // pulse, statusline ingest, and conversation logging. Skipped only when
        // the gateway is down (port-bind failure, etc.) so Claude still spawns
        // cleanly.
        const gw = getGateway()
        const gwStatus = gw?.status()
        if (gw && gwStatus?.listening && gwStatus.port) {
          try {
            const secret = gw.registerSession(sessionId)
            injectHooks({ sessionId, settingsPath: sesPath, port: gwStatus.port, secret, cwd: claudeCwd })
          } catch (err) {
            logError(`[pty] Failed to inject hooks for ${sessionId}: ${(err as Error)?.message ?? err}`)
          }
        }
        // Only pass --settings if the file was actually written. The per-session
        // writers fail closed now (no insecure fallback), so a transient write
        // failure can leave no file -- and claude exits 1 on a missing --settings
        // path. Omit the flag instead so the session still launches on defaults.
        if (fs.existsSync(sesPath)) {
          extraFlags += ` --settings ${quoteArgForShell(sesPath, os.platform() === 'win32')}`
        } else {
          logWarn(`[pty] per-session settings not written for ${sessionId}; launching without --settings`)
        }
      } catch (err) {
        logError(`[pty] Failed to seed per-session settings for ${sessionId}: ${(err as Error)?.message ?? err}`)
      }
      try {
        const mcpCfgPath = writeLocalSessionMcpConfig(sessionId, conductorOn)
        // Only pass --mcp-config if the file exists: the writer fails closed, and
        // claude exits 1 on a missing --mcp-config path. Omit it on a write
        // failure so the session still launches (without built-in conductor tools).
        if (fs.existsSync(mcpCfgPath)) {
          extraFlags += ` --mcp-config ${quoteArgForShell(mcpCfgPath, os.platform() === 'win32')}`
        } else {
          logWarn(`[pty] per-session MCP config not written for ${sessionId}; launching without --mcp-config`)
        }
      } catch (err) {
        logError(`[pty] Failed to seed per-session MCP config for ${sessionId}: ${(err as Error)?.message ?? err}`)
      }

      // Agent Canvas workflow plugin (P6 seed): the skill that drives the
      // render->review loop so the user never has to know a tool name.
      // Session-scoped via --plugin-dir (nothing written to ~/.claude).
      // Skipped for pinned legacy CLI versions — they may predate the flag,
      // and an unknown flag fails the whole launch.
      if (conductorOn && !options?.legacyVersion?.enabled) {
        try {
          // existsSync for the same reason --settings and --mcp-config check:
          // a flag pointing at a missing path is at best ignored and at worst
          // exits the CLI, and this one is appended to every session.
          const pluginDir = ensureCanvasPlugin()
          if (pluginDir && fs.existsSync(pluginDir)) {
            extraFlags += ` --plugin-dir ${quoteArgForShell(pluginDir, os.platform() === 'win32')}`
          }
        } catch (err) {
          logWarn(`[pty] canvas plugin unavailable for ${sessionId}: ${(err as Error)?.message ?? err}`)
        }
      }

      // Build --agents flag if agent templates are configured
      let agentsFlag = ''
      if (options?.agentsConfig && options.agentsConfig.length > 0) {
        const agentsJson = JSON.stringify(options.agentsConfig)
        // Through the shared helper. Agent templates are free text a user
        // types (and JSON from the resources dir), so a curly apostrophe in a
        // description is ORDINARY PROSE — it broke launches by accident long
        // before anyone crafted one deliberately. The old hand-inlined
        // doubling escaped U+0027 only, and this value is concatenated
        // straight into the same launch line the quoting fix hardened.
        agentsFlag = ` --agents ${quoteArgForShell(agentsJson, os.platform() === 'win32')}`
        logInfo(`[pty] Agents flag for ${sessionId}: ${agentsFlag.slice(0, 200)}...`)
      }

      // When useResumePicker is true, run the resume-picker script instead of
      // Claude directly. The picker shows prior conversations and launches Claude
      // with --resume or plain. Any claude flags we've already built up (notably
      // --settings for hooks) must be forwarded through the picker so the child
      // claude process sees them too.
      //
      // T8b: when an exact resume target resolved (resumeUuid set), the builder
      // BYPASSES the picker and launches `claude --resume <uuid>` directly from
      // claudeCwd (the conversation's real cwd). Otherwise the byte-identical
      // golden behaviour (picker / direct) is preserved.
      const escapedCmd = buildClaudeLaunchCommand({
        platform: os.platform() === 'win32' ? 'win32' : 'posix',
        cwd: claudeCwd,
        claudeBin: cmd,
        extraFlags,
        agentsFlag,
        useResumePicker: !!options?.useResumePicker,
        pickerScript: getResumePickerPath(),
        resumeUuid,
        // Boolean only: the question itself travels in the spawn env
        // (CCC_ASK_PROMPT), never through the command string.
        //
        // Read off the ENV THIS SPAWN ACTUALLY GOT — `finalSpawnEnv` is the
        // object handed to pty.spawn above — rather than re-deciding from the
        // question. "Does the variable exist" and "does the line reference the
        // variable" are the same question, so they must not be two answers that
        // happen to agree: asked of the raw string, a question made only of
        // control characters left the variable unset while the line still
        // referenced it, and `"$CCC_ASK_PROMPT"` on POSIX is QUOTED — an unset
        // variable expands to one EMPTY argument, not to none. That is
        // `claude -- ""`, the blank opening prompt the env route exists to avoid.
        askPrompt: finalSpawnEnv.CCC_ASK_PROMPT !== undefined,
      })
      launchWriteScheduled = true
      launchPendingSessions.add(sessionId)
      setTimeout(() => {
        // Liveness guard (see shell-only branch): the 300ms launch-write can race
        // a kill / Restart / app-quit; writing to a dead/replaced PTY from this
        // timer would crash main. Only write when our PTY is still registered.
        if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) { abandonLaunchHold(); return }
        try {
          ptyProcess.write(escapedCmd + '\r')
          releaseLaunchHold()
        } catch { abandonLaunchHold() /* session died mid-launch */ }
      }, 300)
    }

    ptyProcess.onData((data) => {
      if (win.isDestroyed()) return
      getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
      // Watchdog (#235): no-op when off or when this session never got a
      // watchdog started (shell-only sessions never do — see below).
      getWatchdogManager()?.feedData(sessionId, data)
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
  }

  ptySessions.set(sessionId, { ptyProcess, sessionId })
  updateSessionMeta({ id: sessionId, label: options?.configLabel ?? sessionId, cwd: options?.cwd, provider: options?.provider ?? 'claude' })
  // Watchdog (#235): local, interactive Claude sessions only — never SSH,
  // Codex, a bare shell (shellOnly), or an Ask Conductor one-shot (#266
  // MAJOR-5: an ephemeral ask surface must not grow a retry badge). No-op
  // when the feature is off.
  if (!options?.ssh && !options?.shellOnly && (options?.provider ?? 'claude') === 'claude') {
    getWatchdogManager()?.startWatchdog(sessionId, {
      provider: options?.provider,
      ssh: false,
      shellOnly: false,
      // Explicit kind flag (#266 MAJOR-5), never the askPrompt heuristic: that
      // was false for a question-less Ask launch and after every restart.
      ask: options?.isAsk === true,
      cols: options?.cols,
      rows: options?.rows,
    })
  }

  // Replay any buffered writes (from commands sent before PTY was ready). When a
  // launch line is queued, its timer owns the replay so the buffered write lands
  // in the process the user meant, not in the shell that is about to be replaced.
  if (!launchWriteScheduled) releaseLaunchHold()

  // Record the run via the transcripts worker pipeline (Logs v2). Gated on the
  // live `loggingEnabled` setting (default-true) and never for shell-only
  // sessions (full gating refinement = Task 9). The captured account (set at
  // line ~950 for non-shell Claude sessions) + configId/profileId are stamped
  // so runs can be filtered by config/account.
  const configLabel = options?.configLabel || 'default'
  // Reading settings here (rather than relying solely on the supervisor's
  // existence) gives a LIVE disable: if logging was enabled at boot (so the
  // supervisor is running) but the user later turns it off in Settings, new
  // runs are skipped immediately — the worker keeps running idle. Asymmetry: if
  // logging was DISABLED at boot there is no supervisor, so a mid-run enable
  // needs a restart.
  const settings = readConfig<{ loggingEnabled?: boolean }>('settings') ?? {}
  // Single source of truth for the run-registration decision (Task 9):
  // claude-local-only (not codex/other), not shell-only, not SSH, per-config
  // loggingEnabled !== false, global loggingEnabled !== false. The matching
  // runEnd/endRun on exit are gated on this same `logSup` being non-null, so a
  // run is only ended if it was registered.
  const logSup = shouldRegisterRun(options ?? {}, settings) ? getLogSupervisor() : null
  logSup?.runStart({
    sessionId,
    configId: options?.configId,
    configLabel,
    // FIX 4: the effective launch cwd (resume override when active, else the
    // configured resolvedCwd) — not the bare resolvedCwd.
    projectCwd: effectiveLaunchCwd,
    // accountEmail is typically undefined here: identity is captured asynchronously
    // AFTER spawn (recheckSessionIdentity / startWatchingAccountIdentity wired in
    // pty-manager). The run row therefore stamps a null email; configId and
    // profileId ARE stamped correctly at spawn. runAccount() back-fills the email
    // once the identity poll resolves (wired in a later task).
    accountEmail: getAccountIdentity(sessionId)?.email,
    profileId: resolvedProfileId,
    provider: options?.provider ?? 'claude',
    startedAt: Date.now(),
  })
  // Logs v2 (Task 8): arm the heuristic transcript-discovery fallback for this run.
  // The exact sources (hooks + statusline) bind first; if neither has bound ~20s
  // later, the binder scans ~/.claude/projects for the newest matching JSONL.
  // Gated on logSup (the consolidated shouldRegisterRun decision — already
  // claude-local-only, so no separate provider re-check) + a known cwd.
  if (logSup && effectiveLaunchCwd) {
    // FIX 4: register with the effective launch cwd so the 20s heuristic
    // fallback scans the folder Claude ran in (the resume override when active).
    const binder = getTranscriptBinder()
    binder?.registerRun(sessionId, effectiveLaunchCwd, Date.now())
    // Part A: DETERMINISTIC RESUME-BIND. When an exact-resume applied we already
    // know the conversation's uuid + the real launch cwd, so we can bind that
    // exact transcript IMMEDIATELY — no waiting for the hooks/statusline exact
    // sources or the 20s heuristic. This fixes the observed first-/resumed-session
    // `nt=0` race at boot (the exact sources lose to boot wiring; the heuristic's
    // one-shot didn't recover it). Routed through notifyTranscriptPath so the
    // existing debounce + idempotent canonicalize apply; a stale path just no-ops.
    if (binder && resumeUuidForBind) {
      const resumePath = buildResumeTranscriptPath(effectiveLaunchCwd, resumeUuidForBind)
      if (resumePath) {
        logInfo(`[binder] resume-bind sid=${sessionId} path=${resumePath}`)
        binder.notifyTranscriptPath(sessionId, resumePath)
      }
    }
  }

  // Debug capture only — the transcripts worker tails Claude's own transcript
  // files, so PTY bytes are no longer recorded for logging.
  ptyProcess.onData((data) => {
    if (isDebugModeEnabled()) {
      logPtyOutput(sessionId, data)
    }
  })

  // A PTY IS RUNNING FOR THIS ID — armed HERE, immediately beside the exit
  // handler that clears it, and deliberately NOT beside `updateSessionMeta`
  // above.
  //
  // Recorded separately from the metadata map because that map is also written
  // by github-handlers for sessions that never spawn, and the canvas ownership
  // lease needs the lifecycle fact rather than "somebody described this id".
  //
  // Recorded LATE because of what sits between: `spawnPty` runs from an
  // uncaught `ipcMain.on('pty:spawn')`, and the ninety-odd lines after the
  // metadata write (config reads, run registration, the data hook) can throw.
  // A throw there used to leave the id marked live with no exit handler ever
  // armed to unmark it — stranding that session's canvas as un-resumable,
  // un-dismissable and invisible for the rest of the run, which is the exact
  // failure this signal exists to end. The mark and its only eraser are now
  // adjacent, so the window is one statement wide.
  markPtySessionAlive(sessionId)
  ptyProcess.onExit(({ exitCode }) => {
    logInfo(`[pty] PTY exited for session ${sessionId} with code ${exitCode}`)
    // Restart-race guard: the renderer's restart flow kills the old PTY
    // and re-spawns synchronously with the SAME sessionId. node-pty's
    // exit callback is async — by the time it fires, the new PTY has
    // already written its settings file, registered its hook secret,
    // and replaced the ptySessions entry. If we ran the old exit's
    // cleanup unconditionally we'd:
    //   - delete the NEW PTY's settings file → claude --settings fails
    //     with "Settings file not found" on the new spawn
    //   - unregister the NEW PTY's hook secret in the gateway → 404s
    //   - delete the ptySessions entry pointing at the new ptyProcess
    // Identity-check the map: only run cleanup when the entry still
    // points at OUR ptyProcess (or there's no entry at all).
    const current = ptySessions.get(sessionId)
    const weAreCurrent = !current || current.ptyProcess === ptyProcess
    if (weAreCurrent) {
      // item 5 (resume cascade): an SSH session whose ssh process exited before
      // reaching claude-running failed to connect -- tell the overlay so it can
      // offer Retry (never strand). Runs only while the flow still exists (a
      // deliberate close destroys it first). CRITICAL: this MUST sit inside the
      // weAreCurrent guard. sshFlows is keyed by sessionId only, so on a restart
      // it holds the NEW flow while the OLD pty exits; poking it here (as the
      // first cut did, above this guard) flipped a healthy just-respawned session
      // to failed('connection'), and the overlay's only escape was Retry -> the
      // same restart -> the same stale exit, wedged forever (adversarial review,
      // 2026-08-18, BLOCKER). When we are NOT current a newer spawn owns the flow;
      // its own onExit handles its own drops.
      if (sshFlows.has(sessionId)) {
        try { getSshFlow(sessionId)?.handlePtyExit() } catch { /* best-effort */ }
      }
      ptySessions.delete(sessionId)
      clearSessionMeta(sessionId)
      // ...and the PTY is gone. Paired with the spawn-side mark above; a
      // canvas this session owned becomes ownerless from here, which is what
      // makes it resumable again.
      markPtySessionGone(sessionId)
      // Close the run (the worker final-drains + retires its transcript tails).
      // Gated on weAreCurrent so the restart-race stale exit can't end the
      // just-respawned session's run. No-op when logging is disabled / this
      // session was never recorded (logSup null).
      logSup?.runEnd(sessionId, Date.now(), exitCode === 0 ? 'exited' : 'crashed')
      // Logs v2 (Task 8): cancel any pending heuristic timer + clear the binder's
      // per-session bind state so a reused sessionId (restart) binds fresh.
      getTranscriptBinder()?.endRun(sessionId)
      // #536: retire any remembered CCC name so a renamed-but-never-bound session
      // does not leak an entry in the pending-name registry for the process life.
      forgetSessionName(sessionId)
      getPtyIntegrityMonitor()?.endSession(sessionId)
      // (watchdog teardown now lives UNCONDITIONALLY in cleanupSessionResources
      //  below — see FINDING 1 — so the restart-race stale exit tears it down too)
      try {
        const gwExit = getGateway()
        if (gwExit) gwExit.unregisterSession(sessionId)
      } catch { /* gateway may have already stopped during shutdown */ }
      removeLocalSessionSettings(sessionId)
      removeLocalSessionMcpConfig(sessionId)
      // P6: clear opt-in registration and per-session usage record.
      unregisterCodexReviewSession(sessionId)
      disposeCodexReviewUsage(sessionId)
      // Locality fix: stop the Codex telemetry tail poller + drop the four
      // per-session write buffers (pasteQueues / pendingWrites / recentWrites /
      // sshOscBuffers) and the SSH flow on NATURAL exit too — previously only
      // killPty did this, so a session whose process exited on its own (Codex
      // exit/quit, crash) leaked the 2Hz full-file telemetry read + its maps
      // until the tab was closed.
      cleanupSessionResources(sessionId)
      // P8.8: clear spawn-time identity capture. Safe no-op for non-codex sessions.
      clearCodexSpawnIdentity(sessionId)
      // Phase R: clear spawn-time Claude account capture so the map can't grow unbounded.
      // Capture the watched profileId BEFORE stopWatching clears it.
      const exitProfileId = getWatchedProfileId(sessionId)
      clearClaudeAccount(sessionId)
      stopWatchingAccountIdentity(sessionId)
      // Bug 2: snapshot any token refresh from the shared profile home into the
      // account's canonical backup. Email-guarded, so a mid-session /login that
      // switched the home to a different account can never corrupt canonical.
      // No-op for default (no-profile) sessions.
      if (exitProfileId) { try { backupProfileHomeToCanonical(exitProfileId) } catch { /* best-effort */ } }
      // Auth-outside-CCC fix: this session may have rotated the primary account's
      // OAuth token; push the freshest token back to the real global ~/.claude so an
      // external `claude -p` keeps working. Freshest-wins + email-guarded; no-op when
      // the exiting session wasn't the primary account.
      try { syncPrimaryCredentialsWithGlobal() } catch { /* best-effort */ }
      // Bug 4: release this session's pinned vision browser target/context.
      try { teardownVisionSession(sessionId) } catch { /* best-effort */ }
      // Canvas link state (the cwd / resume uuid / profile used to LABEL and
      // order the reclaim list). `forgetSessionForCanvas` had no caller at all
      // until now, so spawnInfo grew for the life of the install and a dead
      // session's project directory kept ordering other sessions' reclaim
      // lists (adversarial review, 2026-08-15).
      //
      // It is HERE and not in cleanupSessionResources on purpose: the entry is
      // written by the pty:spawn IPC handler BEFORE spawnPty runs, and spawnPty
      // opens with killPty → cleanupSessionResources, so clearing it there
      // would wipe every restart's stamps a moment after they were set. This
      // block only runs when no newer PTY has taken the session over — i.e.
      // when the PTY really is gone for good, which is the contract the
      // function documents.
      forgetSessionForCanvas(sessionId)
    } else {
      logInfo(`[pty] Stale exit for ${sessionId} — newer PTY has taken over, skipping cleanup`)
    }

    if (win.isDestroyed()) {
      logDebug(`[pty] Window already destroyed, skipping exit notification for ${sessionId}`)
      return
    }
    win.webContents.send(`pty:exit:${sessionId}`, exitCode)
  })
}

// Large writes to WinPTY/ConPTY can overflow the console input buffer,
// causing truncation. Only chunk large writes (pastes); keystrokes go straight
// through. Constants + the crash-safe loop live in pty-chunked-write.ts (pure,
// unit-tested without the pty-manager dependency graph).
function writeChunked(sessionId: string, ptyProcess: pty.IPty, data: string): void {
  // R-010: re-check liveness each chunk (a respawn replaces the PTY under the
  // same sessionId) and try/catch the write inside the helper, so a write to a
  // killed/replaced PTY from the timer can never throw an uncaught exception in
  // main. Mirrors writeEnvelopeChunked.
  runChunkedWrite(data, {
    write: (slice) => ptyProcess.write(slice),
    isAlive: () => ptySessions.get(sessionId)?.ptyProcess === ptyProcess,
  })
}

// Per-session FIFO paste queues for channel envelopes (P3.1).
const pasteQueues = new Map<string, PasteQueue>()

// Guard-free chunked write (channel envelopes carry a unique ts: and must not
// be deduped). Mirrors writeChunked's 256-byte/12ms cadence.
function writeEnvelopeChunked(sessionId: string, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Capture THIS pty up front and route through the R-010-tested
    // runChunkedWrite with an identity-guarded isAlive, so a respawn (new PTY
    // under the same sessionId) can't receive the tail of a half-written
    // envelope (P1.5 — mirrors writeChunked). onDone resolves the queue's writer.
    const proc = ptySessions.get(sessionId)?.ptyProcess
    if (!proc) return resolve()
    runChunkedWrite(data, {
      write: (slice) => proc.write(slice),
      isAlive: () => ptySessions.get(sessionId)?.ptyProcess === proc,
      onDone: resolve,
    })
  })
}

// Public API for the bus. Enqueues a fully-wrapped envelope for delivery.
// Returns dropped-count (>0 means overflow occurred).
export function pastePty(sessionId: string, envelope: string): number {
  let q = pasteQueues.get(sessionId)
  if (!q) { q = new PasteQueue((d) => writeEnvelopeChunked(sessionId, d), 16); pasteQueues.set(sessionId, q) }
  return q.enqueue(envelope)
}

// Track recent SUBMITTED writes per session to detect + suppress accidental double-sends.
// A prompt being submitted twice causes two Claude API calls and can trigger rate limits.
//
// Only writes that end in \r or \n are considered — those are "submitted" payloads:
//   - Command button clicks (`fullCommand + '\r'`)
//   - Screenshot path sends (`path + '\r'`)
//   - Storyboard line-by-line output
//   - Right-click paste of multi-line text
//
// Individual keystrokes and escape sequences (arrow keys, function keys, Unicode chars,
// ANSI sequences) do NOT end in \r and pass through unchanged — so terminal navigation,
// rapid typing, and non-Latin input work normally.
const DEDUPE_WINDOW_MS = 300
const recentWrites = new Map<string, { data: string; ts: number }>()

function isSubmittedPayload(data: string): boolean {
  // Multi-byte payload that ends in \r or \n — treat as an atomic "submit"
  if (data.length < 2) return false
  const last = data.charCodeAt(data.length - 1)
  return last === 13 /* \r */ || last === 10 /* \n */
}

export function writePty(sessionId: string, data: string): void {
  // Focus-report chunks (RC8): xterm emits the DECSET-1004 focus events
  // (\x1b[I focus-in, \x1b[O focus-out) as standalone writes when a session
  // pane gains or loses focus — i.e. on every session click/switch, for BOTH
  // sides of the switch. Claude Code's TUI enables 1004 and answers with a
  // small redraw, which must not count as the session "waking" from silence.
  // Arm the watchdog's activation grace so that redraw is excluded from sleep
  // bookkeeping. EXACT match only (user keystrokes and pastes never arrive as
  // exactly one of these two chunks), and the write itself is never altered,
  // blocked, or delayed by this.
  if (data === '\x1b[I' || data === '\x1b[O') {
    getWatchdogManager()?.noteRedrawTrigger(sessionId)
  }
  // Dedupe guard: suppress identical repeats of submitted payloads within a short window.
  // This protects against double-sends from double-clicks, React effect races, event
  // listeners firing twice, etc. Only applies to "submitted" writes (ending in \r or \n)
  // so keystrokes and escape sequences are never blocked.
  if (isSubmittedPayload(data)) {
    const recent = recentWrites.get(sessionId)
    const now = Date.now()
    if (recent && recent.data === data && (now - recent.ts) < DEDUPE_WINDOW_MS) {
      // Do NOT log the payload content — it can contain user prompts,
      // credentials, or other sensitive text that we don't want in log files.
      // Only log the metadata needed to diagnose the source of the duplicate.
      logInfo(`[pty] DUPLICATE SUBMIT SUPPRESSED for ${sessionId} (${now - recent.ts}ms apart, ${data.length} bytes)`)
      return
    }
    recentWrites.set(sessionId, { data, ts: now })
  }

  try {
    const session = ptySessions.get(sessionId)
    // The PTY can exist while still being the bare shell (see
    // launchPendingSessions): writing now hands the text to THAT shell.
    if (session && !launchPendingSessions.has(sessionId)) {
      if (data.length > WRITE_CHUNK_SIZE) {
        writeChunked(sessionId, session.ptyProcess, data)
      } else {
        session.ptyProcess.write(data)
      }
    } else if (sessionId === '__cli_setup__') {
      writeCliSetupPty(data)
    } else {
      // Buffer: either there is no PTY yet (partner terminal command clicked
      // before it was ready) or there is one but it is still the bare shell
      // waiting for its launch line. The two are different states and the log
      // says which, because "not yet spawned" against a live PTY reads as a bug.
      const held = launchPendingSessions.has(sessionId)
      const pending = pendingWrites.get(sessionId) || []
      pending.push(data)
      pendingWrites.set(sessionId, pending)
      logInfo(
        `[pty] Buffered write for ${sessionId} (${held ? 'launch line still pending' : 'PTY not yet spawned'}, ${pending.length} pending)`,
      )
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      ptySessions.delete(sessionId)
    } else {
      throw err
    }
  }
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  try {
    ptySessions.get(sessionId)?.ptyProcess.resize(cols, rows)
    getPtyIntegrityMonitor()?.recordResizeApplied(sessionId, cols, rows)
    // Keep the watchdog's rendered pane wrapping like the real one (#266).
    getWatchdogManager()?.noteResize(sessionId, cols, rows)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      ptySessions.delete(sessionId)
    }
    // ignore all resize errors
  }
}

/**
 * Per-session resource + map hygiene shared by killPty (explicit kill) and the
 * natural-exit onExit cleanup block. Idempotent — every step is a no-op when the
 * entry is already absent — so it is safe to run on both paths (a user-kill fires
 * killPty AND later the async onExit with weAreCurrent, and a natural exit fires
 * only onExit). Consolidating here is what fixes the locality minors: codex
 * telemetry + the four per-session buffers (pendingWrites / recentWrites /
 * sshOscBuffers / pasteQueues) used to be cleaned only by killPty, leaking on
 * naturally-exiting sessions.
 */
function cleanupSessionResources(sessionId: string): void {
  pendingWrites.delete(sessionId)
  launchPendingSessions.delete(sessionId)
  recentWrites.delete(sessionId)
  sshOscBuffers.delete(sessionId)
  // #242 finding I1: drop ALL of this session's sentinel buffers alongside its
  // OSC sibling above -- same per-session-map shape, same leak risk if omitted.
  // All three kinds, not just 'setup': a session can die with its stage or arch
  // sentinel still unresolved, and a per-kind clear only runs on resolve.
  clearAllSshLineBuffers(sessionId)
  // #242 finding F1 (b): drop this session's nonce so it can never leak into
  // a future, unrelated spawn reusing the same sessionId.
  sshNonceBySession.delete(sessionId)
  // item 4: the SSH connection target + tmux-persistence flag are DELIBERATELY
  // NOT cleared here -- cleanupSessionResources runs on a natural PTY exit (a
  // transient drop) too, where the tab stays and a later End must still reach
  // the host. They are cleared only on deliberate close, in killPty (a respawn
  // overwrites them, so a stale entry from an exited-but-open session is bounded
  // and self-healing). See the maps' doc comment (adversarial review 2026-08-18).
  pasteQueues.get(sessionId)?.cancel() // stop draining + drop pending before dropping the ref (P1.5)
  pasteQueues.delete(sessionId)
  // Delete the per-session statusline status file so the watcher's poll
  // fan-out stays bounded between boot sweeps (the reaper only unlinks
  // files older than 3 days).
  cleanupStatusFile(sessionId)
  // Drop the session's background-context state (subagent depth + main
  // transcript anchor) so those maps don't grow for the life of the install.
  forgetSession(sessionId)
  // T8b: drop any captured resume target so it can't leak into a future,
  // unrelated spawn of the same sessionId. The respawn path captures fresh
  // BEFORE calling killPty, so the just-captured target survives this clear.
  clearLastResumeTarget(sessionId)
  // Stop Codex telemetry source if one was registered for this session. On a
  // natural Codex exit (user typed exit/quit, Ctrl+D, crash) this is the ONLY
  // place that stops the 500ms full-file-read tail poller — killPty isn't hit
  // until the tab is closed, so without this the poller ran for the dead tab.
  const codexTel = codexTelemetrySources.get(sessionId)
  if (codexTel) {
    try { codexTel.stop() } catch { /* noop */ }
    codexTelemetrySources.delete(sessionId)
  }
  // Clear the SSH flow controller too -- otherwise a stale entry keeps
  // a closure over the old ptyProcess and a renderer click after
  // session restart would write to a dead pty.
  const flow = sshFlows.get(sessionId)
  if (flow) {
    try { flow.destroy() } catch { /* noop */ }
    sshFlows.delete(sessionId)
  }
  // SECURITY (adversarial review, #188): deregister codex_review here so
  // registration is strictly RE-ESTABLISHED per spawn. spawnPty calls killPty
  // (→ this) before it re-registers, so a session that restarts into a
  // home-rooted, SSH, shell-only or Codex state cannot INHERIT the stale
  // registration (and stale cwd) from a prior local-Claude spawn — which would
  // otherwise defeat the home-dir refusal and the "SSH never registers"
  // invariant. Idempotent: a no-op when the session was never registered.
  unregisterCodexReviewSession(sessionId)
  // SECURITY (adversarial review, 2026-08-15 — BLOCKER 1): the canvas serving
  // allowlist dies with the session, for the identical reason. The first cut
  // had NO production revocation at all — a root registered by any local spawn
  // stayed servable for the life of the app process, so a session that exited
  // hours ago still contributed a readable project to whichever agent was
  // running now. Re-established per spawn (spawnPty calls killPty → here before
  // it re-registers), so a session that restarts into a home-rooted, SSH,
  // shell-only or Codex state inherits nothing.
  revokeCanvasUatRoots(sessionId)
  // SECURITY (adversarial review, FINDING 1): tear the session watchdog down
  // here too, for the identical per-spawn isolation invariant. This runs from
  // BOTH killPty (restart / deliberate close) and the natural-exit cleanup, and
  // UNCONDITIONALLY — unlike onExit's own stopWatchdog, which sat under the
  // weAreCurrent guard that a restart's stale exit skips. Without this, a
  // watchdog armed by a local-Claude spawn survived a same-sessionId restart
  // into a Codex / SSH / shell-only session and could send() its retry into that
  // new PTY (shell-only + a custom retryMessage = arbitrary command execution).
  // spawnPty calls killPty → here before the new spawn arms its own, so the new
  // session inherits no watcher. Idempotent (no-op when none was running).
  try { getWatchdogManager()?.stopWatchdog(sessionId) } catch { /* best-effort teardown */ }
}

// U8: grace before killing an SSH PTY so the in-band remote-cleanup command has
// time to reach the remote shell and run before we tear the tunnel down.
const REMOTE_CLEANUP_GRACE_MS = 400

export function killPty(sessionId: string): void {
  const entry = ptySessions.get(sessionId)
  // Read persistence BEFORE cleanupSessionResources runs (it no longer clears
  // these, but killPty does, at the end).
  const tmuxPersistent = sshTmuxWrappedBySession.has(sessionId)
  if (entry) {
    logInfo(`[pty] Killing PTY for session ${sessionId}${tmuxPersistent ? ' (tmux-persistent: detach only)' : ''}`)
    if (sshFlows.has(sessionId) && !tmuxPersistent) {
      // U8: sweep the per-session files we planted on the remote, in-band down the
      // still-live PTY, then kill after a short grace so the `rm` runs before the
      // tunnel dies. No SSH creds retained. A crash / natural exit can't do this
      // (the tunnel is already gone), which is acceptable -- the files are inert.
      // ptySessions.delete below means the delayed kill's onExit no-ops.
      //
      // Only for a NON-persistent SSH session. For a tmux-WRAPPED one the remote
      // survives this teardown, so (a) the foreground is Claude and this line
      // would land in its composer and stay pre-typed (LF doesn't submit), and
      // (b) the sidecars must either survive (Leave running -- Claude still uses
      // them) or be removed by the End-remote exec (which does its own rm). So we
      // write nothing and just detach (adversarial review, 2026-08-18).
      const proc = entry.ptyProcess
      try { proc.write(buildRemoteSessionCleanupCommand(sessionId)) } catch { /* best-effort */ }
      setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, REMOTE_CLEANUP_GRACE_MS)
    } else {
      // Non-SSH, or a tmux-persistent SSH session (killing the local PTY detaches
      // the tmux client; the remote survives for reattach on relaunch).
      try { entry.ptyProcess.kill() } catch (err) {
        logError(`[pty] Error killing PTY ${sessionId}:`, err)
      }
    }
    ptySessions.delete(sessionId)
  }
  cleanupSessionResources(sessionId)
  // Deliberate close: NOW drop the end-target + persistence flag (see the maps'
  // doc). A natural exit reaches cleanupSessionResources but not here, so the
  // target survives a transient drop for a later End.
  sshTargetBySession.delete(sessionId)
  sshTmuxWrappedBySession.delete(sessionId)
}

export function killAllPty(): void {
  logInfo(`[pty] Killing all PTYs (${ptySessions.size} active)`)
  for (const [id] of ptySessions) {
    killPty(id)
  }
}

/**
 * Gracefully exit a Claude session by sending /exit command.
 * Returns a promise that resolves when the PTY exits, or rejects on timeout.
 */
export function gracefulExitPty(sessionId: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = ptySessions.get(sessionId)
    if (!entry) {
      resolve() // Already gone
      return
    }

    // Attach exit listener BEFORE writing to avoid race condition
    entry.ptyProcess.onExit(() => {
      clearTimeout(timeout)
      ptySessions.delete(sessionId)
      resolve()
    })

    const timeout = setTimeout(() => {
      // Timeout - force kill
      logInfo(`[pty-manager] Graceful exit timeout for ${sessionId}, force killing`)
      killPty(sessionId)
      resolve()
    }, timeoutMs)

    // SSH tmux enhancement (item 4): a tmux-persistent remote must be DETACHED,
    // not exited, on app quit. `/exit` inside the tmux-wrapped pane quits Claude
    // and tears the remote session down -- defeating the persistence the header
    // pill just promised, on the most common exit path. Killing the local PTY
    // detaches the tmux client; the remote survives for reattach on relaunch
    // (adversarial review, 2026-08-18). The onExit listener above resolves.
    if (sshTmuxWrappedBySession.has(sessionId)) {
      logInfo(`[pty-manager] ${sessionId} is tmux-persistent -- detaching (no /exit) so the remote survives app quit`)
      try { entry.ptyProcess.kill() } catch { /* already gone */ }
      return
    }

    // Send Escape (cancel any pending input), then /exit
    entry.ptyProcess.write('\x1b')  // Escape
    setTimeout(() => {
      if (ptySessions.has(sessionId)) {
        entry.ptyProcess.write('\x03')  // Ctrl+C to interrupt anything
      }
    }, 100)
    setTimeout(() => {
      if (ptySessions.has(sessionId)) {
        entry.ptyProcess.write('/exit\r')
      }
    }, 300)
  })
}

/**
 * Gracefully exit all PTY sessions.
 * Returns when all have exited or timed out.
 */
export async function gracefulExitAllPty(timeoutMs = 5000): Promise<void> {
  const sessionIds = Array.from(ptySessions.keys())
  if (sessionIds.length === 0) return

  logInfo(`[pty-manager] Gracefully exiting ${sessionIds.length} sessions...`)
  await Promise.all(sessionIds.map(id => gracefulExitPty(id, timeoutMs)))
  logInfo('[pty-manager] All sessions exited')
}

/**
 * Get list of active session IDs
 */
export function getActivePtySessionIds(): string[] {
  return Array.from(ptySessions.keys())
}

// A session is writable for channel delivery iff a live PTY handle exists for
// it. The renderer status enum is UI-only; PTY presence is authoritative.
export function isSessionWritable(sessionId: string): boolean {
  return ptySessions.has(sessionId)
}
