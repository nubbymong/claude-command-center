# SSH Session Redesign — Design Spec

**Status:** Draft · 2026-04-23
**Author:** nubbymong (co-authored with Claude)
**Supersedes:** current SSH branch of `src/main/pty-manager.ts` (lines ~324–485) which implements an implicit state machine via regex on streamed output plus six boolean latches.
**Related:**
- `docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md` (reverse-tunnel pattern + hook injection point)
- `docs/superpowers/specs/2026-04-23-account-rework-design.md` (per-host account tracking hooks into this spec's connect phase)

## Summary

Replace the regex-and-latch PTY controller with an **explicit state machine** driven by CCC-inserted sentinel markers. Every phase transition (connect → authenticated → shell-ready → docker-entered? → setup-deployed → health-checked → claude-running) is gated by a marker the remote deliberately emits, not a regex match on whatever Claude Code happens to print. Add a pre-launch `claude --version` health probe, a setup-payload fingerprint so we stop rewriting files the remote already has, and a unified `SessionLauncher` class that local and SSH paths both flow through. Structured errors per phase replace the current "swallow-stderr-with-2>/dev/null" approach so the user sees *why* a connect went sideways.

This is a correctness + reliability rewrite, not a UX redesign. The user-visible surface stays similar (same modal, same in-terminal experience), but the app stops leaking the setup blob into chats, stops misfiring on MOTDs, stops mis-typing passwords into container shells, and starts giving actionable errors when Claude Code is missing on the remote.

## Why

- Today's SSH flow relies on matching shell prompts and password prompts via regex on raw PTY output. We've patched regressions repeatedly:
  - MOTDs saying "password expires in 30 days" typed the password as stray input.
  - Claude Code's `❯` glyph got matched as a shell prompt and re-fired the setup blob mid-chat, leaking the base64 payload into the conversation.
  - The `setupDone` hard latch was added to paper over the re-trigger cases that slipped through prompt exclusions.
- Six independent boolean latches (`passwordSent`, `postCommandSent`, `sudoPasswordSent`, `claudeSent`, `postCommandShellReady`, `setupDone`) form an implicit state machine with no formal transition table. Adding the seventh (for Docker shell-ready, or hooks injection) means more coupling to regex detection — regressions waiting to happen.
- No health probe before launching Claude. If the remote lacks `claude` on PATH, the user sees `command not found` inside the chat surface, not a clean error in the session launch modal.
- The setup payload (shim + settings JSON + MCP entry) is rewritten every connect, even though the content is stable for the lifetime of an install. The remote has no way to say "I already have this version".
- Password-prompt handling times `setTimeout(..., 100ms)` before writing, hoping no MOTD bytes race in. This has been flaky on slower links (satellite, mobile hotspot).
- Error paths `2>/dev/null` swallow stderr so failed setup is completely invisible — the user sees a half-configured session with no explanation.
- Local + SSH session launches live in the same 400-line branching function. They share almost nothing but the shape of `pty.spawn`. Deduplication has been deferred; every bugfix lives twice.
- The hooks gateway spec needs to inject hooks into the per-session settings file on both local and SSH. Without a unified launcher we'd duplicate injection code on both sides; with one, both inherit.

## Non-goals

- **Not rebuilding the SSH wire protocol.** We still drive OpenSSH via `pty.spawn('ssh', [...])`. No in-house SSH client.
- **Not replacing node-pty.** The PTY stays; only the state machine on top of it changes.
- **Not managing SSH keys / hostkey files.** `StrictHostKeyChecking=accept-new` stays. We don't add a key manager.
- **Not rewriting the SSH config UI.** The `SshConfig` schema grows a couple of optional fields; existing configs keep working.
- **Not handling Kerberos / 2FA / interactive challenge-response.** Out of scope. If a prompt appears that doesn't match our known markers or the documented password prompt pattern, we display it to the user and let them type.
- **Not covering ssh-agent forwarding as a UI-visible toggle.** Works if the user's `ssh_config` has it; we don't add new flags.
- **Not migrating away from OpenSSH on Windows.** We stay with `ssh.exe` as ships with Windows 10+. No bundled client.

## Concepts

### Sentinel markers (CCC markers)

A **CCC marker** is a byte sequence we make the remote emit at a known phase, which only the remote could emit (because we just told it to), and which Claude Code will never print on its own. We use two forms:

1. **OSC sentinels** — same envelope as the existing statusline shim: `ESC ] 9999 ; CM<PHASE>= <payload> BEL`. These ride through the PTY without affecting what the user sees (we strip them before forwarding to xterm). Safe inside any shell output.
2. **Printed magic lines** — single-line ASCII like `__CCC_PHASE_SHELL_READY__bash` emitted by `printf` inside the remote script. Visible in the raw stream but stripped from the forwarded output before xterm renders it.

**Invariant (B2 fix):** printed markers may only be emitted during phases where the `SessionLaunchProgress` overlay is rendered (i.e. before `claude-running`). Any leak to xterm during overlay is visually hidden; any leak after overlay fades is a parser bug. OSC sentinels are the default choice — printed markers are used only when we need the `$SHELL` payload AND we cannot yet rely on OSC stripping (initial probe). The probe line is always executed as a command (not pasted text) so it never echoes verbatim back as content.

### Stateful marker parser (B1 fix)

`remote-marker-protocol.ts` exposes a **per-session** parser:

```ts
export interface MarkerParser {
  ingest(chunk: string): { cleaned: string; markers: CccMarker[] }
  flush(): string              // called on phase-timeout; emits any carry buffer as plain output (no silent byte loss)
  reset(): void                // called when the session ends / state machine reaches `claude-running`
}
```

Invariants the implementation must satisfy:

1. Maintains a rolling carry buffer of up to `MAX_MARKER_BUFFER` (default 8 KB, matching `MAX_OSC_BUFFER` already used by `extractSshOscSentinels`). Overflow drops the buffer with a warning log and emits its prefix as plain output — the same behaviour the OSC parser uses today.
2. Recognises both an OSC envelope and a printed-line envelope in the same streaming pass. A partial match at the end of a chunk is held in the carry buffer; the next chunk completes or breaks the match.
3. Matches printed markers as `__CCC_PHASE_<NAME>__[payload][\r]\n` — tolerates `\r\n` line endings. Matching is byte-for-byte on the prefix (`__CCC_PHASE_`) so SGR / bracketed-paste codes surrounding the marker line don't defeat detection; the surrounding codes are stripped from `cleaned` output.
4. Tests exercise marker splits at every single-byte boundary of the prefix (B1 cover requirement) and marker presence with adjacent colour codes / bracketed paste / CRLF (covers reviewer S4 zsh concern).
5. `flush()` is invoked when a phase timeout fires so the launcher never silently swallows bytes when a transition can't complete.

### State machine

States and permitted transitions (any state can also → `error` with a cause):

```
                 ┌────────────┐
          start →│ connecting │
                 └─────┬──────┘
                       │  ssh binary alive · banner received
                       ▼
                 ┌───────────────┐
                 │ authenticating│
                 └──────┬────────┘
                        │  password prompt detected + written      (password auth)
                        │  OR MOTD passes                          (key auth)
                        ▼
                 ┌───────────────┐
                 │ shell-ready   │──── shell-type identified (marker emit)
                 └──────┬────────┘
                        │  (branch)
          ┌─────────────┼─────────────┐
          ▼                           ▼
  postCommand is                postCommand is
  unset                         set (docker, kubectl, etc.)
          │                           │
          │                           ▼
          │                    ┌─────────────┐
          │                    │ running-post│
          │                    └──────┬──────┘
          │                           │  post-command shell prompt + any sudo dance done
          │                           ▼
          │                    ┌─────────────┐
          │                    │ post-shell  │ (docker-entered / similar)
          │                    └──────┬──────┘
          └────────────┬──────────────┘
                       │
                       ▼
                 ┌───────────────┐
                 │ setup-check   │── fingerprint probe: remote signature vs ours
                 └──────┬────────┘
                        │  match        ──→ skip deploy
                        │  mismatch/missing ──→ deploy-setup
                        ▼
                 ┌───────────────┐
                 │ setup-deployed│──── marker `CM SETUP OK`
                 └──────┬────────┘
                        ▼
                 ┌───────────────┐
                 │ health-check  │── `claude --version` run, captured version
                 └──────┬────────┘
                        │  healthy ──→ claude-launching
                        │  missing/broken ──→ error (with recovery actions)
                        ▼
                 ┌───────────────┐
                 │ claude-running│
                 └───────────────┘
```

State owns its timeout and its retry policy. Errors carry a `SessionError` struct (see §Error contract below).

### Single source of truth: `SessionLauncher`

A new `src/main/session/session-launcher.ts` owns:

- the state machine
- timers, retries, escalation
- calling into the shared building blocks (setup payload, hooks writer, statusline shim, account hooks)

Both **local** and **SSH** session spawns route through it. They differ in:
- which substates they exercise (local skips `authenticating`, `shell-ready`, `post-shell`, `setup-check`, `setup-deployed`)
- which commands they emit for each phase (local uses a child process, SSH uses `ptyProcess.write`)

Common code lives in the launcher; divergence lives in small strategy objects.

## Architecture

### New main-side files

| File | Purpose | Est LOC |
|------|---------|---------|
| `src/main/session/session-launcher.ts` | State machine + phase driver | ~350 |
| `src/main/session/session-types.ts` | `SessionLaunchState`, `SessionError`, `SessionLaunchProgress`, `LaunchStrategy` | ~80 |
| `src/main/session/ssh-strategy.ts` | SSH phase implementations (auth, shell-ready, post-command, setup-check, deploy, health, launch) | ~250 |
| `src/main/session/local-strategy.ts` | Local phase implementations (setup-check optional, health, launch). Wraps the existing local spawn path. | ~140 |
| `src/main/session/setup-fingerprint.ts` | SHA-256 hash of shim + settings payload; reader + writer for `~/.claude/.ccc-fingerprint` | ~60 |
| `src/main/session/remote-marker-protocol.ts` | Build + parse CCC OSC + printed markers; strip from forwarded output | ~120 |
| `src/main/session/claude-health.ts` | `runClaudeVersion(remoteRunner)` — returns `{ok, version, error}`; capability detection (supports `--settings`?) | ~100 |
| `src/main/session/docker-postcmd.ts` | postCommand execution; shell-type detection post-entry | ~80 |
| `src/main/session/setup-payload.ts` | Build setup script + settings JSON; currently baked into pty-manager, extract and test | ~150 |
| `src/main/session/session-error.ts` | Error class + recovery action registry | ~90 |
| `src/shared/session-launch-types.ts` | Cross-process types for progress reporting | ~50 |

Total new code: ~1570 LOC across 11 files. All ≤350 LOC.

### Pty-manager changes

`src/main/pty-manager.ts` keeps the `pty.spawn` plumbing and PTY data pipe. It **delegates state control** to the launcher:

```ts
export async function spawnSession(options: SpawnOptions): Promise<Session> {
  const launcher = new SessionLauncher({
    sessionId, win, options,
    strategy: options.ssh ? new SshStrategy(options.ssh) : new LocalStrategy(options),
    onProgress: (phase) => win.webContents.send(`session:progress:${sessionId}`, phase),
  })
  const pty = await launcher.start()   // returns only once claude-launching is reached OR shell-only done
  sessions.set(sessionId, { pty, launcher, /* ... */ })
  return sessions.get(sessionId)!
}
```

The PTY data handler routes through `launcher.ingest(data)` which:
1. Runs `remote-marker-protocol.strip` → returns `{ cleaned, markers }`.
2. Feeds `markers` to the state machine (emits next phase command where appropriate).
3. Sends `cleaned` to `win.webContents.send('pty:data:<sid>', ...)`.

The six legacy latches are replaced by a single `state: SessionLaunchState` variable inside the launcher.

### Removed legacy code

- `PASSWORD_PROMPT_RE`, `SHELL_PROMPT_RE`, `lastPromptLine` → deleted. Replaced by marker-driven detection.
- `setupDone` / `cdSent` / `postCommandSent` / `claudeSent` / `postCommandShellReady` / `sudoPasswordSent` / `passwordSent` booleans → subsumed by state enum.
- `stty -echo` + base64 + `2>/dev/null` blob → stays, but wrapped in a structured deploy function that emits `__CCC_SETUP_BEGIN__` / `__CCC_SETUP_OK__` markers and captures stderr to a remote tmp log we can fetch on failure.

### Renderer additions

| File | Purpose |
|------|---------|
| `src/renderer/components/session/SessionLaunchProgress.tsx` (new) | Replaces the black terminal during the first few seconds. Shows current phase, sub-step, and errors inline. |
| `src/renderer/stores/sessionStore.ts` (modify) | Hold `launchProgress: Record<sessionId, SessionLaunchProgress>`. Drain once state reaches `claude-running`. |
| `src/renderer/components/session/SessionErrorCard.tsx` (new) | Renders `SessionError.recoveryActions` as clickable buttons. |

The terminal stays hidden for ≤5 seconds (configurable). If the machine reaches `claude-running` faster, the card fades out. If the state machine stalls, the card shows the current phase and a manual override ("Show terminal anyway / Retry / Cancel").

### SshConfig additions

```ts
// src/shared/types.ts — SshConfig grows optional fields

export interface SshConfig {
  host: string
  port: number
  username: string
  remotePath: string
  hasPassword?: boolean
  postCommand?: string
  hasSudoPassword?: boolean
  startClaudeAfter?: boolean
  dockerContainer?: string

  // NEW — all optional, all defaulted
  connectTimeoutSec?: number        // default 30
  phaseTimeoutsMs?: Partial<Record<SessionLaunchPhase, number>>  // per-phase override
  disableSetupFingerprint?: boolean // force deploy every connect (diagnostics)
  forceShellType?: ShellType        // escape hatch if auto-detection breaks
  skipHealthProbe?: boolean         // for hosts where `claude --version` hangs
}
```

## Phase-by-phase behaviour

### connecting (0..connectTimeoutSec)

- `pty.spawn('ssh.exe', sshArgs)` (or platform equivalent). SSH args are built the same way as today but with `-o ConnectTimeout=<connectTimeoutSec>` and `-o ServerAliveInterval=30`.
- We also pass `-o LogLevel=ERROR` so verbose banners don't choke our phase detection.
- Progress event: `phase: 'connecting', host, port`.
- Transitions:
  - On first any-bytes received → `authenticating`.
  - On pty exit before any bytes + `ssh: connect to host ... port ...: ...` in stderr → `error` with `code: 'connect_failed'`.
  - On timeout → `error` with `code: 'connect_timeout'`.

### authenticating (≤30s default, configurable)

We detect *only* two paths in this phase, both with deliberate markers:

**Path A — key auth (the happy path):**
- We see the remote's MOTD or directly a shell prompt.
- We detect "shell readiness" by sending a probe command as described in the next phase, NOT by regex-matching the prompt here. We only transition out of `authenticating` when the probe returns a marker.

**Path B — password auth:**
- We send the `ssh` command, then wait for a line that ends in `password[:?]\s*$` AND contains no known MOTD shibboleths (the current PASSWORD_PROMPT_RE is fine for this narrow purpose — we're only gating a short window at startup).
- We send the password followed by `\r`.
- If a second password prompt appears within 5 seconds (wrong password), we emit `error` with `code: 'password_wrong'`. No second attempt.
- If after sending, we see a shell-ready probe response, transition to `shell-ready`.

**The probe mechanism:**

Once we think we've authenticated (either after sending the password OR after detecting a clean non-prompt-like line of output that could plausibly be a post-login shell), we send a single **probe command**:

```
printf '__CCC_PHASE_SHELL_READY__%s\n' "${SHELL:-unknown}"
```

The remote shell interprets that and prints our marker followed by the shell identifier. We match the marker exactly; receiving it means we are past authentication AND we have the shell's `$SHELL` string. The shell-type detection is folded into the same marker; no separate roundtrip.

If the probe is sent and we do NOT receive the marker within 10s, we re-send it once. Second miss → `error` with `code: 'authenticated_no_shell'` and a recovery action: "Try again with a fresh connection" / "Open a normal SSH session to verify the remote".

### shell-ready

- Parse the shell type from the marker payload (bash / zsh / ash / fish / dash / other). Store on the launcher state for downstream phases.
- Transition:
  - If `postCommand` is set → `running-post`.
  - Else → `setup-check`.
- Progress event emits `shellType` so the user sees it.

### running-post + post-shell (explicit timeout + Show-Terminal recovery — B7 fix)

- Execute the user-configured post-command verbatim. We do NOT chain it with our setup script. Post-command is the user's business; we watch for its exit.
- To know when post-command's target shell (e.g. docker container's bash) is ready, we emit another probe: `printf '__CCC_PHASE_POST_SHELL_READY__%s\n' "$(ps -p $$ -o comm= 2>/dev/null || printf "${SHELL:-unknown}")"` (S2 fix — `$SHELL` is the login shell, not the current one; `ps -p $$ -o comm=` returns the actual shell name with BusyBox-safe fallback).
- **Explicit phase timeout 30s** (configurable via `phaseTimeoutsMs['post-shell']`). On timeout → `error` with `code: 'post_shell_timeout'`, recovery actions: `[Retry, Edit post-command, Show terminal and let me drive manually, Cancel]`. "Show terminal" resolves the launcher with `state: 'claude-running (manual)'`, fades the overlay, and lets the user type into the PTY directly to finish setup — covers the "fat-fingered postCommand that never produces a shell" scenario without blocking the user.
- If the post-command expects a sudo password, the launcher recognises the narrow sudo prompt (`[sudo] password for X:`, `password for X:`) within a 30s window after sending the post-command. The password, if configured, is written exactly once.
- Once the probe marker arrives, transition to `post-shell`.
- `shellType` is re-detected because the docker container often runs a different shell (often busybox `ash`). Use the new shell type for the rest of the pipeline.

### setup-check (with per-host mutex — B4 fix)

- Before entering this phase, `SessionLauncher` acquires an in-process advisory mutex keyed by `hostSlug`. Concurrent sessions to the same host queue through `setup-check` + `setup-deployed`; once the first session finishes (success OR failure), the second reads the updated fingerprint and usually skips deploy entirely. The mutex is a simple `Map<hostSlug, Promise<void>>` in launcher module scope; release on phase exit (success / error / cancel).
- Run the fingerprint probe:
  ```
  printf '__CCC_PHASE_FINGERPRINT__%s\n' "$(cat ~/.claude/.ccc-fingerprint 2>/dev/null || printf missing)"
  ```
- Parse the payload. Compare against the fingerprint we compute for the current app version of the setup payload.
  - Match → transition to `health-check`.
  - Miss or `missing` → transition to `setup-deployed` (deploy).
- `disableSetupFingerprint: true` forces a deploy regardless.

### setup-deployed (cancel-safe, atomic — B5 fix)

- Build the full setup payload (shim + settings-<sid>.json + shared settings.json + MCP entries) via `setup-payload.ts`.
- Append an **atomic** fingerprint-write step at the end of the setup script: write to `~/.claude/.ccc-fingerprint.tmp.$$` then `mv -f` onto the target (prevents concurrent-deploy truncation). All other file writes inside the payload follow the same tmp-then-rename pattern.
- Wrap the base64'd blob in a cancel-safe envelope: `trap 'stty echo 2>/dev/null' EXIT INT TERM` at the top ensures echo is restored even if the PTY is killed mid-deploy.
  ```
  trap 'stty echo 2>/dev/null' EXIT INT TERM
  stty -echo 2>/dev/null
  __CCC_SETUP_LOG=$(mktemp)
  if echo '<base64>' | base64 -d | node 2>"$__CCC_SETUP_LOG"; then
    printf '__CCC_PHASE_SETUP_OK__\n'
  else
    printf '__CCC_PHASE_SETUP_ERR__\n'
  fi
  ```
- (Uses `if/then/else` not `&& ||` per reviewer N4 — the `&& ||` pattern fires `||` on any failure including the success `printf` returning 0 with a broken `test`.)
- Wait for `__CCC_PHASE_SETUP_OK__` (→ `health-check`) or `__CCC_PHASE_SETUP_ERR__` (→ `error` with `code: 'setup_failed'`). On error, we transparently fetch the remote tmp log via one subsequent `cat` + marker envelope so the renderer can show the remote stderr.
- Timeout: 60s default, configurable.
- **base64 portability probe** (S5): before emitting the deploy blob, the launcher pipes `printf '' | base64 -d >/dev/null 2>&1; echo $?` through the PTY. Non-zero exit means the remote's `base64` doesn't accept `-d`; we fall back to `openssl base64 -d` (widely available) or surface `shell_unsupported` if that also fails. Probe happens once per host and caches.
- **Cancel semantics** (answers previous Open Question): on `launcher.cancel()` during this phase we kill the PTY; the remote `trap` restores echo; any file writes in flight are either old-or-new never partial (atomic rename invariant). The next connect may find a stale fingerprint if the cancel happened after the shim/settings files were written but before the fingerprint was renamed — that's benign (fingerprint mismatch forces redeploy).

### health-check (with interrupt escalation — B6 fix)

- Run `claude --version` via the marker envelope:
  ```
  ( claude --version 2>&1
    printf '\n__CCC_PHASE_HEALTH_END__\n'
  )
  ```
- Capture the version string until the end marker. Parse.
- Transitions:
  - Version parsed → `claude-running`.
  - `command not found` → `error` with `code: 'claude_missing'`, recovery actions: "Install Claude Code on remote (opens docs)", "Change remote path".
  - Version string doesn't match expected shape → `error` with `code: 'claude_unexpected_version'`, recovery: "Show raw output", "Try anyway" (button proceeds regardless).
  - **Timeout escalation (10s default):** step 1: send `\x03` (Ctrl+C), wait 2s for the marker; step 2: send `\x03` again, wait 2s; step 3: kill the PTY entirely, surface `health_timeout` with recovery actions `[Retry, Skip health check (this session only), Cancel]`. Each escalation step is recorded in `LaunchDiagnostics` for support triage.
- **`skipHealthProbe` is session-scoped** (S13). Clicking the recovery action skips the probe for THIS launch only; the `SshConfig.skipHealthProbe` flag is reserved for power users editing the JSON directly. Previous spec wired the flag to persist via the recovery action — cut, because a transient timeout would then silently disable the probe forever.
- **`supportsSettings` detection (S7):** parsed from the version string via semver compare — any Claude Code ≥ 1.0.0 is known to accept `--settings`. The capability field is informational only for future version gating.

### claude-launching → claude-running

- If `useResumePicker` → launch the resume picker node script via the remote. Otherwise directly launch `claude` with `--settings <path>` + other flags.
- Wait for the first data chunk that *isn't* a CCC marker. That's the state transition to `claude-running`.
- From this point forward, the launcher stops driving phases. It only continues to strip markers and relay progress updates for health-pings (see "Background health ping" below).

### error

- Terminal stays hidden (or we show the terminal with an overlay, configurable).
- The `SessionLaunchProgress` event carries `state: 'error'` with `SessionError` details.
- `SessionErrorCard` renders the recovery actions. Clicking one either retries from the failing phase, re-enters the launcher with amended options, or cancels.

### Background health (post-launch)

Once `claude-running`, the launcher stops driving phases. The existing statusline OSC sentinel stream already signals liveness implicitly — if the shim goes silent for > 30s while the PTY is alive, we surface a small "statusline paused" hint in the session header. No separate TCP probe (cut per reviewer Scope1).

## Password-prompt handling (tightened)

- We only open a 15-second window after the initial SSH spawn in which we'll auto-type the password. After that window, even a password-shaped line is NOT autotyped. This prevents MOTD-delayed-echo races where the pattern appears many seconds later.
- We also require the prompt to be the last line in a chunk AND be shorter than 120 characters AND not contain words `expires|changed|old|reset|confirm|new` (heuristics from real MOTDs we've seen fire false positives).
- Sudo password (for postCommand) uses the same tightening.
- If the window expires or heuristic blocks the autotype, we surface an inline hint in the session header: "Type your password in the terminal when ready." No silent failure.

## Shell-type detection

We currently treat every remote shell as bash. In reality:
- Most Linux NAS devices: `bash` or `dash` (Debian default sh).
- BusyBox (embedded): `ash`.
- macOS: `zsh` (10.15+).
- Some custom setups: `fish`.

The probe marker includes `${SHELL:-unknown}`. We map it to:

```ts
type ShellType = 'bash' | 'zsh' | 'ash' | 'dash' | 'fish' | 'unknown'
```

For each detected shell, the setup-deployed phase selects a compatible script variant. In practice the current script uses POSIX-portable shell plus `node`; adjustments are small (fish doesn't accept `&&` the way bash does, so for fish we emit `; and ` instead). For `unknown`, we fall back to bash invocation: `bash -c '<script>'` (assuming bash exists; if not, `setup_failed` with `shell_unsupported`).

`forceShellType` in `SshConfig` overrides detection for the user who knows their remote shell.

## Setup payload fingerprinting

Purpose: stop rewriting the remote files every connect.

Fingerprint is `SHA256` of:
- The full setup script text (`setup-payload.ts`'s output).
- The per-session settings JSON we intend to write.
- A version prefix: `v1.3.2`.

Stored on remote as a single-line ASCII file at `~/.claude/.ccc-fingerprint`. Written atomically at the end of the deploy script (a successful deploy writes the fingerprint; a failed deploy does not).

Per-session settings files (`settings-<sid>.json`) are NOT part of the fingerprint (they differ per session). The fingerprint covers the *shared* installation state; per-session settings are always rewritten because they're cheap.

### Invalidation strategy

- App version change → fingerprint prefix changes → all remotes redeploy on next connect.
- User toggles `disableSetupFingerprint` → always deploy.
- User manually runs "Reset remote setup" (from per-host menu in Manage Hosts of the Account Rework spec) → delete `.ccc-fingerprint` on remote, forcing redeploy.

### Security concern

A malicious remote could write a fingerprint file claiming to match ours, tricking us into skipping deploy. Mitigation: we're not trusting this for security boundaries — if the remote is compromised, the user's Claude session is already at the attacker's mercy. The fingerprint is a correctness optimisation, not a trust anchor.

## Claude health probe

```ts
// src/main/session/claude-health.ts

export interface ClaudeVersionInfo {
  version: string              // "1.3.2" or "unknown"
  supportsSettings: boolean    // --settings flag accepted
  raw: string                  // verbatim output (truncated to 1KB)
}

export interface ClaudeHealthResult {
  ok: boolean
  info?: ClaudeVersionInfo
  error?: SessionError
}

export async function runClaudeVersion(
  runner: RemoteRunner,           // abstracts "send a command to the remote and collect output until marker"
  timeoutMs: number,
): Promise<ClaudeHealthResult>
```

`RemoteRunner` is a small interface the strategy implements; for SSH it wraps `ptyProcess.write` + marker-bounded output collection. For local, it simply executes the command in a short-lived child process.

The result is used to gate launch behaviour:
- `supportsSettings` false → fall back to the pre-`--settings` world (per-app `~/.claude/settings.json` with hooks + statusline only; accept collision with other concurrent sessions). Emit a one-time toast: "Your Claude Code version doesn't support --settings. Upgrade for full features."
- `ok: false` → error surface per §health-check above.

## Docker postCommand integration

Current state: `postCommand` is concatenated onto the setup command with `&&`. Post-command's target shell is detected by regex. If sudo is configured, the sudo prompt is handled by regex.

New state:

- Post-command runs as a distinct phase after `shell-ready`, NOT chained with setup.
- Setup is deployed **after** post-command (inside the container, if that's what postCommand does). **This fixes a longstanding issue where vision + statusline files lived in the wrong home directory for docker-entry setups.**
- We emit the `__CCC_PHASE_POST_SHELL_READY__` probe after the post-command finishes its own startup. If the post-command opens a container that drops us into bash, the probe hits bash inside the container. The launcher now has `shellType` for the container.
- Sudo: the narrow sudo-prompt detection window is only active during the `running-post` phase, and only if `hasSudoPassword` is true. Outside that window, `[sudo]` lines are NOT autotyped.

**Breaking-change mitigation (B3 fix):**

The earlier draft set `SshConfig.setupLocation` default to `inner` (meaning: deploy inside the container). That silently breaks every docker user whose container lacks `node` / `base64` / `bash`. Revised design:

- Before running the deploy blob, the launcher emits a one-line capability probe inside the post-shell: `command -v node >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 && printf '__CCC_PHASE_CAP_OK__\n' || printf '__CCC_PHASE_CAP_MISSING__\n'`.
- `__CCC_PHASE_CAP_OK__` → deploy inside the container as planned.
- `__CCC_PHASE_CAP_MISSING__` → silently fall back to `setupLocation: 'outer'`, meaning: exit the container back to the outer SSH shell, deploy there, then re-enter via the user's post-command a second time. Surface a one-time toast on the session: "Setup installed outside your container because `node` was not available inside. Edit host config to change." The fallback decision persists into `SshConfig.setupLocation` (`'inner' | 'outer' | 'auto'`, default `'auto'` on new configs; `'auto'` runs the probe, `'inner'` / `'outer'` are explicit overrides).
- Migration: existing `SshConfig` records without `setupLocation` get `'auto'` so they keep working.
- The recovery action "Use outer shell for setup" in `setup_failed` stays available as an escape hatch if the probe itself fails.

## Error contract

```ts
// src/main/session/session-error.ts

export type SessionErrorCode =
  | 'connect_failed'
  | 'connect_timeout'
  | 'password_wrong'
  | 'authenticated_no_shell'
  | 'post_command_failed'
  | 'sudo_failed'
  | 'setup_failed'
  | 'claude_missing'
  | 'claude_unexpected_version'
  | 'health_timeout'
  | 'health_failed'
  | 'shell_unsupported'
  | 'unknown'

export interface RecoveryAction {
  id: string
  label: string
  kind: 'retry' | 'retry-with-options' | 'open-docs' | 'show-details' | 'cancel'
  payload?: Record<string, unknown>  // passed back to the handler on click
}

export class SessionError extends Error {
  code: SessionErrorCode
  phase: SessionLaunchPhase
  stdoutTail?: string       // last 4KB of PTY output for debugging
  stderrLog?: string        // if applicable (from remote tmp log)
  recoveryActions: RecoveryAction[]
  originalError?: unknown
}
```

Every phase has a short list of recovery actions. Examples:

- `connect_failed` → `[Retry, Edit SSH config, Cancel]`
- `password_wrong` → `[Retry (re-prompt for password), Cancel]`
- `claude_missing` → `[Open install docs, Edit remote PATH, Skip health check and try anyway, Cancel]`
- `setup_failed` → `[Show remote log, Retry, Diagnostic mode (show terminal), Cancel]`

The `retry-with-options` kind lets the user tweak one variable before retrying (e.g. increase connect timeout to 60s). The renderer knows how to render the small input for each of these.

## Unified SessionLauncher

Interface:

```ts
// src/main/session/session-launcher.ts

export class SessionLauncher {
  constructor(opts: LauncherOpts)
  start(): Promise<ActivePty>        // resolves when state reaches claude-running (or shell-only completes)
  cancel(): Promise<void>            // cancels in-flight phases, kills PTY
  ingest(data: Buffer | string): void  // called by pty-manager's onData handler
  getState(): SessionLaunchState     // read current phase
  getDiagnostics(): LaunchDiagnostics // timing per phase, markers seen, errors
}
```

Strategies:

```ts
export interface LaunchStrategy {
  phases: SessionLaunchPhase[]       // the list and order of phases this strategy runs
  enter(phase: SessionLaunchPhase, ctx: LauncherCtx): Promise<void>
  // called as each phase begins; may emit commands, register timers, etc.
}
```

- `SshStrategy` implements all phases.
- `LocalStrategy` implements `connecting` (trivial), `setup-check` (optional), `health-check`, `claude-launching`, `claude-running`.

Both strategies share the marker protocol, fingerprint, health probe, and setup payload builder. The duplication with today's implementation disappears.

## Progress protocol

Renderer receives:

```ts
// src/shared/session-launch-types.ts

export interface SessionLaunchProgress {
  sessionId: string
  phase: SessionLaunchPhase
  subStep?: string             // e.g. "sending password"
  startedAt: number
  sinceMs: number              // ms since launcher.start()
  shellType?: ShellType
  claudeVersion?: string
  fingerprintMatched?: boolean
  error?: SessionError
}
```

Emitted on every transition and on sub-step updates (at most once per 200ms per session). Renderer stores the stream in `sessionStore.launchProgress[sessionId]`. `SessionLaunchProgress.tsx` reads it.

## Data flow walkthroughs

### Fresh SSH connect to a key-auth host (happy path)

1. User picks "docs repo on Asustor" + picker resolves.
2. `sessionStore.launch(config)` → `spawnSession()` → `new SessionLauncher({ strategy: SshStrategy })`.
3. `launcher.start()`:
   - `connecting`: `pty.spawn('ssh.exe', [...])`. First bytes arrive → `authenticating`.
   - `authenticating`: no password set, so we skip password-specific detection. Send probe. Marker arrives → `shell-ready`. `shellType: bash`.
   - No postCommand → `setup-check`. Send fingerprint probe. Remote responds `missing` (first connect). → `setup-deployed`.
   - `setup-deployed`: build payload, deploy. Marker `__CCC_PHASE_SETUP_OK__` arrives → `health-check`.
   - `health-check`: run `claude --version`. `1.3.2` parsed, `supportsSettings: true` → `claude-launching`.
   - `claude-launching`: emit `claude --settings ... --resume`. First non-marker output → `claude-running`. Launcher resolves.
4. Renderer's `SessionLaunchProgress.tsx` fades out. Terminal becomes visible.

### Second connect to the same host (happy path)

- `setup-check`: fingerprint matches → skip `setup-deployed`. Straight to `health-check` → `claude-running`.
- Saves ~2–3 seconds.

### Docker-entry SSH (postCommand = `docker exec -it my-dev bash`)

1. Connect + authenticate, reach `shell-ready` with `shellType: bash` (outer).
2. `running-post`: emit `docker exec -it my-dev bash` + probe. Wait up to 30s for post-shell marker.
3. `post-shell`: marker arrives, `shellType: ash` (busybox inside container).
4. `setup-check`: probe fingerprint inside the container. Miss → deploy. Success marker.
5. `health-check`: `claude --version` inside container.
6. Launch.

If the container lacks `node`, `setup_failed`. Recovery action: "Use outer shell for setup" flips `setupLocation: 'outer'` and retries.

### Wrong password

1. `authenticating`: marker-waiting window active.
2. Password prompt matches → write password.
3. Second password prompt within 5s → `error: password_wrong`.
4. Renderer shows SessionErrorCard: `[Retry, Cancel]`. Retry action prompts for a fresh password input (never re-uses the cached one).

### Claude Code missing on remote

1. `health-check`: `claude --version` → `command not found`.
2. `error: claude_missing`, recovery actions include "Install Claude Code on remote" (opens docs URL in system browser) and "Skip health check". Skip sets `skipHealthProbe` and retries — if user was wrong about Claude being installed, launch will still fail inside the PTY, but at least visibly.

### Setup fingerprint tamper (defensive scenario)

- Fingerprint on remote says "match" but files missing. Next time Claude launches, the missing files cause hooks or statusline to not function. This is the same failure mode as today; we add a small self-repair: if the shim's "I am alive" OSC sentinel doesn't arrive within 20s of `claude-running`, the launcher sets `disableSetupFingerprint` for the next connect (one-shot) and logs the event. User is not bothered.

## Testing

### Unit

- **remote-marker-protocol.test.ts** — strip & extract markers; handle split across PTY chunks; OSC + printed marker variants; no false positives on Claude Code's `❯`.
- **session-launcher.test.ts** — state transitions table-driven; per-phase timeouts fire; error recovery re-enters correct phase; cancel is idempotent.
- **setup-fingerprint.test.ts** — hashing stable across OS; writer atomic (no partial); reader handles missing file cleanly; version prefix invalidates cross-version.
- **claude-health.test.ts** — version parse for known outputs; `supportsSettings` detection (known flag message); timeout path; missing-binary path.
- **docker-postcmd.test.ts** — sudo prompt narrow detection window; shell-type re-detect after post-shell.
- **password-autotype-window.test.ts** — 15s window; MOTD-past-window is ignored; MOTD-shaped line with stopwords never autotyped.
- **ssh-strategy.test.ts** — phase emission commands correct per config (postCommand, startClaudeAfter, useResumePicker); argument building covers reverse-tunnel + ConnectTimeout.

### Integration

- **In-process synthetic remote** — a small Node script that emulates a shell: responds to probes with markers, pretends to run `claude --version`. Drive the launcher against it, assert the full happy path reaches `claude-running` in <2s.
- **Synthetic docker flow** — same approach with a two-layer shell emulator.
- **Synthetic failure matrix** — wrong password, missing claude, setup-failed, post-command-failed; assert each produces the right `SessionError` with the documented recovery actions.

### Manual smoke

1. Asustor SSH (key-auth, bash) — reach claude-running within 3s on second connect (fingerprint hit). First connect deploys and prints nothing leaked.
2. Linux VM with password auth — wrong password fails clean, correct password proceeds.
3. Docker-entry config on a Linux host — post-command + inside-container setup + launch.
4. BusyBox / Alpine remote — shell-type detected as `ash`, setup runs, claude launches if installed.
5. Mobile hotspot link (lossy) — ConnectTimeout raised to 60s, observe that the launcher still works without regex races.
6. Remote with `~/.claude` missing entirely — setup creates the directory and files. Fingerprint written.
7. Remote where `claude --version` hangs — health probe times out with recovery action; "Skip health check" fallback works.

### Mac validation gate (pre-merge)

- Confirm `ssh.exe` vs `/usr/bin/ssh` path handling — launcher should use `os.platform()` detection.
- Confirm `base64 -d` works on macOS (it does, but double-check with a macOS remote).
- Confirm marker protocol survives zsh's nonstandard prompt colours.
- macOS first-bind firewall prompt for reverse tunnels — no new prompts beyond what the hooks gateway spec already covers.

## Migration / compatibility

- Existing `SshConfig` records are forward-compatible (new fields optional).
- First connect after upgrade deploys a new setup payload (fingerprint changes due to version prefix), overwriting whatever was there.
- Session state (`SavedSession`) unchanged.
- No renderer-side state migration needed.
- If a user's remote has a custom `~/.claude/settings.json` they manually edited, the setup script rewrites the keys it owns (hooks, statusline reference, MCP entry). Other keys preserved via the same shallow-merge pattern the account-rework spec introduces. Document as an invariant: "CCC owns these keys in your remote's settings file."
- For docker-entry users, the behavioural change (setup deploys inside the container) is opt-out via `setupLocation: 'outer'` added to `SshConfig`. Default is `inner`.

## Performance

- First connect: same roughly 2–4s as today.
- Subsequent connects with fingerprint hit: ~1.5s faster (skip deploy + node execution).
- Health probe adds 100–300ms per connect. Acceptable.
- Marker stripping adds O(n) over PTY output with a small constant; benchmark target: <100µs per 64KB chunk. Achievable with a streaming parser + split-across-chunk handling.
- State machine overhead negligible (a state enum + a timer).

## Phasing (trimmed per reviewer)

One PR (`feat/ssh-session-redesign`) stacked on `feat/account-rework`. Internal phases for plan granularity:

1. **A · Extract building blocks**. Move setup payload, shell detection, base64 blob building into `src/main/session/*` files without changing behaviour. Green tests.
2. **B · `SessionLauncher` skeleton + marker protocol (stateful parser)**. Route `pty-manager` through the launcher; ship the stateful marker parser (B1). Implement `connecting`/`authenticating`/`claude-running` bridge with current regex as scaffolding. Tests for chunk-boundary splits included.
3. **C · Sentinel-marker state machine**. Add `shell-ready`, `setup-check`, `setup-deployed`, `health-check` with marker-driven transitions + per-host mutex (B4) + atomic renames (B5). Delete the regex path.
4. **D · Docker postCommand state integration**. Add `running-post`, `post-shell`, sudo handling with explicit post-shell timeout + Show-Terminal recovery (B7). Capability probe + `setupLocation: 'auto'` behaviour (B3).
5. **E · Setup fingerprinting**. Probe + skip-deploy + atomic fingerprint writer.
6. **F · Health probe with interrupt escalation (B6)**. `claude --version`, version-based `supportsSettings` parsing, recovery actions (session-scoped skip only).
7. **G · Password-window tightening + MOTD guards**. Replace the current regex test block with the 15s window + stopword-block + 2FA-exclusion list.
8. **H · `SessionErrorCard.tsx`**. Renderer UX for structured errors. Recovery actions that need variable tweaks open the existing SSH-config modal at the relevant field (rather than an inline mini-form — scope cut per reviewer Scope2).
9. **I · Hooks Gateway wiring**. Inject hooks via the unified setup payload in the launcher (single point, both local + SSH). Requires hooks PR merged.

**Cut from this PR** (deferred to v1.3.3):
- **Unified `LocalStrategy` / local spawn refactor** — the correctness goals are SSH-only; touching the local path is a refactor risk we don't need for v1.3.2.
- **`SessionLaunchProgress.tsx` happy-path overlay** — ship the `SessionErrorCard` in Phase H, defer the happy-path phase overlay so we're not changing "terminal visible immediately" UX mid-beta.
- **Background TCP health ping** after `claude-running` — hooks-gateway silence already covers tunnel breakage.
- **Self-repair fallback** (flipping `disableSetupFingerprint` on shim-silence) — low-incidence, adds a rarely-exercised branch.
- **`sshSessionLauncher.v2Enabled` feature flag** — maintaining both code paths doubles the review surface. The new path replaces the old directly.

## Risks

- **Breaking change surface**: existing users may hit edge cases we didn't see in testing. Mitigate by keeping the old path behind a feature flag `sshSessionLauncher.v2Enabled` for the first beta, default true. If regressions surface, users can flip back while we patch.
- **Marker collision**: an unusually adversarial `post-command` could print a CCC marker. Mitigation: use OSC sentinels (invisible) where we control the command; printed markers only during the narrow auth/probe windows where Claude Code hasn't launched yet. Unlikely to coincide.
- **Shell detection failure**: `$SHELL` may be unset on some embedded systems. Probe returns `unknown`. We default to bash invocation which covers almost all realistic cases. `forceShellType` is the escape hatch.
- **Remote `node` missing**: the setup script requires `node`. Same as today. No regression.
- **Fingerprint corruption**: a truncated fingerprint file on the remote causes a skip-deploy-with-stale-state. Mitigation: self-repair via the "shim didn't say hello" fallback flips `disableSetupFingerprint` for one connect.
- **Password autotype window mis-sized**: 15s may be too short on very slow links or hosts that display a large MOTD. Make `phaseTimeoutsMs.authenticating` configurable per host.
- **Renderer `SessionLaunchProgress` UI surprise**: users accustomed to the terminal appearing immediately may be confused. Mitigate with a "Show terminal anyway" button that toggles the overlay off, and a setting `hideSessionLaunchProgress` for power users.
- **Tests take longer**: integration tests now run a synthetic shell emulator. Keep per-test wall clock under 5s; the whole suite under 30s.
- **Marker bleed into user screen**: any bug in the stripper leaves a `__CCC_PHASE_*__` line in the terminal. Cover with a snapshot/diff test that asserts no CCC string reaches xterm for any of the documented happy paths.
- **Locale-driven shell prompts**: bash under `LANG=de_DE.UTF-8` prints localised messages. We no longer match on shell prompts at all — we match on our own markers — so locale is irrelevant.
- **Interaction with account-rework's per-host stamp**: the stamp fires on first OSC sentinel from the statusline shim, which is after `claude-running`. This lives in the account spec's flow; make sure the launcher surfaces that event hook.
- **Stacking with hooks-gateway injection**: hooks gateway injects into `settings-<sid>.json` at spawn time. In the new launcher this injection happens inside the unified setup step, so both local and SSH get hook coverage from one place. Tests in hooks-gateway plan need updating to reflect the new injection point.

## Open questions

- **Do we preserve verbatim backwards-compatible behaviour for one beta as a feature flag?** Leaning yes for the first beta of v1.3.2. The flag defaults to new; user can opt out. Removed in v1.3.3.
- **Do we need to expose `phaseTimeoutsMs` in the UI?** Not yet. Document it in the SSH config JSON only. If reports come in we add UI in a follow-up.
- **Setup inside container vs outer shell**: default `inner` is the correct posture (setup where Claude will run). But older users might prefer `outer` for backwards compatibility. Expose the toggle but default to `inner` and document the behaviour change in release notes.
- **Cancel during `setup-deployed`** — do we rollback? Leaning no: half-deployed state is fine, next connect rewrites. Document.
- **Should we upload the remote tmp stderr log automatically on setup failure, or only on user click?** Only on user click via "Show remote log" recovery action. Respects the user's privacy.
- **Should we run the health probe on every connect?** Yes by default; it's fast (100–300ms). `skipHealthProbe` exists for edge cases.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
