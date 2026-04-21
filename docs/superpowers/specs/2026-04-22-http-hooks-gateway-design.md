# HTTP Hooks Gateway — Design Spec

**Status:** Draft · 2026-04-22
**Author:** nubbymong (co-authored with Claude)
**Supersedes:** n/a
**Related:** `docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (the sidebar this feature extends)

## Summary

A localhost-only HTTP server inside the Electron main process that receives Claude Code hook events, fans them out over IPC to the renderer, and surfaces them as a collapsible **Live Activity** footer in the GitHub sidebar. A single Settings toggle disables the entire feature cleanly.

This is the MVP of a larger feature set. Auto-approve rules, quality gates, desktop notifications, and a Worktrees/Kanban view all build on the same event stream and are explicitly out of scope for this spec.

## Why

- The statusline is a polling snapshot. We don't see *what* Claude is doing, only the last-known context usage.
- Claude Code exposes 25+ hook events covering tool calls, permission requests, compaction, subagent lifecycle, and stop-failure. Today we observe none of them.
- Multi-session orchestration (the product's reason to exist) is harder than it should be because the user has to tab into a session to know what's happening there.
- This is also the foundation for auto-approve rules, quality gates, and the Worktrees dashboard — none of which can ship without an event stream.

## Non-goals

- **Not a replacement for the statusline.** Statusline stays for context/cost/rate-limit. Hooks feed *events*.
- **Not a full activity log.** Ring-buffered to the last 200 events per session in memory. Not persisted.
- **Not auto-approve** — the MVP does not act on events, only displays them. The hook response is always "proceed".
- **Not cross-platform validated on Mac as part of this PR.** Design is platform-neutral; Mac validation happens as a separate checkpoint before the next beta.

## User experience

### Collapsed state (default)

The sidebar grows a thin footer bar below Local Git, pinned to the bottom of the panel:

```
┌──────────────────────────┐
│ ▶ Live Activity          │
│   ● 37 events · 5s ago   │
└──────────────────────────┘
```

The pulse dot blinks when a new event arrives. The "5s ago" updates continuously. Click anywhere on the row to expand.

### Expanded state

```
┌──────────────────────────────────────┐
│ ▼ Live Activity       [Filter][Pause]│
│                                      │
│ 14:02:17  Edit    App.tsx      +3/-0 │
│ 14:02:14  Read    handlers.ts        │
│ 14:02:08  ⚠ Perm  Bash(git push)    │
│ 14:01:55  Task    subagent-explore   │
│ 14:01:42  Edit    pty-manager.ts +14 │
│                                      │
│ 37 events · last 5s ago              │
└──────────────────────────────────────┘
```

Shows the most recent 20 events. Filter button hides/shows event kinds (tool / permission / task / compact). Pause button stops new events being added to the UI list (store keeps collecting).

### Settings · GitHub tab

A new **Hooks Gateway** section above Features:

```
[ ON ] HTTP Hooks Gateway
       Receives tool-call, permission, and lifecycle events from Claude Code
       sessions. Powers the Live Activity feed. No telemetry — listener is
       127.0.0.1 only; reverse-tunnelled into SSH sessions you start.
       Listening on 127.0.0.1:19334                        [ change port ]

       [x] Live Activity feed      · show recent events in sidebar
       [ ] Desktop notifications   · on permission requests and stop failures
```

The "change port" affordance opens a small inline input, writes to `config.hooksPort`, and restarts the gateway. Useful when the default range (19334–19434) is squatted on the user's machine.

The sub-toggles are stubbed for MVP (only "Live Activity feed" is wired; "Desktop notifications" is visible but does nothing until a follow-up PR). Master toggle off → everything stops: server closes, session settings files are rewritten without hook entries, ring buffers drain.

## Architecture

```
Claude Code session (local or SSH)
  └─ ~/.claude/settings-<sid>.json:
       hooks.PostToolUse   = [{ type: "http", url: "http://localhost:19334/hook/<sid>", headers: { "X-CCC-Hook-Token": "<secret>" } }]
       hooks.PreToolUse    = [{ type: "http", ... }]  (same url + header)
       hooks.Notification  = [{ type: "http", ... }]
       hooks.SessionStart  = [{ type: "http", ... }]
       hooks.Stop          = [{ type: "http", ... }]
                                                                        ▲
                                                                        │ POST (JSON body + X-CCC-Hook-Token header)
                                                                        │
