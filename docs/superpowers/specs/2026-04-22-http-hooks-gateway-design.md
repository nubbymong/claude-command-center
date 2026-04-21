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
       sessions. Powers the Live Activity feed. Nothing leaves your machine.
       Listening on 127.0.0.1:19334 · reverse-tunneled for SSH sessions.

       [x] Live Activity feed      · show recent events in sidebar
       [ ] Desktop notifications   · on permission requests and stop failures
```

The sub-toggles are stubbed for MVP (only "Live Activity feed" is wired; "Desktop notifications" is visible but does nothing until a follow-up PR). Master toggle off → everything stops: server closes, session settings files are rewritten without hook entries, ring buffers drain.

## Architecture

```
Claude Code session (local or SSH)
  └─ ~/.claude/settings-<sid>.json:
       hooks.PostToolUse   = [{ type: "http", url: "http://localhost:19334/hook/<sid>?t=<secret>" }]
       hooks.PreToolUse    = [{ type: "http", url: "http://localhost:19334/hook/<sid>?t=<secret>" }]
       hooks.Notification  = [{ type: "http", url: "http://localhost:19334/hook/<sid>?t=<secret>" }]
       hooks.SessionStart  = [{ type: "http", url: "http://localhost:19334/hook/<sid>?t=<secret>" }]
       hooks.Stop          = [{ type: "http", url: "http://localhost:19334/hook/<sid>?t=<secret>" }]
                                                                        ▲
                                                                        │ POST (JSON)
                                                                        │
Main process ─ HooksGateway                                            │
  ├─ node:http server · 127.0.0.1:19334                                │
  ├─ validate: session exists · secret matches                         │
  ├─ parse: { sessionId, event, toolName?, payload, ts }               │
  ├─ per-session ring buffer (cap 200)                                 │
  └─ emit IPC 'hooks:event:<sid>' → renderer                           │
       │                                                                │
       ▼                                                                │
  hooksStore (zustand)                                                 │
       │                                                                │
       ▼                                                                │
  LiveActivityFooter (in GitHubPanel, pinned bottom)                   │
```

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
| `src/main/hooks/hooks-gateway.ts` | HTTP server, per-session ring buffer, IPC emit | ~150 |
| `src/main/hooks/session-hooks-writer.ts` | Inject/remove hook config in per-session settings file | ~80 |
| `src/main/hooks/hooks-types.ts` | Main-side event type union, ring buffer shape | ~40 |
| `src/shared/hook-types.ts` | Cross-process event type (IPC payload) | ~50 |
| `src/shared/ipc-channels.ts` | Add `HOOKS_EVENT`, `HOOKS_TOGGLE`, `HOOKS_GET_BUFFER` | +10 |
| `src/main/ipc/hooks-handlers.ts` | IPC handlers · toggle, buffer retrieval | ~60 |
| `src/renderer/stores/hooksStore.ts` | Zustand — per-session event list, paused flag, filter | ~80 |
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
2. Calls `sessionHooksWriter.inject(sid, settingsFilePath)`:
   - Generates a UUID secret for this session
   - Stores `(sid → secret)` in gateway's in-memory map
   - Reads the existing `settings-<sid>.json`, adds a `hooks` object, writes it back
3. Claude Code launches with `--settings <file>` (already implemented in the PR we just merged).

### Event received

1. Claude Code POSTs `http://localhost:19334/hook/<sid>?t=<secret>` with JSON body (event name + payload).
2. Gateway:
   - Extracts sid from path, token from query
   - Looks up session's secret — mismatch or unknown sid → 404, drop
   - Parses body, normalises into `HookEvent { sessionId, event, toolName?, payload, ts }`
   - Pushes into ring buffer (FIFO cap 200)
   - Emits `win.webContents.send('hooks:event:<sid>', normalisedEvent)`
   - Returns 200 with empty body (Claude Code doesn't care about response bodies for non-decision hooks)
3. Renderer's `hooksStore` receives on IPC, appends to per-session list, triggers re-render of `LiveActivityFooter`.

### Session close

1. `pty-manager` cleanup fires → `sessionHooksWriter.remove(sid)`:
   - Rewrite `settings-<sid>.json` with `hooks` object removed
   - Drop secret from in-memory map
   - Drain ring buffer, emit `hooks:sessionEnded:<sid>` so the renderer can clear its list

### Master toggle off

1. User flips toggle → IPC `hooks:toggle` with `{ enabled: false }`.
2. Main side:
   - `HooksGateway.stop()` — closes HTTP server
   - Iterates all active sessions → `sessionHooksWriter.remove(sid)` for each
   - Clears all ring buffers
3. Renderer: receives ack, sets `enabled: false` in store, footer hides.

### Master toggle on

1. User flips toggle → IPC `hooks:toggle` with `{ enabled: true }`.
2. Main side:
   - `HooksGateway.start()` — bind port (retry on conflict)
   - Iterates active sessions → `sessionHooksWriter.inject(sid, settingsFilePath)` for each
   - Note: sessions must reload settings to see the new hooks. Either the user runs `/reload` manually, or we live with "hooks active from next session" for MVP. Document this caveat.

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

Raw hook payloads from Claude Code may contain file contents, diffs, and secrets. The gateway runs each payload through the existing `src/main/github/security/token-redactor.ts` before storing or emitting. **This is critical for the renderer — the event is IPC'd so tooling like devtools can see it.**

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

- Bind `127.0.0.1` only. Never `0.0.0.0`. Hard-coded.
- Per-session UUID secret in URL query. A session can't receive events meant for another session.
- Secrets live in memory only — never written to disk.
- Hook payloads redacted through existing `token-redactor` before storage or IPC.
- The server responds to `OPTIONS` requests so misconfigured reverse-tunnel setups don't wedge.
- CSP: renderer never fetches from the hooks port directly — all data arrives via IPC. No CORS holes needed.

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

- Spawn a minimal local PTY with a settings file pointing at the gateway.
- Have the test send synthetic events via direct POST (simulating what Claude Code would do).
- Verify events arrive in the renderer store via a test IPC listener.

### Manual smoke test (not automated, documented in PR description)

1. Start a local session, verify Live Activity footer appears and pulses on Claude Code activity.
2. Start an SSH session to Asustor, same verification (proves reverse tunnel).
3. Flip master toggle off, verify footer disappears and activity stops.
4. Flip back on, start a NEW session, verify events resume for that session.
5. Kill the app mid-session, restart, verify the old settings file's hooks don't stick around (boot-time cleanup).

### Mac validation gate (pre-merge-to-beta)

- SSH from Mac to the Asustor NAS: verify reverse tunnel works with OpenSSH client on macOS.
- Local PTY on Mac: verify `~/.claude/settings-<sid>.json` + `--settings` flag on the Mac build of Claude Code.

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
