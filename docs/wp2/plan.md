# WP2 plan: the first complete Codex vertical slice

PR 2 of at most four for 2.1.1. Base: `beta` after PR #619 (WP1) merged.
The spec is the approved design
`WORK-PACKAGE-1-PROVIDER-IDENTITY-SETUP-DESIGN.md` in the private planning repository
(candidate digest `e4d5b99a…83140`), the owner decisions
`docs/wp1/owner-decisions-2026-09-20.md`, and the owner's WP2 instruction of
2026-09-23 (below). Gate 0 is not repeated: the baseline, the legacy Codex
manifest and ledger, the traceability manifest and the characterization tests
carry over unchanged.

## Owner scope (2026-09-23, verbatim bullets)

1. Detect, install and update the Codex CLI, including first-run selection and a Codex-only installation.
2. Authenticate Codex using supported official flows.
3. Create and maintain isolated Codex account realms with multiple-account support.
4. Associate provider accounts with the shared identity model without duplicating global friendly names, colours or groups.
5. Select a Codex account and launch/resume an interactive Codex session in that exact realm.
6. Retire superseded legacy Codex paths only after their replacements and regression tests exist.
7. Preserve existing Claude behaviour.

Excluded: Fleet, Supervisor, Proxy, tokenomics parity, unrelated Claude hardening.
One bounded ADR-009 review before each production commit, a confirmation after
fixes, no repeated rounds without a real blocker. Non-blocking discoveries go to
aicc_planning. TDD, Opus 5.5.

## Flow

```
 first run / Settings                 Accounts (one surface)                 New session
 ─────────────────────                ───────────────────────                ────────────
 [Provider select] ──► Claude? ──► existing Claude steps (unchanged)
        │
        └──► Codex? ──► detect CLI ──► missing/old ──► install/update recipe (shown, copied,
                          │                             or run in a visible terminal) ──► re-check
                          ▼
                    found + supported
                          │
                          ▼
                 Add Codex account ──► journal (pending realm) ──► managed CODEX_HOME
                          │                                          (owner-only dir)
                          ▼
                 sign in: browser │ device (beta) │ API key (one-shot non-TTY stdin)
                          │   genuine CLI, CODEX_HOME=<realm>, allowlisted env
                          ▼
                 `codex login status` in the same realm ──► commit account + identity
                          │                                  (name/colour/group on the IDENTITY,
                          ▼                                   linkable to a Claude identity)
                 Session dialog: pick active Codex account (default preselected)
                          │
                          ▼
                 pty:spawn { providerAccountId } ──► main resolves account → realm,
                          checks lifecycle + executable identity, takes a lease,
                          strips ambient Codex/OpenAI authority, sets CODEX_HOME last
                          │
                          ▼
                 codex / resume picker run INSIDE the realm; telemetry and the
                 tokenomics indexer read <realm>/sessions; lease released on exit
```

Existing users: the default `~/.codex` sign-in (if any) is registered once as an
`external-default`, realm-only account ("External Codex sign-in — account
unverified"). It launches only with a per-launch acknowledgement; adding a
managed account is the recommended path.

## Architecture decisions (made here, recorded for review)

- **A1 Registry.** One versioned JSON document `<resources>/providers/registry.json`
  (identities, groups, provider accounts, realms, setup journals, Claude legacy
  links + legacy-source digest). Atomic write (stage, re-read, validate, rename),
  owner-only, timestamped backup before the first mutation of a boot. Corrupt or
  newer-schema file → recovery mode: the app still starts, Claude keeps working
  from `profiles.json`, Codex managed accounts are unavailable with a visible
  error. Never holds a token, key, login URL or raw path the renderer can use.
- **A2 Pure core.** Record types, validators and every transition (create, link,
  unlink, lifecycle, default, journal) are pure functions in
  `src/shared/providers/` so they get transition-table and property tests; the
  main store only serialises, persists and publishes.
- **A3 Identity owns presentation.** `friendlyName`, `colourKey`, `groupId` live
  only on `ConductorIdentity`. A Codex account has none of them. Claude profiles
  migrate one-to-one into private identities (deterministic ids derived from the
  profile id, so a rerun cannot duplicate). Claude keeps `profiles.json` as its
  source in 2.1.1; the Claude package writes identity name/colour changes back to
  it (compatibility shadow) and a startup reconcile imports legacy edits
  (downgrade / re-upgrade), surfacing a conflict instead of guessing.
- **A4 Enablement.** Stays in settings (`codexEnabled`, new `claudeEnabled`,
  absent = on for Claude) because 13 files already read it; main now reads it
  too, and every change goes through a main-side check (last-enabled provider,
  running consumers) before the renderer writes it.
- **A5 Realms.** Managed Codex realm = `<resources>/codex-realms/<realmId>`,
  created with the existing `mkdirSecure`/ACL primitives; ids are opaque hex;
  canonical-path uniqueness (case, symlink/junction) enforced before commit;
  links below the managed root refused. External default = the `CODEX_HOME`
  the app inherited, else `~/.codex`, canonicalised; never copied or moved.
- **A6 CLI operations.** Status, logout and login run the resolved executable
  under a strict allowlisted environment with `CODEX_HOME` set to the realm
  (design 9.2, D3). Browser and device login stream redacted output to the
  setup surface; cancel kills only that process. API key: the renderer control
  is an uncontrolled password field read once on submit and cleared; the value
  crosses on a dedicated one-way channel bound to a main-issued single-use
  handle for a pending login, is written to the child's stdin pipe (never a
  PTY, never argv) and is not stored, logged or echoed.