Main process ─ HooksGateway                                            │
  ├─ node:http server · 127.0.0.1:19334                                │
  ├─ reject unless req.socket.localAddress === '127.0.0.1'             │
  ├─ validate: session exists · token header matches                   │
  ├─ parse: { sessionId, event, toolName?, payload, ts }               │
  ├─ redact via token-redactor                                         │
  ├─ per-session ring buffer (cap 200) — MAIN-SIDE ONLY                │
  ├─ emit IPC 'hooks:event' with sid in payload → renderer             │
  └─ respond `{}` (empty JSON) within 200ms budget                     │
       │                                                                │
       ▼                                                                │
  hooksStore (zustand) — holds refs, rehydrates from main on mount     │
       │                                                                │
       ▼                                                                │
  LiveActivityFooter (in GitHubPanel, pinned bottom)                   │
```

### Hook token in header, not URL query

Query strings are routinely logged by HTTP clients, proxies, and Claude Code's own debug mode. The secret lives in an `X-CCC-Hook-Token` request header instead. This requires Claude Code's `{ type: "http" }` hook to support custom headers — part of the pre-implementation validation spike (see §Risks).

If headers aren't supported, fall back to query string AND disable Claude Code debug logging by documenting the requirement.

### Loopback check belt-and-braces

Even though we bind `127.0.0.1`, a misconfiguration or test regression could flip that. The request handler rejects anything where `req.socket.localAddress !== '127.0.0.1'` before looking at tokens.

### Response shape frozen to `{}` from day one

Auto-approve and quality-gate follow-ups will need to respond with `{ decision: "approve" | "block", reason?: string }`. To keep the wire contract additive rather than breaking, MVP already responds with a JSON *object* (empty `{}`) rather than empty body. Renderer-observable latency budget: 200ms end-to-end (redaction + ring-buffer push + IPC fire-and-forget + response write). Events arriving slower than that will have been processed but the response may lag — Claude Code's documented behaviour for a missed hook response is "proceed without blocking", so we don't need to guarantee 200ms as a hard deadline.

### Port selection

Hard-code `19334` as the default. If bind fails (port busy), try `19334 + random(0..100)`. Give up after 5 tries, disable feature, surface a banner in Settings explaining why.

The actual port used is persisted in memory only — every session setup reads it at spawn time, so a restart-on-different-port doesn't leave stale URLs in old settings files.

### Why not reuse the vision MCP port?

Vision MCP is an MCP SSE server. Hook events are plain HTTP POST. Reusing would require multiplexing two protocols over one server. Separate ports is simpler, and we've already established the reverse-tunnel-per-feature pattern.

### SSH reverse tunnel

Same pattern as vision MCP:

```
ssh -R 19334:localhost:19334 [other flags] user@host
```

Remote sessions POST to `localhost:19334` → reaches our gateway through the tunnel. Zero extra work on the remote side. Already validated for vision MCP.

## Components

Each component is a single file with one clear purpose.

| File | Purpose | Est LOC |
|------|---------|---------|
| `src/main/hooks/hooks-gateway.ts` | HTTP server, per-session ring buffer (single source of truth), IPC emit | ~150 |
| `src/main/hooks/session-hooks-writer.ts` | Inject/remove hook config in per-session settings file | ~80 |
| `src/main/hooks/hooks-types.ts` | Main-side event type union, ring buffer shape | ~40 |
| `src/shared/hook-types.ts` | Cross-process event type (IPC payload) | ~50 |
| `src/shared/ipc-channels.ts` | Add `HOOKS_EVENT` (single channel, sid in payload), `HOOKS_TOGGLE`, `HOOKS_GET_BUFFER`, `HOOKS_SESSION_ENDED` | +10 |
| `src/main/ipc/hooks-handlers.ts` | IPC handlers · toggle, buffer retrieval | ~60 |
| `src/renderer/stores/hooksStore.ts` | Zustand — references to main-held buffer (rehydrated on mount), paused flag, filter | ~80 |
| `src/renderer/components/github/sections/LiveActivityFooter.tsx` | Collapsed/expanded footer UI | ~180 |
| `src/renderer/components/github/GitHubPanel.tsx` | Render `<LiveActivityFooter />` at bottom | +5 |
| `src/renderer/components/SettingsPage.tsx` | Master toggle + sub-toggles | +60 |
| `tests/unit/hooks/hooks-gateway.test.ts` | Server validates token, parses, respects cap | ~120 |
| `tests/unit/hooks/session-hooks-writer.test.ts` | Settings-file injection idempotent, cleanup clears | ~80 |
| `tests/unit/stores/hooksStore.test.ts` | Ring buffer, pause behavior, filter | ~60 |

**Total estimate: 975 LOC across 13 files.** All ≤200 LOC.

## Data flow

### Session spawn

1. `pty-manager.spawn()` finishes writing the SSH setup script (for SSH) or the per-session settings file (for local).
2. `await gateway.ready()` — if the gateway hasn't bound its port yet, wait (with 3s timeout). If still not ready after the timeout, skip hook injection and launch Claude anyway (degrades gracefully: no Live Activity for this session, but nothing else is broken).
3. Calls `sessionHooksWriter.inject(sid, settingsFilePath)`:
   - Generates a UUID secret for this session
   - Stores `(sid → secret)` in gateway's in-memory map
   - Reads the existing `settings-<sid>.json`, **rewrites the `hooks` key from scratch** (ignores prior content to defeat stale state from a crashed previous run)
4. Claude Code launches with `--settings <file>` (already implemented in the PR we just merged).

### Event received

1. Claude Code POSTs `http://localhost:19334/hook/<sid>?t=<secret>` with JSON body (event name + payload).
2. Gateway:
   - Extracts sid from path, token from query
   - Looks up session's secret — mismatch or unknown sid → 404, drop
   - Parses body, normalises into `HookEvent { sessionId, event, toolName?, payload, ts }`
   - Pushes into ring buffer (FIFO cap 200) — **main-side is the single source of truth**; renderer holds references only.
   - Emits `win.webContents.send('hooks:event', normalisedEvent)` — **one shared channel** with the sid embedded in the payload. One IPC listener on the renderer routes to the correct session's list. Avoids having N dynamic channels.
   - Returns 200 with `{}` (empty JSON object, not empty body — keeps the response-shape stable for future auto-approve PRs that need `{ decision: "..." }`).
