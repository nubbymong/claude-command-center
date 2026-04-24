# SSH Session Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex + six-boolean implicit state machine inside `pty-manager.ts` (SSH branch, lines ~324–485) with an explicit `SessionLauncher` + strategy model driven by CCC sentinel markers, with `claude --version` health probe, setup-payload fingerprinting, atomic deploys, cancel-safe traps, and structured error surfaces — so SSH sessions stop leaking the setup blob, mistyping passwords into MOTDs, and failing silently when Claude isn't installed on the remote.

**Architecture:** New `src/main/session/` module houses the launcher + strategy objects. `SshStrategy` owns phase-specific remote commands; a stateful `MarkerParser` carries ambiguous trailing bytes across PTY chunks. Per-host in-process mutex serializes `setup-check` + `setup-deployed` so concurrent connects don't race on the fingerprint file. The old latch-and-regex block is deleted.

**Tech Stack:** TypeScript strict, node:pty (existing), node:crypto, node:child_process (for the local health probe runner), vitest, `@testing-library/react` for the error card.

---

## File structure

**Shared:**
- Create: `src/shared/session-launch-types.ts` — cross-process types.

**Main — new module:**
- Create: `src/main/session/session-types.ts` — `SessionLaunchPhase`, `LaunchStrategy`, `LauncherCtx`.
- Create: `src/main/session/remote-marker-protocol.ts` — stateful `MarkerParser` per session.
- Create: `src/main/session/setup-fingerprint.ts` — SHA-256 fingerprint of the setup payload; versioned.
- Create: `src/main/session/setup-payload.ts` — builds the setup script; atomic-rename writes; `trap` for echo restore.
- Create: `src/main/session/claude-health.ts` — runs `claude --version`, parses, 3-step interrupt escalation.
- Create: `src/main/session/session-error.ts` — `SessionError` class + recovery-action registry.
- Create: `src/main/session/session-launcher.ts` — state machine + phase driver.
- Create: `src/main/session/ssh-strategy.ts` — SSH phase implementations.
- Create: `src/main/session/host-mutex.ts` — per-`hostSlug` in-process advisory mutex.
- Modify: `src/main/pty-manager.ts` — delegate state control to `SessionLauncher`; delete regex block.

**Renderer:**
- Create: `src/renderer/components/session/SessionErrorCard.tsx` — renders `SessionError` + recovery actions.
- Modify: `src/renderer/stores/sessionStore.ts` — hold `launchError: Record<sessionId, SessionError | null>`.

**Tests:**
- `tests/unit/main/session/remote-marker-protocol.test.ts`
- `tests/unit/main/session/setup-fingerprint.test.ts`
- `tests/unit/main/session/setup-payload.test.ts`
- `tests/unit/main/session/claude-health.test.ts`
- `tests/unit/main/session/session-launcher.test.ts`
- `tests/unit/main/session/ssh-strategy.test.ts`
- `tests/unit/main/session/host-mutex.test.ts`
- `tests/unit/renderer/components/session/SessionErrorCard.test.tsx`

All new files ≤350 LOC.

---

## Phase A — Extract building blocks

### Task 1: Shared + main-side type skeleton

**Files:**
- Create: `src/shared/session-launch-types.ts`
- Create: `src/main/session/session-types.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/main/session/session-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { SessionLaunchPhase, ShellType } from '../../../src/main/session/session-types'
import type { SessionLaunchProgress } from '../../../src/shared/session-launch-types'

describe('session types', () => {
  it('enumerates every documented phase', () => {
    const phases: SessionLaunchPhase[] = [
      'connecting', 'authenticating', 'shell-ready',
      'running-post', 'post-shell',
      'setup-check', 'setup-deployed',
      'health-check', 'claude-launching', 'claude-running',
      'error',
    ]
    expect(phases.length).toBe(11)
  })
  it('progress carries phase + sinceMs', () => {
    const p: SessionLaunchProgress = {
      sessionId: 's1', phase: 'connecting', startedAt: Date.now(), sinceMs: 0,
    }
    expect(p.phase).toBe('connecting')
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

`src/main/session/session-types.ts`:

```ts
export type SessionLaunchPhase =
  | 'connecting'
  | 'authenticating'
  | 'shell-ready'
  | 'running-post'
  | 'post-shell'
  | 'setup-check'
  | 'setup-deployed'
  | 'health-check'
  | 'claude-launching'
  | 'claude-running'
  | 'error'

