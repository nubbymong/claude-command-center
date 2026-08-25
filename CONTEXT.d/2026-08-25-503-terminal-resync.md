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

- **Persisted `keyboardShortcuts` maps never gained new defaults** — root
  cause in `settingsStore.hydrate`, whose deep-merge covered statusLine/
  terminal/conductorTools/watchdog but not keyboardShortcuts, so every
  substituting consumer had new chords dead for existing users (Sidebar's #124
  per-key `renameSession` patch was this same bug; residual "Ctrl+Alt+G does
  nothing" reports post-#399 likely were too). Fixed IN hydrate for every
  consumer; the two hook handlers also merge locally as defense in depth. A
  hand-cleared `""` binding survives the merge (falsy → `matchesShortcut`
  declines) — only a hand-deleted key resurrects its default.
- The chord repairs **the terminal it was pressed in** (DOM ancestry via
  `data-terminal-session`); with focus outside any terminal it targets the
  pane actually on screen (`data-terminal-active` — `isActive` is true for at
  most one TerminalView); the bare active id is the last resort. The partner
  shell registers under `${id}-partner`, and the active-session id alone
  would have nudged a hidden pty.
- Key-repeats are **consumed without acting** — for both chords. Round 2
  caught that a bare `if (e.repeat) return` before preventDefault let xterm
  encode the held chord as ESC+ctrl-char straight into the pty; and each
  glyph-capture fire is a disk write + Explorer reveal.
- `dispose()` restores LIVE geometry, not the fire-time capture, so a user
  resize inside the 60ms shrink window survives an unmount race.