3. Renderer's `hooksStore` receives on IPC, references the event in a Map keyed by sid, triggers re-render of `LiveActivityFooter`. On mount the footer rehydrates from `HOOKS_GET_BUFFER` so HMR / devtools reloads don't lose history.

### Session close

Serialise the teardown so an in-flight POST can't race past a half-closed session:

1. `pty-manager` cleanup fires → `sessionHooksWriter.remove(sid)`:
   - **Drop secret from the in-memory map FIRST**. Any request already past the token-check but not yet in the ring buffer still completes; any new request will 404.
   - Rewrite `settings-<sid>.json` with `hooks` object removed.
   - Drain ring buffer.
   - Emit `hooks:sessionEnded` with sid in payload — renderer clears its list.
2. Renderer must ignore `hooks:event` payloads whose sid is already in its "ended" set, for the edge case where an event emission arrives after `sessionEnded` due to IPC ordering.

### Master toggle off

1. User flips toggle → IPC `hooks:toggle` with `{ enabled: false }`.
2. Main side — order matters:
   - **Flip `gateway.enabled = false` synchronously**. The request handler checks this at the top and 503s any request already in the TCP accept backlog.
   - `HooksGateway.stop()` — closes HTTP server.
   - Iterates all active sessions → `sessionHooksWriter.remove(sid)` for each.
   - Clears all ring buffers.
3. Renderer: receives ack, sets `enabled: false` in store, footer hides.

### Master toggle on

