/**
 * ssh-tmux-stage.ts — pure builder for tier 3 of the #242 tmux-detection
 * ladder: staging a static tmux binary onto a remote host that has NEITHER
 * a PATH tmux (tier 1) NOR a previously-staged `~/.claude/bin/tmux` (tier
 * 2, see the probe in ssh-shim.ts / generateRemoteSetupScript). Mirrors the
 * ssh-tmux.ts / ssh-args.ts pattern: a dependency-free string builder so the
 * exact shell fragment is unit-testable without the pty-manager dependency
 * graph, called from pty-manager once a `setup ok tmux=none` sentinel is
 * seen (tiers 4/5 — host-side base64 push, `--continue` degradation —
 * arrive in items 4/5 and are NOT implemented here).
 *
 * Two exports, mirroring `generateRemoteSetupScript` / `getRemoteSetupCommand`
 * in ssh-shim.ts:
 *   - `buildTmuxStageScript()` — the raw POSIX `sh` fragment (statements
 *     joined with `;`, not real newlines), readable text, for structural
 *     unit tests to assert against directly.
 *   - `buildTmuxStageCommand()` — what pty-manager ACTUALLY
 *     `ptyProcess.write()`s: the script above, base64-encoded and piped
 *     through `base64 -d | sh` inside an `stty -echo`/`stty echo` bracket,
 *     so the sentinel literals the script emits never appear in the
 *     terminal's echo of the command being typed (#242 round-3 MAJOR fix —
 *     see the doc comment on `buildTmuxStageCommand` itself).
 *
 * No default export (project convention).
 */

export type TmuxStageTarget = 'linux-x86_64' | 'linux-arm64' | 'macos-x86_64' | 'macos-arm64'

/**
 * Upstream release tag. Pinned, not `latest` — a floating tag means the
 * sha256 constants below (fetched against THIS exact tag) silently stop
 * matching whatever `latest` resolves to on the day tmux-builds cuts a new
 * release, degrading every future staging attempt to `fail=digest` with no
 * code change to explain why. A version bump is a reviewed diff: bump the
 * tag AND re-fetch/re-verify the four digests together.
 */
export const TMUX_STAGE_TAG = 'v3.7b'

/**
 * Per-arch sha256 digests for the tmux-builds v3.7b static build archives
 * (each archive contains a single top-level `tmux` file — verified by
 * listing one with `tar -tzf` during implementation).
 *
 * Source: GitHub's own per-release-asset `digest` field —
 *   https://api.github.com/repos/tmux/tmux-builds/releases/tags/v3.7b
 * (`assets[].digest`, format `sha256:<hex>`). That API field is GitHub's
 * own attestation, not a value tmux-builds' CI hands back — so it was
 * cross-checked (#242 implementation) by independently downloading BOTH
 * Linux artifacts and recomputing sha256 locally with
 * `Get-FileHash -Algorithm SHA256`; both matched the API's `digest` field
 * byte-for-byte. The macOS pair is taken from the same API field without a
 * second independent download (no macOS runner available here) — same
 * mechanism, same trust level as the two verified entries.
 */
export const TMUX_STAGE_SHA256: Record<TmuxStageTarget, string> = {
  'linux-x86_64': 'f85e6c1c412750a774eb3f370f33bad05fc726fb8b6a0b174ad6f0b6d954df58',
  'linux-arm64': 'b2955782695283fbc3682a2f77d65616f53b986ee3cf3d80618d3b1cb95b91a6',
  'macos-x86_64': 'ea90f0d8e8998cf5a3a5921e985685844a13a7c3b5779f36870bd98b7f147fe6',
  'macos-arm64': 'ee66dbcd49613eb41dc6b2f3abc5cd39d9135d67b7dfef1fdb180a3dbdc01f1e',
}