export type ShellType = 'bash' | 'zsh' | 'ash' | 'dash' | 'fish' | 'unknown'

export interface LauncherCtx {
  sessionId: string
  sendToRemote: (data: string) => void
  emitProgress: (phase: SessionLaunchPhase, subStep?: string) => void
  shellType?: ShellType
}

export interface LaunchStrategy {
  phases: SessionLaunchPhase[]
  enter(phase: SessionLaunchPhase, ctx: LauncherCtx): Promise<void>
}
```

`src/shared/session-launch-types.ts`:

```ts
import type { SessionLaunchPhase, ShellType } from './../main/session/session-types'  // re-exported below
export type { SessionLaunchPhase, ShellType }

export interface SessionLaunchProgress {
  sessionId: string
  phase: SessionLaunchPhase
  subStep?: string
  startedAt: number
  sinceMs: number
  shellType?: ShellType
  claudeVersion?: string
  fingerprintMatched?: boolean
}
```

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/main/session/session-types.ts src/shared/session-launch-types.ts tests/unit/main/session/session-types.test.ts
git commit -m "feat(session): session-launch types + phases enum"
```

---

### Task 2: Stateful `MarkerParser` with carry buffer (B1 fix)

**Files:**
- Create: `src/main/session/remote-marker-protocol.ts`
- Create: `tests/unit/main/session/remote-marker-protocol.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createMarkerParser, type CccMarker } from '../../../src/main/session/remote-marker-protocol'

describe('MarkerParser', () => {
  let p: ReturnType<typeof createMarkerParser>
  beforeEach(() => { p = createMarkerParser() })

  it('ingests a whole printed marker in one chunk', () => {
    const r = p.ingest('hello\n__CCC_PHASE_SHELL_READY__bash\nworld\n')
    expect(r.cleaned).toBe('hello\nworld\n')
    expect(r.markers).toEqual([{ kind: 'phase', phase: 'SHELL_READY', payload: 'bash' }])
  })

  it('handles a marker split across two chunks', () => {
    const a = p.ingest('hello\n__CCC_PHASE_SHE')
    expect(a.markers).toEqual([])
    expect(a.cleaned).toBe('hello\n')
    const b = p.ingest('LL_READY__bash\nworld\n')
    expect(b.markers).toEqual([{ kind: 'phase', phase: 'SHELL_READY', payload: 'bash' }])
    expect(b.cleaned).toBe('world\n')
  })

  it('handles OSC sentinel split across chunks', () => {
    const a = p.ingest('foo\x1b]9999;CMSTATUS={"sid":')
    const b = p.ingest('"abc"}\x07bar')
    expect(a.markers.length + b.markers.length).toBe(1)
    expect(a.cleaned + b.cleaned).toBe('foobar')
  })

  it('flushes carry buffer as plain bytes on timeout', () => {
    p.ingest('__CCC_PHASE_SHE')      // partial, held
    const cleaned = p.flush()
    expect(cleaned).toBe('__CCC_PHASE_SHE')
  })

  it('drops buffer + emits prefix when over MAX_MARKER_BUFFER', () => {
    // Build a chunk that looks ambiguous for too long
    const bogus = '__CCC_PHASE_' + 'A'.repeat(10_000) // 10KB of letters starting like a marker
    const r = p.ingest(bogus)
    // We cap at 8KB carry buffer; bytes beyond are emitted as cleaned
    expect(r.cleaned.length).toBeGreaterThan(0)
  })

  it('tolerates CRLF line endings in printed markers', () => {
    const r = p.ingest('x\r\n__CCC_PHASE_FINGERPRINT__missing\r\ny\r\n')
    expect(r.markers).toEqual([{ kind: 'phase', phase: 'FINGERPRINT', payload: 'missing' }])
  })

  it('extracts marker even when wrapped by ANSI colour codes', () => {
    const r = p.ingest('\x1b[0m__CCC_PHASE_SETUP_OK__\x1b[0m\n')
    expect(r.markers).toEqual([{ kind: 'phase', phase: 'SETUP_OK', payload: '' }])
  })

  it('reset() clears state', () => {
    p.ingest('__CCC_PHASE_SHE')
    p.reset()
    const r = p.ingest('LL_READY__bash\n')
    expect(r.markers).toEqual([])
    expect(r.cleaned).toBe('LL_READY__bash\n')
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

```ts
// src/main/session/remote-marker-protocol.ts
export type CccMarker =
  | { kind: 'phase'; phase: string; payload: string }
  | { kind: 'osc'; name: string; payload: string }