1. User flips toggle → IPC `hooks:toggle` with `{ enabled: true }`.
2. Main side:
   - `HooksGateway.start()` — bind port (retry on conflict)
   - Iterates active sessions → `sessionHooksWriter.inject(sid, settingsFilePath)` for each
   - Note: sessions must reload settings to see the new hooks. Either the user runs `/reload` manually, or we live with "hooks active from next session" for MVP. Document this caveat.

### Boot-time cleanup

On gateway startup, and once per toggle-on:

1. Glob `~/.claude/settings-*.json` (local) — orphan files from prior runs may still contain hook entries pointing at this port. If the app crashed mid-disable, these are stale.
2. For each file: if the `hooks` key references our `localhost:<port>/hook/` pattern AND the sid extracted from the filename isn't in our currently-active session map, rewrite the file to remove those hook entries.
3. Remote hosts: we can't reach them proactively. Accept this. The session-spawn rewrite-from-scratch step (§Session spawn step 3) handles this next time the user reconnects.

## Schemas

### `HookEvent` (shared type)

```ts
export type HookEventKind =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'Stop'
  | 'PreCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'StopFailure'

export interface HookEvent {
  sessionId: string
  event: HookEventKind
  toolName?: string            // populated for {Pre,Post}ToolUse
  summary?: string             // human-readable one-liner — "Edit App.tsx" etc
  payload: Record<string, unknown>  // raw body from Claude Code, redacted
  ts: number                   // Date.now()
}
```

All nine kinds are declared for forward compatibility. MVP injects five into settings (`PreToolUse`, `PostToolUse`, `Notification`, `SessionStart`, `Stop`). The other four (`PreCompact`, `SubagentStart`, `SubagentStop`, `StopFailure`) are a line change in `sessionHooksWriter` when we're ready.

Raw hook payloads from Claude Code may contain file contents, diffs, tokens, API keys, SSH private keys, `.env` contents, etc. The existing `src/main/github/security/token-redactor.ts` was written to scrub GitHub tokens in PR/issue bodies — its regex vocabulary is too narrow for hook payloads. **Before this feature ships, extend the redactor** (or fork a new one named `hook-payload-redactor`) to also cover:

- `sk-[A-Za-z0-9]{40,}` (Anthropic / OpenAI / many)
- `xoxb-` / `xoxp-` (Slack)
- `AKIA[A-Z0-9]{16}` (AWS access key)
- `-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----` (private keys)
- Any `=` assignment of a value with `password|secret|token|api[_-]?key` as the identifier

Every payload runs through the redactor before storing or emitting. **This is non-negotiable — events are IPC'd; anything with devtools open can see them, so can a crash-reporter.**

