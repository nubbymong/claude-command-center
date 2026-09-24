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

## Scope additions and revised allocation (owner, 2026-09-24)

Completed slices stand: their mutation campaigns and broad suites are not
rerun because the plan changed. New or affected behaviour gets targeted
tests; filesystem and process integration runs on the VM and CI; the full
suite and the final exact-head reviews are for the end-to-end candidate.

**Additions**

- **Hello Codex.** Once Codex is enabled and set up successfully, a
  dedicated introduction page, part of the FULL-SCREEN post-install
  experience. It explains Codex accounts, launching and resuming sessions,
  code review, and the key differences from Claude. Mockups go on the Agent
  Canvas for the owner's review BEFORE the renderer slice implements it.
  Spec: `docs/wp2/hello-codex-spec.md` (2026-09-24, for owner review); its
  acceptance criteria are pending cases in
  `tests/unit/renderer/hello-codex.acceptance.test.ts`.
- **Bidirectional provider review through MCP.** A Claude session gets
  `codex_review`; a Codex session gets `claude_review`.
  - Each review is an isolated reviewer invocation: a fresh,
    non-interactive process of the reviewing provider. No delegation to a
    live session.
  - A review is bound to the requesting session's project and to the exact
    working tree, range or paths it names.
  - The reviewer account is explicit per request, or a default reviewer
    account per provider (falling back to that provider's default account).
  - No self-review loops: a reviewer invocation cannot request another
    review (depth one), and a session is offered only the other provider's
    tool.
  - The existing session security boundaries hold: the per-session MCP
    token, project binding and realm isolation.
- **Provider-neutral review architecture now,** so it needs no retrofit:
  the accounts service and the launch handoff treat a reviewer invocation
  as one more account consumer. It resolves an account to a binding, takes
  a lease of kind `review`, and composes the realm environment through
  `realmEnvForProvider`, exactly as a session does.

**Revised commit allocation**

1. Registry core -- done.
2. Codex package adapter (slices 3a-3e) -- done.
3. Accounts service, IPC and leases -- in progress. Adds a `review` lease
   kind, reviewer-account resolution (explicit, else the per-provider
   reviewer default, else the provider default) and one lease API shared
   by sessions and reviewer invocations.
   - One launch-lease API: `acquireLaunchLease({ kind: 'session' | 'review' })`
     and `releaseLaunch`. The reviewer choice, the launch binding and the
     lease are made under the one registry lock. A chosen reviewer account
     that cannot run is refused, never swapped for another.
   - The reviewer default lives in the registry (`isReviewerDefault`, at most
     one per provider, never archived; schema 3, schemas 1 and 2 upgrade).
     An unverified realm-only sign-in cannot be the reviewer default: its
     per-launch acknowledgement cannot come from an unattended review.
   - Sign-in drift (design 5.3, 5.5): a status check compares the kind of
     credential (provider account or API key) with the method on record; a
     change blocks the account. An external sign-out or archive checks the
     home first and is refused while blocked. "Reconcile this sign-in" is
     the only way to clear `blocked`: a fresh check the user vouches for.
   - Identity conflicts are in the snapshot and settled over IPC (keep this
     app's value or the provider's).
   - A resources directory chosen after start (first-run setup) re-creates
     the registry there, with the start-up reconcile and adoption; a
     reconcile against a registry from another directory is refused.
4. Launch handoff -- as planned. One realm-bound launch builder (account
   -> binding -> lease -> realm env -> proven executable) serves both
   interactive sessions and reviewer invocations.
5. Provider review through MCP -- new.
   - A provider-neutral review core: request shape, binding to the project
     and to the exact tree, range or paths, reviewer-account choice, depth
     guard, and per-provider review adapters on the package contract.
   - `codex_review` moves onto it, and `claude_review` is added.
   - Targeted tests only.
6. Renderer -- as planned, plus the Hello Codex full-screen page (only
   after its canvas mockups are reviewed) and the reviewer-account default.
7. Docs, ledger and evidence -- as planned, plus Hello Codex and
   cross-provider review in app-knowledge, tips and the guides.

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
- **Realm creation (from slice 3c's pass):** the auth operations require a
  realm home that EXISTS and equals its own `realpath`, and lock it by file
  identity. Slice 3d must therefore create the folder before any sign-in and
  canonicalise `roots.resourcesDir` the same way (`realpathSync.native`): on
  a mapped network drive or a SUBST drive realpath returns the UNC or the
  underlying path, and an uncanonicalised root would make every realm
  `realm-unavailable`.
- **Accounts service and IPC (from slice 3c's pass):** the IPC schema must
  require the secret handle to be a string (a non-string handle is refused
  but cannot be consumed); the external-realm drift check before a logout or
  launch (design 5.5) uses the `credential` the status operation now reports;
  act on `AuthOperationResult.code`, never on message text; a failed or
  cancelled sign-in reports the realm's observed `state`, and `signed-in`
  there means the user finished anyway.
- **Accounts service (from slice 3d's pass):** remove an abandoned setup's
  folder BEFORE `abandonAccountSetup` (the folder is only found through its
  realm record) and keep the journal when removal fails; sign the realm out
  through the CLI first (a stored `auth.json` is refused as
  `credentials-present`, never deleted; a credential kept in an OS keyring is
  invisible to the folder layer); `all` proves the tree's shape, not who
  wrote it. The composition root's realm source reads a registry SNAPSHOT
  and takes no lock: removal awaits it while holding the realm lock, and the
  registry lock is not re-entrant. Wire it in `compose.ts` (`store.current()`
  plus the configured resources directory, and `mkdirSecure`). Build exactly
  one Codex package: the realm locks live in it.
- **Accounts service and renderer (from slice 3e's pass):** call
  `migrateExternalDefaultRealm` once at start, after the registry load and
  the legacy reconcile and outside `store.exclusive`, with a THREE-WAY
  preference read from settings (`codexEnabled` true = on, false = off,
  absent = undecided -- not the renderer's usual `!== false`). On
  `needs-confirmation` onboarding or Settings asks the user (design 6.3
  step 5, 8.2) and calls it again. A `skipped` or `none` marker leaves
  adoption to an explicit Accounts action ("use my existing Codex sign-in",
  design 9.3); the automatic run never repeats. A `skipped` marker carries
  its reason: the Accounts surface says why, and for `unavailable` (timed
  out, did not start, busy, or the CLI was being re-checked) and
  `no-answer` it offers "check again" rather than leaving a signed-in user
  silently unadopted. "Check again" IS the explicit adoption (status, then
  register); the migration itself never re-runs once a marker exists. The renderer offers
  re-authentication into a managed account (6.3 step 6) and shows
  "unverified" from `identityAssurance`, never from the identity's name or
  colour. Offer the explicit external adoption only once the start-up run
  has settled: until then a pending external setup blocks it. The run is
  bounded by the CLI runner's own timeouts (discovery and status). A caller
  with the same store joins it; one with another store object waits for it
  and then runs its own, so at most twice that bound. Pass the one store
  itself, not a wrapper, and do not add a second wait around it.
- **Pinned-CLI evidence (from slice 3e's pass):** check whether 0.155.1
  `codex login status` counts a key kept in `CODEX_HOME/.env` as signed in.
  If it does, an adopted external home is signed in by the user's own dotenv
  key: say so in app-knowledge (the key stays in that home; the app stores
  nothing).
  **Answered (2026-09-24, 0.155.1 source: `cli/src/login.rs`
  `run_login_status`, `login/src/auth/manager.rs` `load_auth`): it does not.**
  Status comes from the home's stored sign-in (auth.json or the keyring) or
  workload identity. `OPENAI_API_KEY` is never read there, the
  `CODEX_API_KEY` path is turned off for status, and the dotenv loader drops
  `CODEX_*` names. A home whose only key is in its `.env` reads "Not logged
  in", and the app says so; nothing needs adding to app-knowledge.
- **Launch handoff and review (from commit 3):** take every launch lease
  through `acquireLaunchLease`, and release it on exit through
  `releaseLaunch` with the same kind and owner id. Before an external-home
  launch, run the same drift check the sign-out runs (design 5.5), outside
  the registry lock and before the lease. A reviewer invocation whose chosen
  account is realm-only is refused with `acknowledgement-required`; decide
  in commit 5 whether the requesting session's user can acknowledge it.
- **Codex is local-only in 2.1.1 (owner, 2026-09-24):** SSH Codex stays out
  of this release, but it must be functionally gated and said so, not only
  hidden. Today the gate is the session dialog alone (SSH cards disabled for
  Codex; Codex's `session.ssh` capability is `unsupported`). Commit 4 adds
  the main-side refusal: a Codex spawn (or reviewer invocation) with an SSH
  session type is refused from the provider's `session.ssh` capability, with
  a user-facing reason, before any account lease. Commit 6: the Hello Codex
  page and the session dialog say Codex sessions and Codex reviews run on
  this computer only in this release. Commit 7: an app-knowledge entry (and
  a tip) saying the same.
- **Launch handoff (from commit 3's ADR-009 pass):** Claude sessions take
  no lease yet (A12 keeps their launch path), so a Claude switch-off or
  inactivation cannot see running Claude sessions: commit 4 gives each
  Claude PTY a `session` lease (owner = session id), or refuses turning
  Claude off while any Claude PTY runs.
- **Renderer (from commit 3's ADR-009 pass):** the old writers of
  `codexEnabled` (the Codex settings tab, onboarding) bypass the main-side
  switch-off check until they go through SET_ENABLED; meanwhile the service
  follows the saved setting when it changes, failing closed: a switch-off
  made in the app stands until the saved setting reads it back, a switch-on
  gives way to any saved "off", and a settings read that fails changes
  nothing (the last value read stands). Re-signing a committed,
  signed-out account in place (with the "same account?" confirmation) needs
  a service operation that does not exist yet: it lands with the renderer.
  A refusal carries the number of consumers; the breakdown by kind
  (`consumersOf`, main-side today), the list and the navigation design 5.3
  asks for land with the surface. Repairing or re-authenticating the
  external home in place (design 5.5) is not offered: the service refuses a
  sign-in into it, and the user adds a managed account instead.
- **Departures recorded (commit 3):** drift marks the account `blocked`
  (design 5.3 says `attention`): blocked is the refusal state launches and
  defaults already honour. A blocked managed account may still be made
  inactive, archived or signed out -- each removes access rather than
  granting it; only the external home's sign-out and archive wait for the
  reconcile (5.5). Leases are in memory with no heartbeats and no start-up
  reclaim (design 11): every consumer in WP2 is a process of this app and
  dies with it; revisit when a session can outlive the app (SSH, tmux).
  Archiving the reviewer default clears the choice, so reviews then use the
  provider default; an inactive one is still the choice and is refused.
- **Known, accepted (commit 3):** an external archive whose status check
  cannot run (the CLI gone) still archives unless the account is already
  blocked: archiving changes nothing outside this app. A reconcile records a
  provider-account sign-in on a managed realm as the browser flow (the CLI
  does not say browser or device), so the next check still has a kind to
  compare. After a resources-directory change the settings file is still
  read from the CONFIG folder cached at start (pre-existing, outside WP2).
  A start-up reconcile already running when the directory changes may
  finish against the old registry, which is then no longer used.
- **Launch handoff (from slice 3d's pass):** the realm lock covers sign-in,
  sign-out, status and folder removal, not a running session; a managed
  launch's consumer lease must also block removal. Flip `realm.isolated` to
  `supported` only then.
- **Docs slice (from slice 3d's pass):** an app-knowledge known-issues entry:
  a CODEX_HOME the app cannot check (relative, ambiguous, a name ending in a
  dot or space on Windows, unresolvable) or one that overlaps the app's data
  folder makes every Codex account unavailable until it is changed or unset.
- **Known, accepted (slice 3d):** a resources directory on a network share
  whose SERVER follows links presents such a link as a plain folder, which
  the removal cannot tell apart (same user or server administrator: outside
  the threat model). Windows ACL hardening of the managed folders is
  deferred with the registry's (aicc_planning #103); on POSIX owner-only is
  enforced, so a disk that ignores permissions refuses managed folders. The
  CLI's helper folders under `CODEX_HOME/tmp` may keep links after a killed
  run; if the pinned CLI does that, such a folder refuses `all` removal and
  is kept (to be checked against the pinned binary). Three belt-and-braces
  checks are covered by a second check each and are proven only as pairs
  (the folder kind beside its canonical path, the entry kind beside its
  canonical path; an explicit emptiness check beside `rmdir`'s own).
- **Known, accepted (slice 3c):** a stopped run kills its own chain by pid
  from a process-table snapshot, so a chain process that exits in the
  moment between the snapshot and the kill could in principle have its pid
  reused (a root that exits in that window is never killed by pid); when the
  table cannot be read at all (PowerShell blocked, no `/proc`/`ps`), only the
  root is killed and a cancelled sign-in may still complete -- the result
  then reports the observed state. A launcher other than node, bun or deno
  between the root and the codex binary is not recognised as part of the
  chain.
- **Must fix before this PR leaves draft (CI evidence, 2026-09-24):** the
  "table cannot be read" case above is not only a blocked PowerShell. On a
  slow Windows runner the kill took 8.1 s, which is the process-table
  timeout (8 s, about twice a typical cold PowerShell start). A table read
  that times out falls back to killing the root alone. On Windows the root
  is cmd.exe, so the Codex CLI outlives a deadline or a cancel.
  **Fixed (2026-09-24):**
  - A run still going after `CODEX_TREE_PRIME_MS` (2 s) reads its process
    table once, in the background, with a 30 s budget.
  - If that early read is still running when the kill comes, the kill waits
    for it rather than starting a second cold read beside it. It uses the
    whole chain, because the CIM query captures the table when it runs, at
    the end of the slow start. If the early read fails meanwhile, the kill's
    own read gets the time left. The kill spends at most 10 s reading (the
    15 s settle bound minus taskkill's 5 s).
  - If it finished earlier and the kill's own read fails, only its wrapper
    line is used: cmd.exe -> node -> the codex binary. Each member waits
    for the next, and Windows reuses no pid while a handle to it is open.
    Helpers the codex binary started are never killed from an earlier read.
  - Everything is used only while the root still runs.
  - If no read answers within the kill's 10 s, only the root is killed, as
    before the fix. On Windows a codex under cmd.exe then keeps running.
  - An early read taken before node had started codex yields cmd.exe ->
    node. Killing node still ends codex: node places its children in a job
    that dies with it.
  - Short runs, such as a status check, never pay for the read.
  - The real-process test forces the kill-time read to fail and ends the
    whole tree. With the fallback removed, it fails on Windows (VM,
    2026-09-24).

  Residual: a wrapper that exits while the root still runs could have its
  pid reused before the kill. That needs a parent to have reaped it, which
  the npm and native wrappers do not do while they run.
- **Known, accepted:** deleting the very last Claude profile does not archive
  its account (indistinguishable from a failed read); emoji ZWJ sequences
  store with spaces (stripSpoofableText); reconcile is quadratic in profile
  count (fine below thousands).

## Commit 4 (launch handoff): decisions, departures, what remains (2026-09-24)

- **Done:** a Codex session runs only from a launch the accounts service
  prepared (account named, else the provider default; per-launch
  acknowledgement of an unverified sign-in; external-home drift check; lease;
  executable re-verified; realm environment through `realmEnvForProvider`).
  pty-manager holds the lease until the session's process has ended. The
  `pty:spawn` wait is registered with pty-manager, so a close, a sweep or a
  newer spawn supersedes it. Codex SSH spawns are refused first. The resume
  picker and telemetry use the realm, and so does the usage index (A13). The
  carried-forward Claude item is done: turning Claude off is refused while a
  Claude session runs.
- **Decision:** the acknowledgement names its account. `acknowledgeRealmOnly`
  counts only together with the `providerAccountId` it acknowledges, so a
  flag replayed from an earlier launch never consents to whatever the
  default has since become.
- **Departures:**
  - The session's working directory stays the project, not the shim's
    folder: Codex's workspace is its cwd. `NoDefaultCurrentDirectoryInExePath`
    keeps cmd.exe from resolving programs from the project folder by itself,
    and the `/s` cmd.exe line keeps the shim's path whole.
  - Claude behaviour change (T18): a Claude spawn that waits for a legacy CLI
    install is now registered with pty-manager for the wait, like a Codex
    preparation. A tab closed during the install therefore starts no PTY;
    before, one started for the closed tab. Keystrokes during the wait are
    handled as before: buffered, then discarded when the spawn starts.
  - A lease is released through its lease object rather than
    `releaseLaunch(kind, ownerId)`. The effect is the same and both are
    idempotent; `releaseLaunch` stays for callers that hold only the owner id.
- **Deferred to commit 6 (with the setup surface):** A8's "a launch whose
  resolved executable differs is blocked until the user re-checks" holds
  within a run. It needs the proven identity persisted across restarts, plus
  the user's re-check action that accepts a new one. Until then the first
  launch after a start re-runs discovery. `realm.isolated` stays `unknown`
  until the evidence pass.
- **Known until commit 6:** the renderer sends no `providerAccountId` yet.
  Codex sessions therefore run on the provider default, and an adopted
  external account (realm-only) is refused until the session dialog asks for
  the acknowledgement. (`codex_review` moved onto `prepareLaunch` in
  commit 5a.)
- **For commit 6 (renderer):** a Restart that lands while the replaced
  spawn is still being prepared produces a synthetic `pty:exit` for the
  cancelled preparation just before the new one starts. The same happens
  today on a profile-refresh wait. If the remounted terminal is already
  listening it can mark the live session exited. Fix it where the event is
  consumed: exits tagged with a spawn generation the terminal checks.
- **Known limit:** main counts running and starting Claude sessions when
  Claude is switched off. It does not check the switch before a Claude
  spawn; the renderer gates that, and A12 keeps Claude's launch path.
- **Verified against the pinned CLI (2026-09-24, 0.155.1 source,
  `codex-rs/config/src/loader/mod.rs` `PROJECT_LOCAL_CONFIG_DENYLIST`):** a
  project-level Codex configuration cannot change the model provider or its
  endpoints for a realm session. `model_provider(s)`, `openai_base_url`,
  `chatgpt_base_url`, `profile(s)`, `notify` and `otel` are removed from a
  project layer. So no project gate like Claude's is needed for that.

## Commit 5a (codex_review on a prepared review launch): decisions, what remains (2026-09-24)

- **Done:** `codex_review` runs on a launch the accounts service prepared
  (kind `review`, local): the reviewer default, else the provider default,
  bound and leased under the registry lock, with the realm environment built
  by `realmEnvForProvider` and the executable setup proved. The lease owner
  is unique per call (`review:<session>:<n>`) and the lease is released in
  `finally`, once the run has settled (the runner settles only after the
  whole process chain is killed on a deadline or a cancel).
- **The review adapter is on the package contract.** `ProviderPackage.review`
  (`ProviderReviewOperations.run`) is the provider-neutral seam; the Codex
  package implements it in `src/main/providers/codex/review.ts`. The MCP
  tool keeps the session checks (opt-in, project directory, path
  containment, git guard) and knows nothing Codex-specific beyond the tool's
  name. `claude_review` (5b) implements the same seam in the Claude package.
- **One isolated invocation per review:** `codex exec --json --ephemeral
  --skip-git-repo-check --sandbox read-only -m gpt-5.5 -` through the CLI
  runner, in the project, with the request on stdin (argv is constant). A
  Windows shim runs through the absolute cmd.exe with the same verbatim line
  as a session, and `NoDefaultCurrentDirectoryInExePath=1` is set.
- **Depth one:** the reviewer inherits no Conductor variable (every
  `CCC_`, `CONDUCTOR_` and `CLAUDE_MULTI_` name, in any spelling on
  Windows), no per-spawn MCP flags are passed to it, and a session runs one
  review at a time: while it runs, a second request for that session is
  refused.
- **A review never outlives its request or its session:** the MCP request's
  cancel stops the reviewer, and unregistering the session (its PTY ended
  or was replaced) stops its reviews and frees its place at once (a
  respawned session may ask again); either way the lease is released once
  the run has settled. Known limit, as for sessions: a kill that never lands
  releases the lease after the runner's 15 s bound.
- **Pinned output contract (0.155.1, `exec_events.rs`):** the reply is the
  last `item.completed` agent message; usage is summed over
  `turn.completed`; `turn.failed` and `error` carry the failure. The old
  reader looked for `event_msg`/`token_count`, which the pinned CLI does not
  print, so the old footer always said usage was unavailable. The footer now
  shows tokens (input, cached, output); usage is recorded even when the turn
  fails. There is no rate-limit figure in `exec --json`, so none is shown.
- **Reading and returning:** the JSONL stream is read as it arrives (one
  event line is bounded; a longer one is skipped), so no output cap can cut
  the reply off. Failure text is redacted whole, then bounded to 500
  characters; stderr is reported from its real tail. The review itself has
  token-shaped credentials redacted (case-sensitive, so prose about "basic
  validation" is untouched). Redaction reads a bounded window, and the
  margin next to a window cut is dropped, so a secret a cut splits never
  shows. A deadline
  that finds the root already exited is reported as a timeout. Only absolute
  PATH entries reach the reviewer. An npm-installed Codex is refused for a
  project on a network path (cmd.exe cannot start in one).
- **Retired:** `runCodexStreaming` (the old review spawn) is deleted; the
  tool no longer reads the global Codex home. The flag-drift integration
  test now derives its assertions from the reviewer's argv.
- **Defaults taken (owner may overturn):**
  - An unverified realm-only sign-in as the reviewer is refused with a
    message to add a Codex account. An agent cannot give the per-launch
    acknowledgement a person must give.
  - No reviewer-account argument on the tool. The owner's "explicit per
    request" is read as the user's choice (the reviewer default in
    Accounts, commit 6), not the agent's: letting an agent pick among the
    user's accounts would let it route project text to another account's
    organisation. Held for the owner.
  - The review stays bound to the session's project directory, as before.
  - Codex's read-only sandbox restricts writes and network, not reads; this
    is unchanged from the shipped tool and stays a known limit.
- **Held for the owner:** how far a reviewer is isolated from its realm's
  own Codex configuration (a change in review behaviour, on Windows in
  particular), and the reviewer's environment beyond the Conductor
  variables. Details are with the owner.
- **Real-process proof (2026-09-24, Windows VM; CI runs it on all three
  platforms):** `tests/wp1/fake-cli.test.ts` sends a review through the real
  runner, npm shim and cmd.exe. The request arrives on stdin byte for byte
  (`%VAR%`, `!VAR!`, `&`, `^`, `|` and quotes intact), in the project, with no
  Conductor variable. A `node` in the project is never run, even with a
  relative PATH entry first. Removing the PATH rule, both current-folder
  guards, or the variable strip turns the case red on the VM (3/3).
- **ADR-009 (5a):** one round of three Opus lenses (injection and platform;
  accounts, leases and depth; correctness and coverage), fixes, then a
  confirmation by the same attackers. Mutation proofs for every new guard.
- **Remaining for commit 5:** `claude_review` for Codex sessions (5b), and
  offering each session only the other provider's tool.

## Commit 5b (claude_review): design and owner decisions (2026-09-24)

Built on 2026-09-24 ("What was built", below). 5a laid the groundwork:
the `ProviderPackage.review` seam, the one-review-per-session registry,
and cancel on session end.

**What exists.** A Codex session connects on `/mcp`, where the server forces
the source to `codex` and binds the session id. Tools are registered per
connection. `claude_review` is therefore gated on `source === 'codex'`,
beside `codex_review`'s `source !== 'codex'`, and each session is offered
only the other provider's tool.

**What is missing.**

1. A registry of Codex sessions for review: an opt-in and a project folder,
   like `registerCodexReviewSession`. Today the Codex spawn branch registers
   nothing. Unregistering is already shared.
2. The Claude reviewer's account and environment. `prepareLaunch` answers
   `unsupported` for Claude, because the Claude package has no `launch`.
   Claude accounts launch through their profile homes (A12).
3. A Claude invocation built like the Codex reviewer's: no shell, a proved
   executable, the whole chain killed. The existing headless runner predates
   the account launch path and is not reused.
4. The change under review. The Claude reviewer gets no shell, so it cannot
   run git itself.

**Proposal (recommended).**

- **A Claude `launch` for reviews only.** It composes the profile-home
  environment (what `withProfileHome` does) through `realmEnvForProvider`,
  with the executable version-proved as Codex's is. Claude sessions stay on
  A12.
- **The reviewer invocation.** `claude -p` with `--strict-mcp-config`,
  `--output-format json`, and read-only tools only (Read, Grep, Glob). The
  request goes on stdin. It runs through the CLI runner, in the project.
  Each flag is checked against the pinned CLI before use.
- **The diff.** The main process produces it with a hardened git: an
  absolute executable, no external diff, textconv, fsmonitor or pager, and
  bounded output that is refused past the limit. It goes into the prompt.
  Mode `paths` needs no diff.

**Groundwork facts (2026-09-24, read from the code and the pinned CLI).**

- **Claude accounts are already in the registry.** Each legacy profile is
  mirrored into the registry at start-up as one account, with one realm:
  `claude-config-home`, `pathRef: claude-profile:<id>`
  (`claude/legacy-accounts.ts`). The provider default follows the primary
  profile. A Claude reviewer default can be set today. Nothing resolves
  `claude-profile:<id>` to a path yet; the equivalent is the profile's home,
  `getProfileConfigDir(id)`.
- **A review launch must reproduce what `withProfileHome` composes.**
  - Environment: the profile home as `USERPROFILE` (and `HOME` on Linux),
    `GIT_CONFIG_GLOBAL` and the npm config pointed at the real home, the
    realm variables, and the ambient-authority strip.
  - Preparation: `setupProfileLinks` first.
  - Account use: the profile-consumer hold and the pending-token-refresh
    wait. Account leases do not cover these.
  - Session-only, and not for a reviewer: `CCC_*` variables and the
    primary-credential sync.
  - On macOS Claude has one account, the normal sign-in: multi-account is
    off there (decision D2, WP1), because the Keychain token is shared. A
    Claude review on macOS runs on that sign-in, with no reviewer choice;
    it is not refused.
- **No version proof exists for Claude.** `resolveClaudeForPty` resolves by
  name, and the 2.1.278 floor feeds only the preflight diagnostic. 5b adds
  `setup.discover` for Claude (resolve, version check, recorded identity),
  as Codex has.
- **`prepareLaunch` has no per-kind guard.** Once Claude has a `launch`, a
  Claude `kind: 'session'` launch must be refused by a data guard; A12
  keeps Claude sessions on their own path. The Claude package must receive
  profile-home composition through `ClaudePackageDeps`: importing
  `account-profiles` would break dependency rule R2.
- **The pinned Claude CLI has a mode made for this.** `claude -p
  --restricted` (2.1.278) removes the tools that run commands or code, and
  ignores user, project and local settings files. It also confines the file
  tools to the working folders and refuses `bypassPermissions`. With
  `--strict-mcp-config`, `--tools` limited to Read, Grep and Glob, `--output-format json`
  and `--no-session-persistence`, it is a read-only reviewer that a
  project's own settings cannot widen. That removes the need for the
  project gate for settings.

  The diff still has to come from main, because a restricted reviewer has
  no git. The recommendation for decision 2 is unchanged.

**Owner decisions.**

1. **The Claude reviewer account.** DECIDED (owner, 2026-09-24):
   registry-based, through a review-only Claude launch (reviewer default,
   else the provider default), as the approved architecture says.
2. **The diff source.** DECIDED (owner, 2026-09-24): produced by main
   with a hardened git and sent in the prompt; all three modes supported.
3. **When to offer `claude_review`.** DECIDED (owner, 2026-09-24): only
   while Claude is enabled and a Claude account can run reviews (the
   reviewer or default account; on macOS the normal sign-in).

**What was built (2026-09-24).**

- **Accounts service.**
  - `ProviderLaunchOperations.kinds` says which launches a package prepares.
    `prepareLaunch` refuses any other kind before it chooses or leases an
    account; a declaration that is not a list of known kinds prepares
    nothing. This is data, not a provider name: Codex prepares sessions and
    reviews; Claude prepares reviews only, so a Claude session is refused
    there (A12).
  - A review never runs remotely, whichever provider reviews.
  - `reviewReady(provider)` says whether a review could be prepared now: the
    reviewer default, else the provider default, is active, not blocked,
    locatable, and needs no per-launch confirmation (an agent cannot give
    one). A test checks, condition by condition, that it agrees with what
    `prepareLaunch` then does.
  - `sessionsDirs` reads only packages whose sessions launch there.
- **Claude package** (`setup`, a review-only `launch`, `review`; present only
  when the composition root hands it `ClaudePackageDeps.review`).
  - `setup.discover` resolves `claude` as the version probe does, proves a
    version at or above 2.1.278 through the CLI runner, and records the file
    identity. Overlapping checks keep the newest proof.
  - When the launch is prepared it re-verifies that file. Claude Code updates
    itself in place, so a changed file is proved again (with the version
    floor) rather than refused until a setup screen this release does not
    have. A proven file below the floor is never run. The file is not
    re-read between preparation and the spawn (as for Codex).
  - The launch resolves the realm's `claude-profile:<id>` to a profile and
    asks account-profiles for its home. The package imports neither
    account-profiles nor the Codex package (R2): the profile home, the
    credential-consumer hold, the preflight record and the CLI runner are
    injected.
- **Profile home.** `profileRealmLaunch(id)` in account-profiles, still the
  only module that composes a profile home's variables.
  - It runs `setupProfileLinks`, and returns the base (git and npm at the real
    home, the home's `.local/bin` on PATH) and the realm selector that
    `withProfileHome` composes (the same helpers): hardened, the reviewer's
    environment equals a session's.
  - It records the ambient variables the hardening will remove, for the
    preflight.
  - On macOS it returns the normal sign-in: the real home, nothing
    redirected. That sign-in is the primary account (first-run capture makes
    it one on every platform), so only the primary may review there; another
    profile is refused with the reason, since it would be named while the
    primary's sign-in was used.
- **Reviewer.**
  - `claude -p --restricted --strict-mcp-config --tools Read,Grep,Glob
    --output-format json --no-session-persistence`: a constant argv, the
    request on stdin, in the project, through the CLI runner (no shell, the
    whole chain killed).
  - The reviewer account is held as a credential consumer for the run
    (`holdProfileForRun`): the hold is taken before the wait for a refresh
    in flight, re-armed for the run's full bound after it, released when the
    run settles, and let go at once when the review is cancelled during the
    wait. The launch preflight is recorded.
  - The environment rules, redaction and reply bounding are the Codex
    reviewer's, moved unchanged into `src/main/providers/review-support.ts`
    (beside provider core, not in it: core imports only core, shared and
    Node built-ins, and these rules need the app's redactors).
  - The pinned 2.1.278 result is read: the result line, or the array of
    messages when the user's own config turns `verbose` on (`--restricted`
    does not ignore that setting). Only `subtype: success` with `is_error:
    false` is a review. Usage counts every input token, of which the cache
    reads are the cached ones.
  - `cliCommandLine`, extracted from `codexCommandLine` for the composition
    root to hand the Claude package, refuses any argv element carrying a
    character a shell or cmd.exe reads; every Codex argv passes it.
- **The diff** (`src/main/review-diff.ts`). The repository's own
  configuration is untrusted: an agent that can write the project can plant
  a `.git` there, a pointer to a git dir of its own included.
  - Mode `working` diffs through a PRIVATE git dir this module writes in a
    temp folder: its own minimal config, HEAD as a commit id (the empty tree
    before the first commit), the objects through an alternates entry, the
    index through `GIT_INDEX_FILE`, every `sharedindex.*` of a split index
    copied beside it. The diffing git reads no repository configuration,
    only the user's global and system configuration and this one, so there
    is no window between a check and the diff in which a repository could
    add a filter; the filter drivers the user's own configuration names are
    emptied too.
  - Of the repository's own settings, only the value-only ones that decide
    how the work tree compares are carried into that config (`core.filemode`,
    `symlinks`, `autocrlf`, `eol`, `safecrlf`, `ignorecase`,
    `precomposeunicode`, `trustctime`, `checkStat`), each only as one of its
    key's own tokens, so the diff reads as the user's own `git diff` does
    (no mode change on a Windows checkout, no line-ending noise). The
    repository is otherwise read only by `rev-parse`. HEAD before the first
    commit is the empty tree; a HEAD that names something other than a
    commit is refused.
  - Mode `range` must be a real range (`A..B`, `A...B`): tree against tree,
    which reads no work-tree file, so no filter can run. A single revision,
    which git would diff against the work tree, is refused.
  - Every run: git by absolute path; `--work-tree=<project>`, so a
    repository's `core.worktree` cannot point it elsewhere; `--no-pager -c
    core.fsmonitor=false -c core.pager=cat -c diff.external= -c
    protocol.allow=never`; `--no-ext-diff --no-textconv --no-color
    --ignore-submodules=all --end-of-options`; no GIT_* variable inherited,
    no optional lock, no prompt, no lazy fetch; the review's cancel stops
    git.
  - A range side is revisions only. The output is bounded at 512 KB and
    refused past it, never cut.
  - Mode `working` is tracked files against HEAD; untracked files are not
    included, and the prompt says so.
  - The change goes in the prompt between two markers carrying a fresh
    nonce. Nothing to review, or a change it cannot read, prepares no launch.
- **MCP.**
  - A local Codex spawn registers the session with its PTY directory (never
    home or above it). A session is registered for one reviewer at a time;
    unregistering stays shared.
  - `offeredReviewTool` offers each connection only the other provider's
    reviewer: `claude_review` to a Codex connection while the Conductor tools
    are on and `reviewReady('claude')`.
  - Both tools share the session checks, the one-review-per-session slot and
    cancel on unregister.
  - A request's cancel stops its review on Codex's stateless `/mcp` route
    too: a client that drops the request closes that exchange's server at
    once (the close listener now goes on before the request is handled), and
    a cancel notification, which arrives on a connection of its own, is
    routed by the session that connection authenticated and the request's
    id.
  - A Codex session now waits up to 1000 s for a Conductor tool
    (`mcp_servers.conductor.tool_timeout_sec`): the pinned Codex's default is
    300 s (`DEFAULT_TOOL_TIMEOUT`, rust-v0.155.1), below the 900 s a review
    may take.
- **Defaults taken (owner may overturn).**
  - The Settings toggle for Codex review does not gate `claude_review`; the
    Conductor tools switch does. A toggle of its own comes with the renderer
    slice (commit 6).
  - A Claude CLI that updated itself is proved again, not refused.
  - On macOS only the primary account (the normal sign-in) reviews. A Mac
    whose Claude reviewer default is an older non-primary profile is offered
    the tool and then refused with the reason (`reviewReady` does not see
    the macOS rule, which lives in the profile-home port).
  - Claude reviews record no usage in the Codex-review usage store (it feeds
    the Claude session statusline) and emit no channel-routing event (the
    Codex Routing rules are for Codex reviews).
- **Real-process proof (2026-09-24, Windows VM; CI runs it on all three
  platforms).**
  - `tests/wp1/fake-cli.test.ts`: discovery proves 2.1.278 through a real
    `claude.cmd` shim. The request reaches the fake CLI byte for byte on
    stdin, with the constant argv, in the project, with no Conductor
    variable, and a `node` planted in the project never runs.
  - Same file, real git: a repository whose fsmonitor hook, clean filter,
    textconv, external diff (configured and from the environment) and pager
    each write a marker, and whose `core.worktree` points outside the
    project. The review diff is produced, none of them runs, and nothing
    outside is read; plain `git diff` on the same repository runs them and
    reads outside. A project with a planted `.git` file naming a git dir of
    its own that configures all of these: the same, in both modes.
  - Same file: a clean filter the repository gains between the filter check
    and the diff (the race, made deterministic) runs nothing, while plain
    git runs it; an executable bit `core.filemode=false` says to ignore is
    no change, as for the user's own `git diff`; a linked worktree diffs its
    own change.
  - `tests/wp1/review-profile-home.test.ts`: the reviewer's profile-home
    environment, hardened, equals the session's; on macOS it is the normal
    sign-in, for the primary account only.
- **ADR-009 (5b).** One round of three Opus lenses (injection and platform;
  accounts, leases, depth and session binding; correctness, blast radius,
  coverage and quality) plus a confirmation by the same attackers, and an
  independent spec-compliance review (round and confirmation).
  - Round 1: one BLOCKER, a repository's `core.worktree` (reachable through
    a planted `.git` file) pointed the diff outside the project; and a
    filter race between the check and the diff. Both closed by the private
    git dir and the work-tree pin, re-proven by the same attacker with real
    git.
  - Round 1 MAJORs: the profile-home proof file was quarantined by Windows
    Defender (restored; the proof moved to its own file); the hold order was
    unasserted; Codex's per-tool wait was below a review's length. All
    fixed. MINORs fixed: a cancel during the refresh wait, the hold's clock,
    the macOS non-primary profile, the verbose result form, and a test for
    every guard the lens found untested.
  - Confirmation: the injection lens and the spec review passed. Its two
    new findings are fixed with regression tests (not re-attacked): the
    private git dir dropped the repository's value-only work-tree settings
    (MAJOR: mode and line-ending noise), and a cancel on Codex's stateless
    route did not reach the review (MINOR).
  - Mutation proofs: 78/78 host mutants and 7/7 real-process mutants (on the
    VM) of the 5b guards killed, each test red under its mutant.

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
