## 2026-09-26 -- WP2 P2: upgrade walk from v2.1.1-beta.1 on the Windows test VM, and its fixes

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`). Local commits only;
not pushed. Walks the upgrade that `docs/wp1/owner-decisions-2026-09-26.md`
(U1 to U3) describes, from the newest beta to this branch, in the installed
app. The rows it moved are in `docs/wp2/parity-checklist.md`.

### Baseline and candidate

- **Baseline:** v2.1.1-beta.1, the newest beta-channel release (GitHub,
  published 2026-09-20): `AI-Code-Conductor-2.1.1-beta.1.exe`, 185,568,080
  bytes, sha256
  `379ac216baae55181388ef1ba9f08615ef73f033d32ea76d624db08aac36f47e` (equal
  to the release's asset digest), signed (Authenticode valid).
- **Candidate:** `95385267`, unsigned NSIS `AI-Code-Conductor-2.1.1-beta.2.exe`,
  185,752,572 bytes, sha256
  `a31122846ca6c2943032dbc276223931f179fe09a76bf3d9c01c7f82151d7f59`.
  `package.json` still reads the baseline's version, so the version was set to
  2.1.1-beta.2 at build time only (no tracked change) to make the install a
  real upgrade. Earlier passes: `c3569b3d` (the walk that found the first
  defects) and `c6dc4b60` (re-verification).
- **Host:** WINDOWS_1, a used Windows 11 Hyper-V test VM. Each fixture's data
  was written by the beta's own UI, then the candidate was installed in place
  over it. The updater was blocked on the VM for the walk.

### Verified (fixture, auth class)

Fixtures: F1 Claude-only; F2 Claude and Codex with a saved Codex session; F2b
with saved Claude and Codex sessions; F3 Codex-only. Auth classes:
AUTHENTICATED (real Codex CLI, this computer's `~/.codex` signed in),
SIGNED-OUT (real CLI, `CODEX_HOME` naming a signed-out folder), NOT-INSTALLED,
MOCKED (seeded state or the e2e fake CLI).

- **Every fixture** (a real Codex CLI present): "Do you use Codex?" after the
  release notes, again after a quit unanswered, never after an answer; the
  beta's Codex setting is not carried over and nothing of Codex starts until
  the answer; configs survive unchanged, and settings change only by the
  answer and new defaults.
- **No** (F1, F2, F2b, F3): Codex configs and restored Codex tabs are refused
  with the off wording; a refused tab is Not started, not Running, and its
  config can still be launched or deleted.
- **Yes, Set up Codex:** a too-old 0.142.4 (standalone) and 0.150.0 (npm) each
  got only their own update; the page's npm install (NOT-INSTALLED) and npm
  update, and the standalone installer run by hand, reached 0.157.1, found by
  Check again. The read-only check of a signed-in `~/.codex`, "Use this
  sign-in", then a real Codex launch after the per-launch confirmation
  (AUTHENTICATED); the check alone added no account. F3: a signed-out
  `CODEX_HOME` is named on the page and in Accounts (SIGNED-OUT); an unusable
  one gets main's reason and names no folder.
- **Restore:** the resume prompt names Claude and Codex and tags a session that
  will reopen Not started; a Not started copy cannot be restarted while a live
  copy runs (one Codex process); a restored Not started copy plus a fresh
  launch leaves the config out of Multi Spawn; the partner strip names Codex on
  a Codex tab.
- **Codex-only** (F3, Claude Code off, SIGNED-OUT): no Claude install or
  sign-in demands. Still seen, for P3 (recorded only): the title-bar Claude.ai
  pill, the Accounts Claude card's sign-in prompts while Claude Code is off,
  and Ask Conductor saying it runs on Claude Code (truthful).
- **MOCKED** (seeded; the beta cannot write these): Hello Codex right after Set
  up Codex with a managed account and the fake CLI, shown once, replayable
  from Settings and the Feature Guide; "not set up" on Accounts and the New
  session dialog; No disabled while Claude Code is off; Multi Spawn
  grandfathering from two restored copies.
- **E2E on the VM:** 80/81 at `c6dc4b60` and at `95385267`, with
  `codex-reconfirm-upgrade.spec.ts` 3/3. One pre-existing e2e failure is
  routed privately.

### Defects found and fixed

- `c6dc4b60` (from the walk at `c3569b3d`): a standalone Codex could not be
  updated from Set up Codex (the update now follows how Codex was installed);
  the page named `~/.codex` when `CODEX_HOME` points elsewhere; the Accounts
  card said the app had not looked at the sign-in right after the page checked
  it; a tab refused before it started counted as running and blocked launch
  and delete; the resume prompt named Claude for Codex sessions.
- `95385267` (from the re-verification at `c6dc4b60`): an unusable
  `CODEX_HOME` showed a wrong "overlaps" note; a restored blocked tab read
  Running until first viewed; the no-account refusal lacked the "Not started:"
  form; the partner strip said Claude on Codex tabs. Review follow-ups: Multi
  Spawn grandfathering is decided once from what the start restored, and the
  Partner Terminal tip is provider-neutral.
- With this record (spec review): the Command Targeting tip and the Feature
  Guide's Combined Mode card no longer name only Claude; they say the
  assistant, or Claude or Codex, as the Partner Terminal tip does.
- Each behaviour fix has a test that fails when it is reverted. Both commits
  passed independent spec and code-quality reviews; `c6dc4b60` also passed an
  ADR-009 pass (install recipes, the setup page's folder display string, launch
  state): no security break, confirmation round PASS.

### Limitations and still owed

- Windows only, an unsigned candidate, a used test VM rather than a clean
  machine: partial Packaged evidence, never full. macOS and Linux packaged
  runs are owed.
- Real Codex at 0.142.4, 0.150.0 and 0.157.1 only; the minimum 0.153.4 and the
  pinned 0.155.1 are owed where a row needs them.
- A managed Codex sign-in, and Hello Codex on a real account, need the
  owner's ChatGPT sign-in or API key; until then Hello Codex is MOCKED.
- Screenshots (144 PNGs: dark and light, wide and narrow, e-mail addresses
  anonymised) are local and gitignored in
  `.ccc-canvas/screens/p2-upgrade-95385267/`, approved by the owner 2026-09-26; none
  are in the repo.
- Out of P2 scope: at the narrow window the GitHub button overlaps the partner
  strip's label, on Claude and Codex tabs alike; the layout predates this
  branch.