- **A7 Status parsing.** Only `codex login status` output and exit code:
  `Logged in using ChatGPT` → browser/device, `Logged in using an API key` →
  apiKey, other `Logged in` → signed-in/unknown method, exit 1 `Not logged in` →
  signed-out, anything else → error. `auth.json` is never opened. No email or
  plan (the CLI exposes neither without token parsing), so every Codex account
  is `realm-only` or `user-asserted`, never `verified-subject`.
- **A8 Discovery.** Reuse the existing resolver, canonicalise with `realpath`,
  prove the version with `--version` under the launch environment, classify
  against min `0.153.4`, pinned `0.155.1`, max tested `0.156.1` (newer =
  `too-new`, warned, allowed; older = `too-old`, blocked). Record path, size and
  mtime; a launch or login whose resolved executable differs is blocked until
  the user re-checks.
- **A9 Install/update.** Code-defined recipes from the openai/codex README at
  `39a2438d`: `npm install -g @openai/codex` (all OS), `brew install --cask
  codex` (macOS) — runnable in a visible Conductor terminal after an explicit
  confirmation; the `install.sh` / `install.ps1` pipe-to-shell scripts are
  shown and copied only (the Windows one bypasses execution policy). Update:
  `npm install -g @openai/codex@latest`, `brew upgrade --cask codex`. Zero exit
  without a discoverable supported binary is a failure.
- **A10 Launch handoff.** Codex spawn requests carry `providerAccountId` (and
  `acknowledgeRealmOnly` for an external account). Main validates the account,
  realm and lifecycle, re-verifies the executable, acquires a consumer lease,
  and applies the realm through `realmEnvForProvider('codex', …)` over the
  inherited environment (D3). No binding → the launch fails visibly. Telemetry,
  the resume picker, the per-spawn MCP config and the `codex_review` tool use
  the realm's home, not a process-global one. Leases are released on PTY exit.
- **A11 Leases.** One main-process consumer registry (PTY sessions, login
  flows). Lifecycle mutations (inactivate, archive, logout, disable) run under
  one async lock and refuse with the consumer list; acquisition takes the same
  lock, so a launch cannot slip between the check and the mutation.
- **A12 Claude unchanged.** The Claude launch path keeps `profileId` and
  `withProfileHome`; Claude sign-in keeps its existing flows. Claude appears in
  the neutral Accounts surface through its identity; its row detail (web session,
  isolation notice, remove) is supplied by the Claude renderer package.
- **A13 Tokenomics (D10, narrow).** The indexer discovers sessions directories
  from every active managed Codex realm plus the external default. No other
  tokenomics change.

## Commits (each: failing tests first, focused suite, typecheck, one bounded ADR-009 pass on the uncommitted diff, confirmation after fixes, commit)

1. **Registry core.** Pure model/validators/transitions; main store with atomic
   persistence, backup, recovery mode; Claude migration + shadow + reconcile
   through a Claude package hook; provider-neutral read IPC.
   Tests: identity-registry, account-state-machine, registry-store,
   migration-claude, migration-interruption, rollback-reupgrade,
   account-registry-uniqueness.
2. **Codex package adapter.** Discovery, compatibility, executable identity,
   install recipes, realm paths/creation, allowlisted CLI runner, status/logout,
   browser/device/API-key login, fake CLI + oracle, pinned-source contract;
   capabilities flipped to `supported` where backed; current-Codex migration to
   an external-default realm.
   Tests: cli-discovery, install-recipes, realm-paths, codex-realm-isolation,
   codex-auth-adapter, env-allowlist, fake-cli, codex-pinned-source-contract,
   migration-codex, capability-registry, provider-installation-state.
3. **Accounts service + IPC + leases.** Add-account journal flow, recovery,
   lifecycle and default rules, logout, identity link/unlink/groups, provider
   enable/disable checks, secret one-shot channel; preload + typings.
   Tests: provider-ipc, consumer-leases, account-lifecycle,
   setup-journal-recovery, secret-entry, secret-scan, fault-isolation.
4. **Launch handoff.** pty-handlers schema + pty-manager Codex branch, realm
   env, lease, telemetry/picker/MCP/codex_review realm routing, tokenomics
   realm discovery.
   Tests: launch-handoff, tokenomics-realm-discovery, adapted spawn/telemetry/
   mcp-config/codex-review tests.