/**
 * Shared prefix for both outcome sentinels this fragment can emit:
 *   `ccc-tmux-stage ok path=<abs-path>`
 *   `ccc-tmux-stage fail=<reason>`
 * Exported so pty-manager's parser builds its regex off the SAME literal
 * rather than a second hand-typed copy that could drift (mirrors why
 * SAFE_TMUX_BIN_RE in ssh-tmux.ts is exported instead of re-declared at
 * each consumer).
 */
export const TMUX_STAGE_SENTINEL_PREFIX = 'ccc-tmux-stage'

/**
 * Shared URL parts for the tmux-builds v3.7b release asset -- factored out
 * so the REMOTE shell fragment (buildTmuxStageScript, where the arch suffix
 * is a shell variable resolved at runtime via uname) and the HOST-side
 * downloader (tmuxStageAssetUrl, called from pty-manager.ts's tier-4 push
 * with a concrete, already-known arch) can never independently drift on the
 * owner/repo, release tag, or filename template (#242 finding F6). Only the
 * arch suffix differs between the two call sites -- a TS string for the
 * host, a shell variable for the remote.
 */
const TMUX_RELEASE_OWNER_REPO = 'tmux/tmux-builds'
const TMUX_ASSET_FILENAME_PREFIX = `tmux-${TMUX_STAGE_TAG.slice(1)}-`
const TMUX_ASSET_FILENAME_SUFFIX = '.tar.gz'

function tmuxReleaseBaseUrl(): string {
  return `https://github.com/${TMUX_RELEASE_OWNER_REPO}/releases/download/${TMUX_STAGE_TAG}`
}

/**
 * The exact URL pty-manager.ts's tier-4 host-side downloader
 * (downloadAndCacheTmuxArchive) fetches for a given, already-known arch --
 * built from the SAME parts (owner/repo, tag, filename template) as the
 * remote curl/wget URL buildTmuxStageScript embeds as shell text, so the two
 * cannot silently drift apart (#242 finding F6). See ssh-tmux-push.test.ts's
 * regression test tying them together.
 */
export function tmuxStageAssetUrl(arch: TmuxStageTarget): string {
  return `${tmuxReleaseBaseUrl()}/${TMUX_ASSET_FILENAME_PREFIX}${arch}${TMUX_ASSET_FILENAME_SUFFIX}`
}

/**
 * Sink-side charset guard (#242 finding F8, defence-in-depth). Every other
 * shell/argv-facing sink in this codebase asserts its own inputs at the
 * point of interpolation rather than trusting an upstream check (see
 * assertSafeRemotePath in providers/claude/ssh-shim.ts, assertNotOptionLike/
 * isSafeTmuxBin in ssh-tmux.ts). Nothing untrusted flows into
 * TMUX_STAGE_TAG / TMUX_STAGE_SHA256 / TMUX_STAGE_SENTINEL_PREFIX today --
 * all three are module constants -- but a future edit that widens any of
 * them to a configurable or remote-derived value would otherwise sail
 * straight into remote shell text (this function) and into
 * parseTmuxStageSentinel's `new RegExp(...)` construction (pty-manager.ts)
 * with no gate at all. Throws (never silently coerces); writeTmuxStageCmd
 * (pty-manager.ts) already wraps buildTmuxStageCommand() in try/catch and
 * falls through to the bare launch, so a throw here is absorbed exactly
 * like any other build failure on this ladder.
 */
/**
 * #242 finding F1 (b), NONCE charset guard. `nonce` is host-generated
 * (`randomId()`, src/shared/id.ts -- lowercase hex only) but is interpolated
 * into remote shell text (this function's caller) AND into
 * parseTmuxStageSentinel's `new RegExp(...)` (pty-manager.ts) unescaped --
 * same hazard shape as TMUX_STAGE_SENTINEL_PREFIX below. Asserting the
 * charset here, at the one place both builders (stage + push) route through
 * before interpolating it, means a future caller that widens where the
 * nonce comes from can't silently reopen either hazard.
 */