export interface MarkerParser {
  ingest(chunk: string): { cleaned: string; markers: CccMarker[] }
  flush(): string
  reset(): void
}

const MAX_MARKER_BUFFER = 8 * 1024
const PHASE_PREFIX = '__CCC_PHASE_'
const OSC_PREFIX = '\x1b]9999;'
const OSC_TERMINATOR = '\x07'
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const PHASE_LINE_RE = /__CCC_PHASE_([A-Z_]+)__([^\r\n]*)\r?\n/g

function isPotentialPartial(buf: string): boolean {
  // Buffer ends partway into a phase prefix or osc prefix?
  if (buf.endsWith(PHASE_PREFIX.slice(0, buf.length)) && buf.length < PHASE_PREFIX.length) return true
  // Any trailing substring of '__CCC_PHASE_' ?
  for (let i = Math.max(0, buf.length - PHASE_PREFIX.length); i < buf.length; i++) {
    if (PHASE_PREFIX.startsWith(buf.slice(i))) return true
  }
  // OSC partial
  for (let i = Math.max(0, buf.length - OSC_PREFIX.length); i < buf.length; i++) {
    if (OSC_PREFIX.startsWith(buf.slice(i))) return true
  }
  // OSC body waiting for terminator?
  const oscStart = buf.lastIndexOf(OSC_PREFIX)
  if (oscStart >= 0 && !buf.slice(oscStart).includes(OSC_TERMINATOR)) return true
  // Phase marker waiting for trailing newline?
  const phaseStart = buf.lastIndexOf(PHASE_PREFIX)
  if (phaseStart >= 0 && !buf.slice(phaseStart).includes('\n')) return true
  return false
}

