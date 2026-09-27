## 2026-09-24 -- WP2: Codex accounts service, launch handoff and codex_review on the reviewer account

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`), the first complete
Codex vertical slice. The plan and every decision are in `docs/wp2/plan.md`.
This entry covers the work of 2026-09-23 and 2026-09-24.

### What landed

- **Commit 3 (`4ee41a8a`).** The accounts service, its IPC and preload
  bridge, launch leases (`session` and `review`), reviewer-account
  resolution (explicit, else the reviewer default, else the provider
  default), and the one-way API-key channel.
- **Commit 4 (`39952b89`).** A Codex session runs only from a launch the
  accounts service prepared: account binding, per-launch acknowledgement of
  an unverified sign-in, lease, re-verified executable, and the realm
  environment through `realmEnvForProvider`. pty-manager holds the lease
  for the session's life. Codex is local-only in this release, refused
  first on SSH.
- **Kill fix (`60ea77be`).** A stopped Codex run ends its whole process
  chain even when the process table is slow to read. This was the "must fix
  before the PR leaves draft" item.
- **Commit 5a (`d03b8247`).** `codex_review` runs on the reviewer account's
  prepared launch through a provider-neutral seam (`ProviderPackage.review`).
  It is one isolated `codex exec` with a constant argv, the request on
  stdin, and the pinned JSONL read as it streams. The reply is bounded and
  redacted. A session runs one review at a time, cancelled with its request
  or its session. The legacy streaming spawn is deleted.
- **Spec (`75666fa4`).** The Hello Codex introduction, for owner review
  (`docs/wp2/hello-codex-spec.md`), with acceptance criteria as pending
  tests. plan.md also records the `claude_review` (5b) design and three
  owner decisions.
- **Evidence (`e15cb3c1`).** A real-process proof of the reviewer on
  Windows (npm shim and cmd.exe). Two pinned-CLI answers: a project-level
  Codex configuration cannot redirect the model provider, and a key kept in
  a home's `.env` is not a sign-in.

### How each production commit was checked

Each got one bounded ADR-009 round with Opus attackers and a confirmation by
the same attackers. Each has mutation proofs: every new guard's test fails
under its mutant (commit 4 30/30, 5a 34/34). Real-process suites ran on the
disposable Windows VM and in CI, never on the owner's workstation. The
passes also surfaced pre-existing findings in shipped code; those were
routed privately.

### Open

- `claude_review` (5b) waits on three owner decisions (plan.md, "Commit 5b").
- The renderer (commit 6) waits on the owner's canvas review of the Hello
  Codex mockup.
- The SSH live matrix is required before merge (commit 4 touched
  pty-manager).