export function assertSafeNonce(nonce: string): void {
  if (!/^[A-Za-z0-9]+$/.test(nonce)) {
    throw new Error(`Refusing to build tmux stage script: nonce "${nonce}" fails the charset guard (expected [A-Za-z0-9]+).`)
  }
}

function assertSafeTmuxStageConstants(nonce: string): void {
  if (!/^v[0-9A-Za-z.]+$/.test(TMUX_STAGE_TAG)) {
    throw new Error(`Refusing to build tmux stage script: TMUX_STAGE_TAG "${TMUX_STAGE_TAG}" fails the version-tag charset guard.`)
  }
  for (const [arch, sha] of Object.entries(TMUX_STAGE_SHA256)) {
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      throw new Error(`Refusing to build tmux stage script: TMUX_STAGE_SHA256["${arch}"] is not a 64-char lowercase hex sha256 digest.`)
    }
  }
  // Also guards the sentinel-prefix half of this finding: the SAME literal
  // is interpolated into parseTmuxStageSentinel's `new RegExp(...)`
  // (pty-manager.ts) unescaped -- a value outside this charset could change
  // that regex's meaning, not just this shell fragment.
  if (!/^[A-Za-z0-9_-]+$/.test(TMUX_STAGE_SENTINEL_PREFIX)) {
    throw new Error(`Refusing to build tmux stage script: TMUX_STAGE_SENTINEL_PREFIX "${TMUX_STAGE_SENTINEL_PREFIX}" fails the charset guard.`)
  }
  assertSafeNonce(nonce)
}