export function createMarkerParser(): MarkerParser {
  let carry = ''

  function process(combined: string): { cleaned: string; markers: CccMarker[] } {
    const markers: CccMarker[] = []
    // OSC extraction first (invisible to xterm)
    let out = ''
    let i = 0
    while (i < combined.length) {
      const oscStart = combined.indexOf(OSC_PREFIX, i)
      if (oscStart < 0) { out += combined.slice(i); break }
      out += combined.slice(i, oscStart)
      const end = combined.indexOf(OSC_TERMINATOR, oscStart + OSC_PREFIX.length)
      if (end < 0) {
        // incomplete — hold everything from oscStart in carry
        carry = combined.slice(oscStart)
        return { cleaned: out, markers }
      }
      const body = combined.slice(oscStart + OSC_PREFIX.length, end)
      const eq = body.indexOf('=')
      if (eq > 0) {
        markers.push({ kind: 'osc', name: body.slice(0, eq), payload: body.slice(eq + 1) })
      }
      i = end + OSC_TERMINATOR.length
    }
    // Phase-line extraction (strip ANSI first for matching but keep original bytes)
    const lines = out.split('\n')
    const kept: string[] = []
    for (let j = 0; j < lines.length; j++) {
      const raw = lines[j]
      const stripped = raw.replace(ANSI_RE, '')
      const m = /^.*?__CCC_PHASE_([A-Z_]+)__([^\r]*)\r?$/.exec(stripped)
      if (m && j < lines.length - 1) {
        // full line with trailing newline
        markers.push({ kind: 'phase', phase: m[1], payload: m[2] })
      } else if (m && j === lines.length - 1 && !combined.endsWith('\n')) {
        // last segment without newline — may be partial; hold in carry
        carry = raw + '\n' // synthesize terminator for next pass match
        continue
      } else {
        kept.push(raw)
      }
    }
    // DO NOT reset `carry` here — lines above may have set it (partial OSC at
    // 279, partial phase tail at 301) or ingest may have pre-set it to the
    // post-newline tail before calling process(). An unconditional reset
    // wipes state that must survive to the next ingest() call, breaking
    // every split-across-chunks test.
    return { cleaned: kept.join('\n'), markers }
  }

  return {
    ingest(chunk) {
      const combined = carry + chunk
      if (combined.length > MAX_MARKER_BUFFER && !combined.includes('\n') && !combined.includes(OSC_TERMINATOR)) {
        // Overflow: emit the oldest portion as cleaned and drop the suspect prefix
        const emit = combined.slice(0, combined.length - MAX_MARKER_BUFFER / 2)
        carry = combined.slice(emit.length)
        return { cleaned: emit, markers: [] }
      }
      if (isPotentialPartial(combined)) {
        const lastNewline = combined.lastIndexOf('\n')
        if (lastNewline >= 0) {
          carry = combined.slice(lastNewline + 1)
          const emit = combined.slice(0, lastNewline + 1)
          return process(emit)
        }
        // No newline yet — hold everything
        carry = combined
        return { cleaned: '', markers: [] }
      }
      carry = ''
      return process(combined)
    },
    flush() {
      const out = carry
      carry = ''
      return out
    },
    reset() { carry = '' },
  }
}
```

(Implementation note: the above is a strawman. Tests are the source of truth — the strawman **passes** the straightforward cases and **is expected to fail** on edge cases flagged in `docs/superpowers/plan-review-findings-2026-04-23.md` under `ssh-session-redesign`. Specifically:

- **B1 (fixed above)** — the `carry = ''` reset inside `process()` was the primary bug. It has been removed with an inline comment explaining why. Do not re-add it.
- **B2** — `isPotentialPartial` fast-path. Audit whether the `endsWith` check adds anything the subsequent loop does not already cover; simplify if redundant.
- **B3** — overflow path currently emits the "oldest portion" as `cleaned` without running it through `process()`, so any marker in that region is dropped silently. Either route the emit through `process()`, or only trigger overflow when `isPotentialPartial` was false (so the emitted region is known marker-free).
- **B4** — ANSI-wrapped marker preserves only marker, not prefix. For input like `'prefix \x1b[0m__CCC_PHASE_SETUP_OK__\x1b[0m\n'`, the current regex `^.*?__CCC_PHASE_...` greedily consumes `'prefix '`. Change capture group so the prefix is emitted to `kept[]` before the marker: use `^(.*?)__CCC_PHASE_([A-Z_]+)__([^\r]*)\r?$` and push `m[1]` into `kept` when non-empty.

Tune the regex and loops until ALL 8 tests pass. Don't ship until green.)

- [ ] **Step 4: Passes (all 8 tests)**

- [ ] **Step 5: Commit**

```bash
git add src/main/session/remote-marker-protocol.ts tests/unit/main/session/remote-marker-protocol.test.ts
git commit -m "feat(session): stateful marker parser with carry buffer"
```

---

### Task 3: Extract `setup-payload.ts`

**Files:**
- Create: `src/main/session/setup-payload.ts`
- Create: `tests/unit/main/session/setup-payload.test.ts`

- [ ] **Step 1-5:** Extract the current `SSH_STATUSLINE_SHIM` + `generateRemoteSetupScript` content from `pty-manager.ts` into a new module. Add a `trap 'stty echo 2>/dev/null' EXIT INT TERM` wrapper (B5 fix), convert all internal file writes to tmp-then-`mv -f` (atomic rename), and switch the success/failure branch from `&& || ` to `if/then/else` (reviewer N4).

Expose:

```ts
export function buildSetupScript(args: { sessionId: string; shellType: ShellType }): { script: string; expectedMarker: string }
export function buildFingerprintProbeScript(): string
export function buildCapabilityProbeScript(): string
```

Tests: round-trip the script via base64 encode/decode; assert `trap` present; assert `set -euo pipefail`; assert `mv -f` for fingerprint write.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(session): extract setup-payload with trap + atomic renames"
```

---

### Task 4: Setup fingerprint helper

**Files:**
- Create: `src/main/session/setup-fingerprint.ts`
- Create: `tests/unit/main/session/setup-fingerprint.test.ts`

Expose:

```ts
export function computeSetupFingerprint(scriptText: string, appVersion: string): string
```