5. **Renderer.** Neutral provider store, one Accounts surface, add-account and
   sign-in flow, Settings providers section, onboarding provider selection +
   Codex setup step, session dialog account picker, persistence of the binding;
   delete the legacy store, steps, settings tab, IPC handlers and channels.
   Tests: provider-store, accounts-surface, setup-surface, settings-providers,
   onboarding-provider-steps, mode-matrix, adapted renderer suites, e2e.
6. **Docs, ledger, evidence.** README, USER_GUIDE, PRIVACY, app-knowledge
   (+ known issues), tips, changelog; ledger rows resolved; traceability
   statuses; CONTEXT.d fragment; evidence records.

Then: full suite (Git Bash), typecheck, CI (Windows, macOS), exact-head spec +
quality reviews (Opus), draft PR with the ADR-009 marker.

## Carried forward from slice 1's ADR-009 pass (2026-09-23)

The pure registry and the Claude snapshot passed after two fix rounds (three
Opus lenses: untrusted input, binding bypass, reconcile blast radius). These
obligations fall on later slices:

- **Store (slice 2 of commit 1):** call the Claude reconcile only after
  profiles.json was read successfully -- `listProfiles()` returns `[]` on any
  error. The pure reconcile already treats an empty/unusable snapshot as
  unreadable, but the store must not rely on that alone. Pass
  `ctx.consumers` from the lease registry. Log `warnings`.
- **Legacy write applier:** name and lifecycle go to profiles.json in main;
  colour goes to `settings.accountColourOverrides[canonical email]` when the
  profile has an email (the snapshot reads the same key first), else
  `profile.colourKey`. Write values verbatim (already capped to 120 UTF-16
  units). Profiles sharing an email share a legacy colour; that is the legacy
  model, pinned by a test.
- **Accounts service (commit 3):** an explicit "reconcile this sign-in" action
  is the only way to clear `blocked`; a restored legacy account comes back
  `attention` and needs a fresh status check. `resolveIdentityConflict` backs
  the conflict UI. The Claude default is read-only in the neutral UI
  (`legacy-owned`).
- **Lease slice (from slice 2's pass):** pass `consumers` to the store (today
  the "deferred while in use" rule never fires because reconcile runs only
  at start). Before any mid-run reconcile, re-create the store on a resources
  directory change (the file port captures the directory at init). The lock
  is not re-entrant: a holder must never await work that only a queued caller
  can finish.
- **Codex runner and realms (from slice 3a's pass):** start npm's `codex.cmd`
  from its own folder (the env already sets
  `NoDefaultCurrentDirectoryInExePath=1`), resolve `npm`/`brew` to absolute
  paths before running a recipe, and block a CLI whose version is `unknown`
  as well as `too-old`. Canonicalise the external home with `realpath` and
  refuse it when it shares a FILE IDENTITY (device + inode) with the managed
  root or any managed realm: no string comparison sees 8.3 short names,
  `\\localhost\C$` or links.
- **Launch handoff (from slice 3b's pass):** a managed Codex launch runs the
  canonical path `verifyCodexExecutable` returns -- never a second
  resolution -- with the runner's hardening (shim folder as cwd, absolute
  cmd.exe, `NoDefaultCurrentDirectoryInExePath`). Persist the executable
  identity as recorded (whole-millisecond times). The identity binds the
  file PATH resolves (for npm, the shim), not the vendored binary behind it:
  same-user replacement of the package is outside the threat model. Flip
  `cli.discovery` / `install.recipes` to `supported` only when the setup
  surface and the recipe runner land (recipes need `npm`/`brew` resolved to
  absolute paths, and Windows `npm.cmd` through the same cmd.exe route).
- **Auth slice (from 3b):** the CLI loads `CODEX_HOME/.env`, which can carry
  `OPENAI_API_KEY` past the env allowlist; a managed realm is app-created
  and must stay free of one (refuse or warn on a `.env` at sign-in).
- **Known, accepted:** deleting the very last Claude profile does not archive
  its account (indistinguishable from a failed read); emoji ZWJ sequences
  store with spaces (stripSpoofableText); reconcile is quadratic in profile
  count (fine below thousands).

## Out of this PR (remaining Codex-parity work, carried to PR3/PR4 or 2.1.1 gates)

- Staged re-authentication into a replacement realm while signed in (WP1.52);
  WP2 re-signs a signed-out account in place with an explicit "same account?"
  confirmation.
- Real credential-bearing login/status/logout per OS, native keyring smoke,
  packaged-app smoke outside the checkout (WP1.11 native, WP1.63, WP1.64,
  WP1.71, WP1.72): owner-resourced gates (D8).
- Everything in design 3.2: history/transcript parity, statusline and usage,
  Sentinel/Watchdog, Canvas/Ask/Memory, logs/Tips/Cloud Agents, SSH Codex,
  model/pricing catalogue.
