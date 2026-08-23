## 2026-08-14 -- Session Watchdog: auto-retry on rate limit, overload, safeguard (#235)

Adds an opt-in, default-off per-session watchdog. It watches a session's own
terminal output for a usage-limit banner, an overload/transient API error
(529/5xx), or a flagged safeguard, then schedules and submits a retry once the
condition should have cleared.

The idea comes from the community script cheapestinference/claude-auto-retry
(MIT, credited in NOTICE and in each ported file's header). Its durable value is
pure logic -- the chrome-aware detection engine, the DST-safe reset-time parser,
and the backoff/give-up policy -- so that is what was ported. Its tmux transport
was NOT: the app already owns each session's PTY, so upstream's `capture-pane`
maps to the existing `onData` tap and its `send-keys` to the existing
command-submit write. No tmux dependency is introduced. Upstream's reconcile
loop, shell-rc wrapper and status-bar segment are artifacts of being an external
unsupervised tool and have no analogue here.

Layout: `src/main/watchdog/` -- `patterns.ts` (detection), `time-parser.ts`
(reset math), `session-watchdog.ts` (state machine, adapter-driven),
`config.ts` (validated defaults + retry-message sanitizer), `watchdog-manager.ts`
(wiring: rolling tail, one shared tick, StopFailure hook). Plus a `watchdog:`
IPC pair, a Settings section, and a sidebar countdown/gave-up badge.

The state machine talks to a six-method `WatchdogAdapter`, which is what keeps a
future transport cheap -- see #243 for extending this to tmux-wrapped SSH
sessions once #242 lands.

Two decisions worth recording:

- Retries submit via `writePty(text + '\r')`, the app's ordinary command-submit
  path, NOT the channel-bus paste envelope. `formatTier1` ends at the
  bracketed-paste close with no trailing Enter, so a paste only drafts; and an
  Enter fused to a bracketed paste is swallowed by the Ink TUI (upstream
  documents the same failure and answers it with a split send plus a 150ms
  delay). The retry text is sanitized to a single control-char-free line, so the
  lone appended '\r' is the only submit.
- The retry message configured in Settings applies to all three retry types.
  There is one field in the UI, so a per-type default of "continue" would have
  silently ignored the operator's choice on the overload and safeguard paths.

Adversarial review (ADR-009, required -- this injects into a PTY) ran in two
stages. The first pass found and fixed four MAJOR issues: a bracketed-paste
breakout via a hostile retry message, a stale watchdog surviving a same-sessionId
restart and firing into the fresh session, unbounded tail growth on lone-CR
output, and a StopFailure hook clobbering a latched give-up. A later delta pass
over the changed send path returned FIX-AND-LAND with no fan-out needed, and
killed the one surviving sanitizer mutant.

Desktop-tested on Windows: injection submits with the configured message,
scheduled retries fire at reset+margin, resuming work cancels a pending retry,
the restart race and give-up latch hold, and only local Claude sessions are
watched.

Known limitation, tracked as #263: detection reads the rendered pane, which
includes the user's own input, so pasting or quoting a banner string into a
prompt can trip a retry. Inherent to screen-scraping; upstream has it too. This
also bounds desktop testing -- anything keyed on real control bytes or on
Claude's render structure cannot be exercised by typing text and is covered by
unit tests instead.