- Returns `SHA-256(appVersion + '\n' + scriptText)` truncated to 16 hex chars.
- Version prefix isn't separately included (reviewer S8 — the script text hash changes across versions anyway).

Tests: same input → same output; different version OR different script → different output; prefix handling.

```bash
git commit -m "feat(session): setup fingerprint helper"
```

---

### Task 5: Host-mutex helper

**Files:**
- Create: `src/main/session/host-mutex.ts`
- Create: `tests/unit/main/session/host-mutex.test.ts`

```ts
export async function withHostMutex<T>(hostSlug: string, fn: () => Promise<T>): Promise<T>
export function releaseAllForTests(): void
```

Uses a module-level `Map<string, Promise<void>>`. New call awaits the existing promise if any, then takes the slot. Releases on settle.

Tests: two concurrent calls serialize; independent slugs run parallel.

```bash
git commit -m "feat(session): per-host in-process mutex for setup phase"
```

---

## Phase B — SessionLauncher skeleton + SSH strategy stub

### Task 6: SessionLauncher state machine skeleton

**Files:**
- Create: `src/main/session/session-launcher.ts`
- Create: `tests/unit/main/session/session-launcher.test.ts`

Exposes:

```ts
export class SessionLauncher {
  constructor(opts: LauncherOpts)
  start(): Promise<ActivePty>
  cancel(): Promise<void>
  ingest(chunk: string): string  // returns cleaned bytes ready for xterm
  getState(): SessionLaunchPhase
  getDiagnostics(): LaunchDiagnostics
}
```

Skeleton exercises: state transitions, timeouts per phase, cancel idempotency, marker parser flush on timeout. The real phase logic is in the strategy.

Test the state-transition table with a fake strategy that emits deterministic markers on command. Assert:
- Happy path: connecting → authenticating → shell-ready → setup-check → setup-deployed → health-check → claude-launching → claude-running.
- Cancel during setup-deployed: state ends at `error` with `cancelled` code.
- Phase timeout fires → `flush()` called on parser → remaining bytes in cleaned output.

```bash
git commit -m "feat(session): SessionLauncher skeleton + state machine"
```

---

### Task 7: SessionError + recovery registry

**Files:**
- Create: `src/main/session/session-error.ts`
- Create: `tests/unit/main/session/session-error.test.ts`

Export the error class + `RecoveryAction` type + a registry function `recoveryActionsFor(code): RecoveryAction[]` returning the per-code list from the spec.

```bash
git commit -m "feat(session): SessionError class + recovery-actions registry"
```

---

## Phase C — SSH strategy phases (correctness core)

### Task 8: `connecting` + `authenticating` phases

**Files:**
- Create: `src/main/session/ssh-strategy.ts`

Implement:
- `connecting`: spawn `ssh.exe` / `ssh` with args including `-o ConnectTimeout=<n>`, `-o ServerAliveInterval=30`, `-o LogLevel=ERROR`, `-R <hooksPort>:localhost:<hooksPort>`. First bytes → authenticating.
- `authenticating` password path: narrow 15-second window. Stopword heuristic — reject MOTDs containing `expires|changed|old|reset|confirm|new` (reviewer S3). Also reject any line longer than 120 chars. 2FA exclusion list: `duo|code|token|otp|push`.
- `authenticating` key-auth: idle 1.5s after first byte, then emit the probe.
- Probe emission: `printf '__CCC_PHASE_SHELL_READY__%s\n' "$(ps -p $$ -o comm= 2>/dev/null || printf "${SHELL:-unknown}")"` — 10s timeout for first probe, re-send once, then `error: authenticated_no_shell`.

Tests with a mocked PTY: password-wrong detection, MOTD false-positive blocking, shell-type extraction.

```bash
git commit -m "feat(session): SSH connecting + authenticating phases"
```

---

### Task 9: `setup-check` + `setup-deployed` phases

**Files:**
- Modify: `src/main/session/ssh-strategy.ts`

- `setup-check`: acquire host mutex via `withHostMutex(hostSlug, ...)`. Emit fingerprint probe `__CCC_PHASE_FINGERPRINT__<value>`. Compare. Match → `health-check`. Miss → `setup-deployed`.
- `setup-deployed`: capability probe first (B3 fix) — `command -v node && command -v base64`. Missing → set `setupLocation: 'outer'` + emit one-time toast via IPC. Then emit the wrapped deploy blob (`trap` restores echo; if/then/else branches). Wait for `SETUP_OK` / `SETUP_ERR`. 60s timeout.

