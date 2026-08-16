## 2026-08-16 -- Account/auth fix batch (right-click paste, CLI-auth path, usage inactive)

Four related account/terminal fixes landed on beta, from a holistic review of the
auth surfaces after the owner reported that right-clicking in a terminal pasted
instead of copying and that a signed-in account read "not signed in".

- **#276 (merged)** -- ssbn's Cloudflare-challenge fix for the per-account
  claude.ai web sign-in (session pill / "Open artifacts"). Brought into the batch
  because it is the same auth surface. Issue #269 labelled in-beta.

- **#278 -- right-click must never blind-paste into a mouse-mode terminal.** The
  contextmenu handler decided copy-vs-paste from xterm's selection alone; while a
  program tracks the mouse xterm disables its selection service, so "no selection"
  was always true and every right-click pasted the clipboard into the PTY -- at a
  shell prompt, execution. Two halves: the protective CLAUDE_* env (mouse /
  alternate-screen / mouse-clicks / background-tasks) is now stamped for shell-only
  and elevated sessions too (a hand-run `claude` there used to keep mouse tracking),
  and the renderer decision is now copy / paste / menu -- an explicit context menu
  (with a Shift+drag "how to copy" hint) whenever a blind decision would be unsafe.
  Clipboard text is sanitised (C0/ESC/DEL stripped, newlines kept) at the single
  read chokepoint, so the blind path, the menu, and Ctrl+V are all hardened against
  a crafted paste-mode breakout. Bounded adversarial pass recorded PASS on the PR.

- **#279 -- correct the #258 CLI-auth credential path.** The code-session auth
  check read `<profileHome>/.credentials.json`; every other reader/writer uses
  `<profileHome>/.claude/.credentials.json`, so the fallback could never resolve and
  a signed-in account rendered "not signed in" whenever the CLI probe failed. Also:
  the 10s synchronous probe (fired on every session right-click and accounts-panel
  mount) is now async off the main loop, and it registers as a transient credential
  consumer (new profile-consumers.ts) so the usage-page auto token-refresh will not
  rotate a token under it. Introduced by #258; labelled in-beta.

- **#280 -- usage page aware of active/inactive accounts.** A parked account was
  still network-polled, still auto token-refreshed (rotating a parked account's
  single-use token), and still offered a sign-in that opened a login shell bypassing
  the switcher's active-guard. AccountUsage now carries `active`; a parked account
  short-circuits to an "inactive" card (greyed, no sign-in, not polled).

Every fix ships with mutation-proven regression tests (revert the fix, watch the
named test go red). Full suite green at each merge. No release -- these sit on beta
for the owner to ship. Nav-rail 2-account gate counting inactive profiles, and
SSH-Claude right-click paste parity (remote claude never gets DISABLE_MOUSE), are
left as owner decisions, noted on #278/#280.