/**
 * Build the RAW tier-3 staging script — the POSIX `sh` fragment that
 * actually performs detection/download/verify/install/smoke-test. Exported
 * so the structural tests below (sha256 gate, version pin, terminfo probe,
 * etc.) can assert against readable shell text. NOT what pty-manager writes
 * to the PTY — see `buildTmuxStageCommand` below, which base64-wraps this
 * exact output before it ever reaches a live terminal.
 *
 * Steps, in order (each gates the next — no step runs on a prior failure):
 *   1. `uname -s` / `uname -m` -> one of the four tmux-builds targets.
 *      Unrecognised combo -> `fail=arch`, nothing downloaded.
 *   2. `curl -fsSL <url> -o <tmp> || wget -qO- <url> > <tmp>` — curl first
 *      (nearly universal, fails closed on HTTP errors with `-f`), wget as
 *      the fallback for images that ship it instead. Empty/missing result
 *      -> `fail=download`.
 *   3. sha256 the downloaded archive against the embedded per-arch digest.
 *      `sha256sum -c` (GNU/Linux) with a `shasum -a 256 -c` fallback (BSD /
 *      macOS, which has no sha256sum by default). Mismatch -> `fail=digest`,
 *      temp file removed, NOTHING installed — the install step below is
 *      reached only through this gate.
 *   4. Extract the single `tmux` member to a SIBLING temp file inside
 *      `$HOME/.claude/bin/` (`.tmux.$$`, same directory as the final
 *      destination so the later `mv` is same-filesystem/atomic), `chmod 755`
 *      IT (not the final path), and only `mv -f` it onto
 *      `$HOME/.claude/bin/tmux` once `tar` has reported success. Extract
 *      failure -> `rm -f` the sibling temp + `fail=extract`, leaving
 *      whatever was ALREADY at the install path (nothing, on a fresh host)
 *      completely untouched.
 *
 *      Fixes an adversarial-review BLOCKER-adjacent finding (#242 round 2,
 *      MAJOR): the previous shape (`tar -xzf ... -O tmux >
 *      "$HOME/.claude/bin/tmux"`) has the shell TRUNCATE the destination
 *      the instant the redirect opens, before `tar` has extracted a single
 *      byte — so a failed extract (bad archive, `tar` not supporting `-O`
 *      on some minimal image, etc.) left a 0-byte file sitting at the
 *      install path with whatever mode a PRIOR install had left it in. This
 *      app is explicitly a multi-session orchestrator (the whole point of
 *      CCC), so two SSH sessions to the same tmux-less host stage
 *      concurrently and would otherwise interleave writes into that one
 *      live path. Extracting to a sibling and `mv`-ing into place only on
 *      confirmed success means a losing/failing concurrent stage can only
 *      ever clobber ITS OWN temp file, never the other session's
 *      already-installed (or still-installing) binary.
 *   5. Smoke test: `tmux -V` (binary actually runs) then a DETACHED
 *      `new-session -d -s <name> true` — the shape that surfaces "missing
 *      or unsuitable terminal" on a bare/minimal container with no terminfo
 *      database, which `-V` alone would not catch (it never touches a
 *      terminal). Immediately `kill-session`s the probe on success. Smoke
 *      failure -> `rm -f` the just-installed binary, THEN `fail=terminfo`.
 *
 *      Fixes an adversarial-review BLOCKER (#242 round 2): the prior version
 *      left the chmod-755 binary in place on smoke failure, reasoning that
 *      "remove nothing silently" meant never removing it. That reading
 *      missed the actual hazard — the tier-2 probe in ssh-shim.ts
 *      (`fs.accessSync(path.join(claudeDir,'bin','tmux'), fs.constants.X_OK)`)
 *      checks EXECUTABILITY ONLY, never runs the binary, so it cannot see
 *      that this exact file fails the terminfo smoke test. Session 1 stages,
 *      smoke fails, `fail=terminfo`, falls through to a bare launch (fine).
 *      Session 2 (or session 1 reconnecting later) to the SAME host: tier 2
 *      finds the still-executable file, reports `setup ok tmux=...`,
 *      pty-manager wraps claude in it, and `buildTmuxLaunchCommand` (see
 *      ssh-tmux.ts) emits `<bin> new-session -A -s ccc-<sid> '<claude...>'`
 *      with NO `|| claude` fallback — tmux dies with "open terminal failed:
 *      missing or unsuitable terminal" and claude never starts, permanently,
 *      because staging never re-runs once tier 2 reports a hit. Removing the
 *      binary here is NOT the "remove nothing silently" the spec forbade —
 *      the sentinel is still echoed, so the failure is reported, just not
 *      left behind as a live landmine at the exact path the next session's
 *      probe trusts.
 *   6. Success -> `ok path=$HOME/.claude/bin/tmux` (shell-expanded, so the
 *      sentinel carries an absolute path — never a literal `~`, which
 *      `isSafeTmuxBin`'s allowlist in ssh-tmux.ts rejects outright).
 *
 * `nonce` (#242 finding F1 (b)): host-generated per-session random token
 * (randomId(), src/shared/id.ts), embedded in EVERY sentinel this script
 * emits (`ok`/`fail=*` alike). pty-manager's parseTmuxStageSentinel requires
 * an exact match before accepting any sentinel as this session's real
 * reply -- SECOND layer only: an attacker who can also READ the tty (this
 * line's own echo is not suppressed — see buildTmuxStageCommand's F7
 * correction below) can copy the nonce verbatim and defeat this layer. What
 * still holds in that case is NOT a path-pin on the reported value (#242
 * finding F1(a), round-2 correction: this tier's `ok path=` field is no
 * longer read for command construction AT ALL, by parser OR sink) -- it's
 * that `buildTmuxLaunchCommand` (ssh-tmux.ts) embeds a fixed
 * `STAGED_TMUX_BIN_EXPR` literal for a staged tier regardless of what this
 * script's sentinel reports, so there is no wire-reported operand left for
 * a tty-reader to substitute.
 */