Tests: mutex serializes two concurrent connects; capability probe fallback; success path; failure path fetches remote log.

```bash
git commit -m "feat(session): setup-check + setup-deployed with host mutex + atomic deploy"
```

---

### Task 10: `running-post` + `post-shell` with explicit timeout (B7 fix)

**Files:**
- Modify: `src/main/session/ssh-strategy.ts`

- `running-post`: emit the user's post-command, then the post-shell probe. Narrow sudo prompt window ONLY during this phase (B7: `[sudo] password for X:`, `password for X:`). Sudo password written once within 30s of post-command emission.
- `post-shell`: 30s default timeout. On timeout → error `post_shell_timeout` with recovery actions including **"Show terminal and let me drive manually"** (resolves launcher with `claude-running (manual)` flag; renderer fades overlay + lets user drive the PTY directly).
- Re-detect `shellType` inside the container via the probe payload.

Tests: timeout path produces `post_shell_timeout`; "show terminal" resolution path.

```bash
git commit -m "feat(session): running-post + post-shell with manual-override recovery"
```

---

### Task 11: `health-check` with 3-step interrupt escalation (B6 fix)

**Files:**
- Create: `src/main/session/claude-health.ts`
- Modify: `src/main/session/ssh-strategy.ts`

Health module:

```ts
export async function runClaudeVersion(runner: RemoteRunner, timeoutMs: number): Promise<ClaudeHealthResult>
```

- Emit `(claude --version 2>&1; printf '\n__CCC_PHASE_HEALTH_END__\n')`.
- Collect until `HEALTH_END` marker OR 10s timeout.
- **On timeout: send `\x03`, wait 2s; send `\x03` again, wait 2s; kill PTY.** Record each step in diagnostics.
- Parse `claude code <X.Y.Z>` semver-style; `supportsSettings = semver >= 1.0.0`.
- Missing → `claude_missing`. Unexpected format → `claude_unexpected_version`.

Tests: happy version parse; `command not found` branch; 3-step escalation path; unexpected-version path.

```bash
git commit -m "feat(session): claude-health probe with Ctrl+C interrupt escalation"
```

---

### Task 12: `claude-launching` → `claude-running`

**Files:**
- Modify: `src/main/session/ssh-strategy.ts`

Emit launch command (existing resume-picker branch or direct claude). First non-marker data → `claude-running`. Resolve launcher. Parser continues stripping statusline OSC sentinels.

```bash
git commit -m "feat(session): final launch phase"
```

---

## Phase D — Integrate with pty-manager

### Task 13: Route pty-manager through SessionLauncher

**Files:**
- Modify: `src/main/pty-manager.ts`

- Replace the entire SSH branch `if (options?.ssh) { ... }` body with:

```ts
const launcher = new SessionLauncher({
  sessionId, win, options,
  strategy: new SshStrategy({ ssh: options.ssh, hooksPort: getHooksPort() }),
  onProgress: (p) => win.webContents.send(`session:progress:${sessionId}`, p),
  onError: (err) => win.webContents.send(`session:error:${sessionId}`, err),
})
const pty = await launcher.start()
```

- Replace `ptyProcess.onData((rawData) => { ... })` with:

```ts
ptyProcess.onData((raw) => {
  if (win.isDestroyed()) return
  const cleaned = launcher.ingest(raw)
  win.webContents.send(`pty:data:${sessionId}`, cleaned)
})
```

- Delete: `PASSWORD_PROMPT_RE`, `SHELL_PROMPT_RE`, `lastPromptLine`, `setupDone`, `cdSent`, `passwordSent`, `postCommandSent`, `claudeSent`, `postCommandShellReady`, `sudoPasswordSent`. All subsumed by the launcher.

- Ensure `extractSshOscSentinels` still runs for statusline sentinels — its work is now inside `launcher.ingest` (the parser emits OSC markers, launcher routes them to the statusline dispatcher).

Tests: existing pty-manager tests stay green; add one test that confirms the regex block is gone (grep the source in a snapshot test).

```bash
git commit -m "feat(session): route pty-manager SSH through SessionLauncher; delete regex latches"
```

