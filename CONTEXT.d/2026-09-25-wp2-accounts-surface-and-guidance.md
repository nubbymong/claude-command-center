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
  only; the release-run record (WP1.37, WP1.73) and the e2e mode matrix
  (`docs/wp1/evidence/mode-matrix.md`) come from the VM and CI qualification
  run.
- Training screenshots that still show the retired Settings Codex tab or its
  pointer need a recapture (listed in the release-qualification record).
- The SSH live matrix is still to run before merge.