export function buildTmuxStageScript(nonce: string): string {
  // #242 finding F8: sink-side guard, run before any of these constants are
  // interpolated into the remote-facing fragment below.
  assertSafeTmuxStageConstants(nonce)
  const releaseBase = tmuxReleaseBaseUrl()
  const parts = [
    `_u=$(uname -s 2>/dev/null)`,
    `_m=$(uname -m 2>/dev/null)`,
    `case "$_u-$_m" in ` +
      `Linux-x86_64) _sfx=linux-x86_64;; ` +
      `Linux-aarch64|Linux-arm64) _sfx=linux-arm64;; ` +
      `Darwin-x86_64) _sfx=macos-x86_64;; ` +
      `Darwin-arm64) _sfx=macos-arm64;; ` +
      `*) _sfx="";; ` +
    `esac`,
    `if [ -z "$_sfx" ]; then echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=arch"; else ` +
      `case "$_sfx" in ` +
        `linux-x86_64) _sha256=${TMUX_STAGE_SHA256['linux-x86_64']};; ` +
        `linux-arm64) _sha256=${TMUX_STAGE_SHA256['linux-arm64']};; ` +
        `macos-x86_64) _sha256=${TMUX_STAGE_SHA256['macos-x86_64']};; ` +
        `macos-arm64) _sha256=${TMUX_STAGE_SHA256['macos-arm64']};; ` +
      `esac; ` +
      // #242 finding F6: same PREFIX/SUFFIX constants tmuxStageAssetUrl(arch)
      // (host-side, called from pty-manager.ts's tier-4 downloader) builds
      // its URL from -- only `$_sfx` (a shell variable here, a TS-side arch
      // string there) differs between the two.
      `_url="${releaseBase}/${TMUX_ASSET_FILENAME_PREFIX}$_sfx${TMUX_ASSET_FILENAME_SUFFIX}"; ` +
      // MINOR fix (#242 round 2 adversarial review): the previous fallback
      // (`echo /tmp/ccc-tmux-stage.$$`) is a PREDICTABLE path in a
      // world-writable directory on a host without `mktemp` -- a co-tenant
      // on a shared box can pre-create that exact path as a symlink before
      // this runs, and `curl -o`/`wget -O` follow it, writing the download
      // through to wherever the symlink points AS the SSH user. Falling
      // back into `$HOME/.claude/bin/` instead (creating it first) keeps
      // the temp file inside a directory only this user can write to, the
      // same trust boundary the final install path already lives in.
      `_tmp=$(mktemp 2>/dev/null || { mkdir -p "$HOME/.claude/bin" 2>/dev/null; echo "$HOME/.claude/bin/.ccc-tmux-stage.$$"; }); ` +
      `(curl -fsSL "$_url" -o "$_tmp" 2>/dev/null || wget -qO- "$_url" > "$_tmp" 2>/dev/null); ` +
      `if [ ! -s "$_tmp" ]; then rm -f "$_tmp"; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=download"; else ` +
        `if command -v sha256sum >/dev/null 2>&1; then ` +
          `echo "$_sha256  $_tmp" | sha256sum -c - >/dev/null 2>&1; _dgok=$?; ` +
        `else ` +
          `echo "$_sha256  $_tmp" | shasum -a 256 -c - >/dev/null 2>&1; _dgok=$?; ` +
        `fi; ` +
        `if [ "$_dgok" != "0" ]; then rm -f "$_tmp"; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=digest"; else ` +
          `mkdir -p "$HOME/.claude/bin"; ` +
          // Extract to a SIBLING temp file in the same directory, not
          // straight at the install path -- `mv` (below) only replaces
          // the live path once tar has confirmed success, so a failed or
          // interleaved (concurrent-session) extract can never truncate or
          // corrupt an already-installed tmux (#242 round 2 MAJOR fix; see
          // the doc comment above).
          `_dst="$HOME/.claude/bin/.tmux.$$"; ` +
          `if tar -xzf "$_tmp" -O tmux > "$_dst" 2>/dev/null; then ` +
            `chmod 755 "$_dst"; mv -f "$_dst" "$HOME/.claude/bin/tmux"; rm -f "$_tmp"; ` +
            `_smoke="ccc-tmux-stage-smoke-$$"; ` +
            `if "$HOME/.claude/bin/tmux" -V >/dev/null 2>&1 && "$HOME/.claude/bin/tmux" new-session -d -s "$_smoke" true; then ` +
              `"$HOME/.claude/bin/tmux" kill-session -t "$_smoke" >/dev/null 2>&1; ` +
              `echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} ok path=$HOME/.claude/bin/tmux"; ` +
            `else ` +
              // #242 round 2 BLOCKER fix: remove the binary the tier-2
              // X_OK-only probe would otherwise keep finding and re-wrapping
              // claude in on every later session to this host (see the doc
              // comment above) -- the sentinel below still reports the
              // failure, so this is reported removal, not silent removal.
              `rm -f "$HOME/.claude/bin/tmux"; ` +
              `echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=terminfo"; ` +
            `fi; ` +
          `else ` +
            `rm -f "$_dst" "$_tmp"; echo "${TMUX_STAGE_SENTINEL_PREFIX} ${nonce} fail=extract"; ` +
          `fi; ` +
        `fi; ` +
      `fi; ` +
    `fi`,
  ]
  return parts.join('; ')
}