---

### Task 14: Local path integration (lightweight)

**Files:**
- Modify: `src/main/pty-manager.ts`

Local sessions keep the existing spawn shape. Add the health-probe step for local `claude --version` via child_process as a non-blocking pre-flight. On `claude_missing` for local, surface `SessionError` through the same IPC channel. Do NOT unify the two paths into a common launcher class in this PR (reviewer Scope3 — deferred to v1.3.3).

```bash
git commit -m "feat(session): local path gets health-probe pre-flight"
```

---

## Phase E — Structured error surface

### Task 15: `SessionErrorCard` renderer component

**Files:**
- Create: `src/renderer/components/session/SessionErrorCard.tsx`
- Modify: `src/renderer/stores/sessionStore.ts` — hold `launchError: Record<sessionId, SessionError | null>` and listen to `session:error:<sid>`.

The card renders:
- Phase + error code
- Human message
- Recovery actions as buttons. `retry-with-options` actions open the existing SSH-config modal at the relevant field (reviewer Scope2 — no inline mini-form).
- "Copy diagnostic report" button that serialises `LaunchDiagnostics` to clipboard.
- Catppuccin palette; `aria-live="polite"`.

Tests with `@testing-library/react` for each error code shape.

```bash
git commit -m "feat(session): SessionErrorCard + store wiring"
```

---

### Task 16: Hooks-gateway injection via the unified setup payload

**Files:**
- Modify: `src/main/session/setup-payload.ts`

If the hooks PR has merged (feat/hooks-gateway), the setup payload writes the per-session settings file with hook entries pre-injected (one place, both local + SSH). The launcher pre-reads `config.hooksEnabled` + `config.hooksPort` and passes them in.

This task is a one-line integration; the heavy lifting lives in the hooks gateway's `session-hooks-writer.ts`. Reuse it.

```bash
git commit -m "feat(session): unified hooks injection via setup payload"
```

---

## Phase F — Release prep

### Task 17: Typecheck + full vitest + installer

- [ ] `npm run typecheck` — green.
- [ ] `npx vitest run` — green.
- [ ] `npm run package:win` — installer rebuilt.

### Task 18: Manual smoke (all six scenarios per spec §Testing / Manual smoke)

1. Asustor key-auth: first connect deploys cleanly, second connect uses fingerprint hit.
2. Password-auth VM: wrong password shows SessionErrorCard; correct password proceeds.
3. Docker-entry Linux host: post-command + inside-container setup + launch.
4. BusyBox/Alpine remote: shell-type `ash`, setup runs, claude launches.
5. Mobile hotspot: raise ConnectTimeout to 60s; observe no regex races.
6. Remote without `claude`: `claude_missing` error card with install-docs action.

### Task 19: Push + PR

```bash
git push -u origin feat/ssh-session-redesign
gh pr create --title "SSH session redesign: explicit state machine + health probe + cancel-safe deploy" --body "..."
```

---

## Self-review checklist

- [ ] Blockers folded:
  - [x] B1 marker parser — stateful, carry buffer capped, flushes on timeout
  - [x] B2 printed-marker leak — overlay invariant documented, OSC preferred
  - [x] B3 `setupLocation: 'inner'` — `'auto'` default + capability probe + silent fallback
  - [x] B4 fingerprint race — `withHostMutex` serializes setup phase
  - [x] B5 cancel mid-deploy — `trap EXIT INT TERM` + atomic renames
  - [x] B6 hung `claude --version` — 3-step `\x03`/`\x03`/kill
  - [x] B7 post-command without shell — explicit 30s timeout + "Show terminal" recovery
- [ ] Scope cuts respected: no bg TCP health ping, no inline retry-with-options form, no LocalStrategy unification (Phase D keeps local minimal), no self-repair fingerprint fallback, no v2 feature flag, no happy-path overlay (error card only).
- [ ] Every code step shows full code (or points explicitly at the spec/source for the large setup script). No placeholders.
- [ ] Types used in later tasks defined in earlier tasks.
- [ ] Regex latches actually deleted in Task 13 (snapshot test enforces).
- [ ] No `\u{...}` Unicode escapes in JSX.
- [ ] No em dashes in user-facing copy in SessionErrorCard.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