### Settings file injection shape

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "http", "url": "http://localhost:19334/hook/<sid>?t=<secret>" }
    ],
    "PostToolUse": [
      { "type": "http", "url": "http://localhost:19334/hook/<sid>?t=<secret>" }
    ]
  }
}
```

We inject only the five MVP event types. We don't touch other keys in the settings file.

## Disable story (detailed)

The user must be able to turn the feature off reliably. Failure modes and mitigations:

| Failure | Mitigation |
|---------|-----------|
| Server crashes | Hooks in settings files still POST, get `ECONNREFUSED`. Claude Code logs and continues. No session is blocked. |
| Port 19334 busy at boot | Retry with random offsets. If all fail, feature disables itself and surfaces banner in Settings with the specific error. |
| User disables feature, then CCC crashes mid-cleanup | On next boot, gateway detects the toggle is `false`, iterates session-state.json and rewrites each file to remove hooks. Idempotent — safe to re-run. |
| Session's settings file is readonly / missing | Write fails silently (logged), no hook injected, session runs without hooks. Not a hard error. |
| User manually edits `hooks` in settings file | Not a supported scenario. Our writer is not diff-aware — it rewrites the entire `hooks` key on update. Document in a code comment on `sessionHooksWriter.inject`. |

## Error handling

- **Server bind fails:** log, mark disabled, set `config.hooksEnabled = false`, emit toggle-ack to renderer with `error` field. Settings page shows banner.
- **Invalid token:** respond 404, increment internal counter. If a session gets >50 invalid requests in 5min, log a warning (suggests misconfiguration or a stale settings file on the remote).
- **Parse failure:** respond 400, log body prefix (first 200 chars). Don't crash.
- **Ring buffer full:** drop oldest (FIFO). Emit a one-time `hooks:dropped` notice per session so the UI can show "... older events dropped".
- **IPC send fails** (window destroyed mid-event): silently drop. `webContents.send` on a destroyed window throws — wrap in try/catch.
- **Token redactor throws** (malformed payload): emit the event with `payload: { error: 'redaction-failed' }`. Never drop an event entirely — the *fact* of the event is often more useful than its content.

## Security

### Threat model

**Trusts all processes running as the current OS user.** Any process on your machine can connect to `127.0.0.1` on Windows and macOS (no `SO_PEERCRED` equivalent to check), and any child process of CCC can read env vars. The feature is not designed to isolate against a malicious local process — it's designed to avoid network exposure and cross-session leakage.

If you need stronger isolation, run CCC in a separate user account.

### Concrete controls

- Bind `127.0.0.1` only. Never `0.0.0.0`. Hard-coded.
- `req.socket.localAddress === '127.0.0.1'` belt-and-braces check at the top of every request (defeats a misconfig-triggered binding regression).
- Per-session UUID secret in the `X-CCC-Hook-Token` request header (not URL query, to keep it out of logs). A session can't receive events meant for another session.
- Secrets live in memory only — never written to disk, never logged.
- Hook payloads redacted through the expanded hook-payload redactor (see §Schemas) before storage or IPC.
- The server responds to `OPTIONS` requests so misconfigured reverse-tunnel setups don't wedge.
- CSP: renderer never fetches from the hooks port directly — all data arrives via IPC. No CORS holes needed.
- Settings UI shows the listener binding explicitly ("127.0.0.1:19334") and copies a note: "No telemetry. Listener is 127.0.0.1 only; reverse-tunnelled into SSH sessions you start from this app."

## Testing

### Unit

- **hooks-gateway.test.ts**
  - Starts on default port, accepts a valid POST, emits event
  - Rejects POST with bad secret
  - Rejects POST with unknown sid
  - Ring buffer cap enforced (push 300, read ≤200)
  - Token redactor is called on payload
  - Server stop closes port
  - Port conflict triggers retry; 5 failures → disabled state with error

- **session-hooks-writer.test.ts**
  - Inject writes expected JSON shape
  - Inject is idempotent (running twice doesn't duplicate entries)
  - Remove strips only the `hooks` key, preserves others (statusline, MCP)
  - Remove on a session with no hooks is a no-op
  - Inject generates a new secret each time (doesn't reuse prior)

- **hooksStore.test.ts**
  - Append increments list, capped at 200 renderer-side
  - Pause stops UI updates but store still accumulates
  - Filter shows only matching kinds
  - Session cleanup clears that session's list

### Integration (test harness, no playwright)

Two integration tests — the second closes the loop the first can't.

**A. Synthetic path (gateway → renderer):**
- Main spins up a test gateway.
- Test fires synthetic events via direct POST (simulating what Claude Code *would* do).
- Verify events arrive in the renderer store via a test IPC listener.
- Covers the internal pipeline.

**B. Real Claude path (Claude Code → gateway → renderer):**
- Spawn a minimal local `claude --print` invocation (no PTY needed — `-p` runs headless) with a real per-session settings file that the real `sessionHooksWriter` generated.
- Give it a trivial prompt that forces a tool call (e.g. "Use the Read tool to read package.json, then stop").
- Assert at least one `PreToolUse` and one `PostToolUse` event arrive in the renderer within 10s.
- This is the only test that proves the actual wire format / header / response shape is right. Without it, the whole pipeline can be green in CI while the real flow is dead.

### Manual smoke test (not automated, documented in PR description)

1. Start a local session, verify Live Activity footer appears and pulses on Claude Code activity.
2. Start an SSH session to Asustor, same verification (proves reverse tunnel).
3. Flip master toggle off, verify footer disappears and activity stops.
4. Flip back on, start a NEW session, verify events resume for that session.
5. Kill the app mid-session, restart, verify the old settings file's hooks don't stick around (boot-time cleanup).

### Mac validation gate (pre-merge-to-beta)

- SSH from Mac to the Asustor NAS: verify reverse tunnel works with OpenSSH client on macOS.
- Local PTY on Mac: verify `~/.claude/settings-<sid>.json` + `--settings` flag on the Mac build of Claude Code. Confirm it accepts an absolute path on macOS.
- First-bind firewall prompt: macOS shows an "Accept incoming connections?" dialog on first bind for unsigned apps, even for 127.0.0.1. Either notarise/entitle the build appropriately, or document the one-time prompt in the release notes.
- Port squat: Mac dev stacks often have listeners in the 19000–20000 range. The retry-with-random-offset logic plus `hooksPort` override should cover this, but validate with at least one session active.

## Migration / compatibility

- No migrations — hooks feature didn't exist. Config schema gets a new `hooksEnabled: boolean` and `hooksPort?: number` field with default `true` and `19334`.
- Existing sessions: on first launch with the feature enabled, their settings files are patched on next spawn. We do NOT patch running sessions without user action.
- SSH remotes don't need any changes — the setup script already writes the settings file; we just extend its content.

## Performance

- Event volume: measured roughly at 1–5/sec during active Claude Code usage, 0 when idle. Worst case a subagent lifecycle + pre+post tool for 20 parallel tasks = ~40/sec. Well within what an HTTP server on localhost handles.
- Ring buffer: 200 events × ~2KB each = 400KB per session. At 10 concurrent sessions = 4MB. Acceptable.
- IPC: each event is one `webContents.send`. Electron batches renderer-bound IPC — this is not a bottleneck.
- Token redaction: ~200μs per event. Runs in the server handler before IPC. Not batched.

## Phasing (follow-up PRs, tracked here for context, not in scope)

1. **This PR** — gateway + Live Activity + toggle
2. **+Desktop notifications** — wire the sub-toggle, trigger OS notification on `Notification` and `StopFailure` events
3. **+Auto-approve rules** — rule editor UI, gateway returns `{ decision: 'approve' }` for matching PermissionRequest events
4. **+Quality gates** — similar pattern, gateway returns `{ decision: 'block', reason }` when a gate fails
5. **+Worktrees/Kanban view** — new top-level page, consumes the same event stream, groups by session/worktree

## Risks

- **Claude Code `http` hook handler must be verified.** We believe Claude Code supports `{ type: "http", url: "..." }` entries in `hooks.<EventName>[]`, and that the URL can carry query params. Spike this before implementation: write a minimal `settings.json`, send the PreToolUse event intentionally, confirm the POST arrives with the expected body and query string preserved. If either assumption fails the design changes significantly (fall back to `type: "command"` hooks calling a shim that POSTs, similar to the statusline pattern).
- **HookEventKind list (9 entries) intentionally wider than what we inject (5).** The type covers the full vocabulary so the gateway parser accepts any of them forward-compatibly. Injection is narrowed to the 5 high-signal events for MVP: `PreToolUse`, `PostToolUse`, `Notification`, `SessionStart`, `Stop`. Adding the remaining 4 is a line change in `sessionHooksWriter` once validated.
- **Claude Code hook schema drift.** The event payload shape isn't versioned. If Anthropic ships a breaking change to the config format or event body structure, our parser breaks silently. Mitigation: `HookEvent` parser coerces loosely and preserves the raw `payload` object so even an unexpected shape still gets displayed. Add a test that exercises a completely unknown event kind.
- **Settings file collision.** We assume nobody is writing `hooks` to `settings-<sid>.json` except us. True today, but if the user manually edits, our rewrite clobbers their changes. Acceptable tradeoff — per-session files are ours to manage. Documented in the file header comment.
- **Port conflict on boot** — handled via retry, but if the user has something already on 19334–19434 they'll always hit disabled state. Document `hooksPort` config override.
- **Live Activity footer design fidelity** — the mockup was HTML. Actual implementation in Tailwind + Catppuccin may need visual iteration. Budget 1h for polish after the first render.
- **Mac SSH reverse tunnel** — we rely on OpenSSH's `-R` behaviour being identical across Windows and macOS. It should be; vision MCP already uses the same flag and works on both. Mac validation gate above covers this explicitly.