/**
 * Build the command pty-manager ACTUALLY writes to the remote PTY.
 *
 * #242 round-3 adversarial review, MAJOR FIX: `buildTmuxStageScript()`'s
 * output (above) contains its own sentinel literals in plaintext
 * (`ccc-tmux-stage ok path=...` / `fail=<reason>`). Writing that string
 * directly to a PTY (as the round-2 version of this module did) means the
 * remote tty's echo of the just-typed command -- not its eventual output --
 * satisfies `parseTmuxStageSentinel`'s own regex, because the echoed line
 * carries the exact same substrings. Depending on how the terminal wraps
 * that ~2KB line (proved with \r\n injected at 80/100/120/132/160/200-column
 * boundaries — see the regression test below), the echo either fails the
 * `isSafeTmuxBin` allowlist (fail-closed, but wrong reason) or the parser
 * mistakes it for the real completion sentinel outright -- either way
 * `stagingDone` latches, `STAGE_TIMEOUT_MS` is cleared, and `writeClaudeCmd()`
 * fires while curl is still mid-download: claude launches unwrapped and the
 * tmux persistence #242 exists to deliver is silently lost, logged
 * indistinguishably from a genuine download/digest/terminfo failure.
 *
 * Fix mirrors `getRemoteSetupCommand` (ssh-shim.ts:365-376), the repo's own
 * precedent for this exact hazard: base64-encode the fragment and pipe it
 * through `base64 -d | sh`, so the line the terminal echoes back while it is
 * being TYPED is opaque base64 (`[A-Za-z0-9+/=]` only -- it cannot contain
 * "ccc-tmux-stage", a space, or a line terminator, so no column-wrapping of
 * the echo can ever satisfy the sentinel regex). The REAL sentinel is written
 * by the decoded script's own `echo` once curl/tar/the smoke test actually
 * finish running -- that is genuine command output, arriving strictly after
 * the base64 line's echo, not a re-parse of the same bytes.
 *
 * #242 finding F7 correction: the `stty -echo … stty echo` bracket does NOT
 * hide the ~2KB blob's OWN line from the terminal, and never did -- `stty
 * -echo` is the FIRST statement of that SAME line, so by the time it takes
 * effect the tty has already echoed the entire line, base64 blob included,
 * back to the user. (An earlier version of this comment claimed otherwise.)
 * What actually keeps the blob's content invisible/meaningless is the
 * base64 opacity described above. The bracket earns its keep for a
 * DIFFERENT window: whatever the user types WHILE the piped `sh` is
 * decoding and running the script (a stray keypress mid-setup) is what it
 * suppresses; `stty echo` restores normal echo once that run finishes.
 */
export function buildTmuxStageCommand(nonce: string): string {
  const b64 = Buffer.from(buildTmuxStageScript(nonce)).toString('base64')
  return `stty -echo 2>/dev/null; echo '${b64}' | base64 -d | sh; stty echo 2>/dev/null`
}
