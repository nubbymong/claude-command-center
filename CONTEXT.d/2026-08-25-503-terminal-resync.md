# 2026-08-25 — #503: console-direct splice damage, and the hand-pulled re-sync

Owner report, live mid-session: an ssh host-key prompt bled through a Claude
Code turn — prompt text mid-transcript, spinner fragments fused into output
lines, still there in scrollback.

## The split that decided the fix

The splices sat **in scrollback**, and scrollback is populated only by bytes
that came down the pty stream — which places the merge UPSTREAM of us and
distinguishes this from the #379 class (whose damage never passes through the
stream and is invisible to xterm). Mechanism: Windows OpenSSH opens the console
device directly (`CONIN$`/`CONOUT$`) for its host-key prompt, conhost merges
those writes with the TUI's concurrent cursor-addressed repaints, and ConPTY —
a screen-scraper — re-emits the merged buffer as VT.

So: **history is unfixable by physics** (the bytes really arrived spliced);
what IS fixable is the TUI live-region desync that persists afterwards and
keeps garbling every later delta-repaint. The repair is the proven post-resume
nudge — shrink one row, restore, let the TUI re-lay-out at reconfirmed
geometry — plus the strong repaint for our own stale cells.

No auto-trigger exists: the spliced bytes carry no signature, the writer is a
descendant of claude inside the pty (invisible to the command bar's
`expectBleed` seam, which probes only lines typed in the bar), and main does
not walk pty process trees. Hence a hand-pulled cord: **Ctrl+Alt+R** (capture
phase + AltGr-guarded, the Ctrl+Alt+G reasoning) and **"Repaint terminal"** in
the terminal context menu, both through the #379 repaint registry
(`requestResync`, falling back to the plain settle repaint on stub
registrations).

## What the review round surfaced (PR #506)

- **Persisted `keyboardShortcuts` maps never gain new defaults** — the hook's
  `|| DEFAULT_SHORTCUTS` fired only when the whole object was missing, so
  every pre-existing user would have had the new chord dead (and this likely
  explains residual "Ctrl+Alt+G does nothing" reports post-#399). Both
  handlers now merge over the defaults, the way StageEmptyState always did.
- The chord now repairs **the terminal it was pressed in** (DOM-ancestry
  lookup via `data-terminal-session`) — the partner shell registers under
  `${id}-partner`, and the active-session fallback alone would have nudged a
  hidden pty.
- `e.repeat` is ignored — a held chord auto-repeats ~16Hz and each fire is a
  pty resize pair.
- `dispose()` restores LIVE geometry, not the fire-time capture, so a user
  resize inside the 60ms shrink window survives an unmount race.
