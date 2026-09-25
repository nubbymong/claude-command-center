## 2026-09-25 -- WP2: one Accounts surface for both providers, Codex onboarding, review both ways, and the guidance sweep

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`). This entry covers
the renderer slice (commits 6a to 6g), main's provider-off launch rule
(`accec3c2`) and the user-facing guidance commit (7). The earlier WP2 work is
in the two 2026-09-24 entries.

### What landed

- **6a (`ad0f6a16`).** One platform rule for Claude reviews: on macOS only the
  normal Claude sign-in runs them, and a reviewer choice that rule refuses is
  cleared at start with a notice. `claude_review` gets its own switch.
- **6b (`37876e4f`).** Settings, Accounts is one surface for both providers: a
  Providers card (on/off, status, version), the Claude profiles with their
  reviewer state, and Codex accounts with state, badges and a menu (make
  default, make reviewer, sign in again, check sign-in, sign out, inactive,
  archive), add account (browser, device code, API key), this computer's own
  Codex sign-in, unfinished setups and identity conflicts. Sign in again asks
  for an explicit "same account as before".
- **6c (`f4e6d940`).** New saved config picks the Codex account; an
  unverified sign-in is confirmed per launch and never remembered. A Codex
  session's header has Restart and "Restart and pick a conversation".
- **6d (`212629a6`).** Settings, General, Built-in tools: a Code review group
  with one switch per direction, the account reviews use, and why a review
  cannot run. `codex_review` is offered only while a Codex review could run.
- **6e (`ca441e86`).** Onboarding asks fresh installs which assistants they
  use; "Use Codex only" when Claude Code is not installed; the Set up Codex
  page (install or update in a visible terminal tab, sign in, or use this
  computer's sign-in). With Claude Code off, nothing launches Claude.
- **6f (`e2b44981`, `fa2b2acf`).** Hello Codex: five pages, shown once when
  Codex is on and a Codex account the app added is signed in, replayable from
  the Feature Guide and Settings, Accounts.
- **6g (`ee9a122f`).** The legacy single-account Codex path is retired: the
  Settings Codex tab, the singleton sign-in and its channels. Test connection
  became Check sign-in on each account.
- **`accec3c2`.** Main, not only the renderer, refuses every launch of a
  provider that is off, on every launch path; the tab says "Not started" and
  keeps its conversation.
- **7 (guidance).** The What's New entry (written as `2.1.1-beta.2`;
  `release.js` rewrites the version and date at release), the Feature Guide
  and Ask Conductor knowledge (new Providers and Code review sections, a
  rewritten Codex section, three Codex known issues with their workarounds),
  six new tips and two corrected ones, two new tour and Feature Guide cards
  (Providers and Accounts; Code Review, Both Ways) and an updated Codex card,
  README, `docs/USER_GUIDE.md`, `PRIVACY.md`, and the documentation sweep
  record `docs/wp1/evidence/release-qualification.md`. AC14 of the Hello Codex
  spec is now a real test.
- **Visual fixes (`4561e643`).** Keyboard focus, layering and layout found by
  the VM visual run (onboarding pages, Hello Codex, the close dialogs).
- **Final fix batch (after the whole-branch reviews).** The WP1 retirement
  ledger now states what the branch did, row by row (rows that claimed a
  change on an unchanged file, or "unchanged" on a changed test, are
  corrected), and every baseline test whose test names changed carries a
  mapping; the traceability manifest points at the tests that exist, with a
  check that a missing path is never a wrong pointer. A provider's CLI is
  looked for only while the provider is on: Check again refuses while it is
  off or while its saved on/off cannot be read, and turning a provider on
  looks for the CLI once, when the switch is saved (never again for a
  provider already on). A Providers switch whose save does not land says so.
  Two unused Codex session methods refuse instead of looking Codex up on
  PATH. The Codex capability declarations match the package (discovery and
  install recipes supported). The Conductor MCP page shows whether Codex
  review and the new Claude review card are offered now, and why not. A Codex
  newer than tested says it will still be used. User-facing text spells
  "Built-in Tools" as the Settings section does (code comments and older
  records are not all changed). The Resume card's hint names the remote tmux
  session as the app creates it, as an exact, quoted target.
- **SSH with tmux to a host whose login shell is zsh.** zsh is the macOS
  default, but the fix covers any such host. Claude now starts there: zsh
  read the remote session name as a command and stopped the start line, and
  End did not close that remote session or remove its files; the remote
  session name is now quoted. The live SSH harness changed with it: every
  lane that launches Claude now requires Claude to have run, and the harness
  no longer writes to the machine's real app data folder.
- **Live SSH matrix** (from the Windows test VM; 38cbc9d7 for 185, the Pi,
  the Mac and multi-session, c8079555 for Rocky and WINDOWS_2, with no SSH
  file changed in between). Pass: T1 to T6 (the Mac lane now with Claude
  really running), T9 to T15, multi-session, T27, T20, T21, T23, T25, T26,
  and T7: the Windows remote passes, so it is no longer reported as an
  upstream gap. T11 first failed on an environmental precondition: Claude
  Code's own setup dialog on the Rocky test host held the reattached
  session. It passed once that dialog was dismissed on the test host, which
  is recorded as a test precondition, not an app fix. T24 failed on a real
  gap in End, fixed below. Re-run on Rocky at 9eba7983 (the fix): T20, T21,
  T23, T24 and T25 all pass; T24's End reported `container-needs-sudo`, and
  the command it shows, run on the host, left no Claude in the container.
- **End in a rootful container with no saved sudo password (T24).** When
  the sudo password was typed at the prompt rather than saved, End's
  in-container stop could only try sudo without a password, failed
  silently, and End reported completed while Claude kept running in the
  container. End now asks first whether sudo can run the container engine
  without a password; when it cannot, it prints a one-time marker on a line
  of its own that End reads, and reports a distinct outcome
  (`container-needs-sudo`). The in-container stop is still attempted either
  way (without a password it fails fast; where sudo allows it, it works), and
  the host tmux session and the session's files on the host are still ended.
  The probe's own redirections run inside `sh -c`, so outside quotes the
  line uses only `;`, `||`, `2>/dev/null` and single quotes, meant to parse
  in every host login shell a container session can have: sh, bash, dash,
  zsh, fish, and tcsh/csh at parity with the line before. What was run: a
  shell test (`ssh-end-remote-shell-compat.test.ts`) ran the line through
  bash, sh and dash only, in WSL; zsh ran it live on the Rocky lanes T24
  (the probe form) and T25, both on a zsh login shell and both passing at
  9eba7983, and first runs in that test on the macOS CI runner; fish and
  tcsh/csh are reasoned from their grammar and have not been run anywhere
  yet. The app then shows one notice, on top of every other dialog
  and not dismissible by a stray key or click (an arming delay on the
  monotonic clock, held-key repeats ignored, focus kept on it while it
  shows): Claude may still be running in that container, the exact command
  that stops it (the same in-container script End runs, file removal and
  anchored pkill, with a sudo that asks for the password) to copy, and
  where to save the sudo password in the config (Edit, Runtime, Sudo
  password, with Save password left ticked) so End can do it in sessions
  started after that. Known issues and the changelog say the same. The T24
  lane now expects that outcome and runs the shown command.
- **End in a container without bash, and bulk close of container sessions.**
  End's in-container stop ran under `bash -c`, so in a container without
  bash it failed silently and Claude kept running; it now runs under
  `sh -c`, which every container a session can enter has. Closing several
  sessions at once (selected with Ctrl-click, or Cmd-click on a Mac, or
  with Close all in a group or section) only closed them locally, so a
  container session's Claude was left running in the container; it now
  gets the same End as closing its tab.

### Decisions

- Codex sessions and Codex reviews run on this computer only in 2.1.1 (owner,
  2026-09-24); the guidance says so wherever Codex is described.
- A Codex sign-in the app did not create (`~/.codex`) is confirmed at each
  launch and never reviews; the guidance states both limits and the workaround
  (add a Codex account and make it the reviewer).
- The two new Feature Guide cards are pinned at `2.1.1`, like the Ask
  Conductor card. They are reached from the Feature Guide and its Feature
  tour; the tour no longer opens by itself after an update, and a higher pin
  would only hold the start-up sequence until an onboarding run stamps the
  tour version, so it was not raised.
- The guidance claims only what this build does. Where the old copy claimed
  more (Codex conversations in Logs, a transcript switch that also stops the
  Tokenomics index), it now says what is true.

### Open

- `docs/wp1/evidence/release-qualification.md` holds the documentation sweep
  only; the release-run record (WP1.37, WP1.73) comes from the VM and CI
  qualification run.
- `docs/wp1/evidence/mode-matrix.md` records the VM e2e run on `633d37db`
  (77 tests, 76 pass; the one failure is the known DPAPI limit under the
  VM's SSH logon). It is partial: WP1.1 and WP1.60 stay planned (the
  upgrade, restart, enable/disable and real-launch modes are not in it).
- Traceability still names tests and records that are not written yet (the
  mode-matrix, pinned-source, fake-keyring, migration-interruption, rollback
  and re-authentication staging tests; the real-CLI, keyring, CI, rollback,
  packaged and skip records; the fake CLI oracle), and the e2e spec
  `tests/e2e/onboarding-provider-select.spec.ts` that WP1.1 names.
- The config.toml heal (`src/main/providers/codex/mcp-config.ts`): the
  adaptation planned in `docs/wp2/plan.md` step 4 (an explicit realm path in
  place of its own resolver) was not done. The heal still targets the Codex
  home the app inherited, the only place older builds wrote the block, so its
  ledger row is `retain`. Owner decision pending: keep it as it is, or do the
  adaptation.
- Training screenshots that still show the retired Settings Codex tab or its
  pointer need a recapture (listed in the release-qualification record).
- T24 (live SSH, rootful container, sudo password typed rather than saved):
  End now reports that Claude may still be running in the container and
  shows the command that stops it, instead of reporting completed (owner
  decision 2026-09-25, "honest End now"; see What landed). The lane passes
  at 9eba7983. Still open: End stopping it without a saved password (out of
  scope by that decision).
- End needs pkill inside the container, for its own stop and for the command
  the notice shows. Both tested fixture containers on Rocky (rootless and
  rootful `ccc-test`, built on node:22-bookworm, Debian 12) have it
  (procps-ng 4.0.2); node:22-bookworm's own layer history installs procps.
  Slim images often leave procps out; there End's stop fails and Claude may
  keep running, silently except on the sudo-notice path, where the command
  shown fails the same way. Recorded as a known limitation (known issues say
  it, with the workaround) rather than handled in this change.
