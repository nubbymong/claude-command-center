## 2026-09-17 -- 2.1.1: the final adversarial pass over main...beta, and its fixes

Before 2.1.1-beta.1 was published, the whole `main...beta` delta (#615 module
split, #551 governance, #616 dependencies and CodeQL) went through one more
adversarial pass, five attacker lenses over the assembled release rather than
over each PR. Verdict: no blockers and no exploitable regression -- every
shipped-code surface (the 312 preload bridge functions, 262 IPC channels, argv
construction, path handling, the SSH sentinel parsers under pathological input,
the tmux pin/redirect/cap) verified identical to v2.1.0. What it did find was
coverage and process, and this fragment records the fixes and the decisions.

Two PRE-EXISTING findings (present in v2.1.0, not introduced by this line) were
routed privately per SECURITY.md ("Embargo"). Nothing more about them belongs
here until they are fixed and published.

### Coverage gaps closed (all as tests, no behaviour change)

- `restoreSavedSessions` (`src/renderer/session-persistence.ts`, lifted out of
  App.tsx by #615) had no test of its own: four mutants -- the unsettled ref
  never cleared, `markRestored` dropped, the persistent-SSH probe filter
  flipped, the reachability ping dropped -- stayed green across 3,776 renderer
  tests. `tests/unit/renderer/session-persistence-restore.test.ts` carries one
  case per mutant plus the neighbouring wiring (resume-picker marking, the
  immediate save, command-bar reconcile, the colour-migration notice, the
  failure path). Each mutant was re-applied and is red.
- `scripts/reconcile-issue-dispositions.js`: "never removes a label, never
  closes anything" was untested at the `gh` layer (a mutant appending
  `--remove-label` and `issue close` was green). `main()` now takes its I/O as
  an injectable (`gh`, `readPackageVersion`, `env`, `argv`, `log`), and the
  test drives a full run against a recording `gh` fake, asserting the ENTIRE
  argv set: one list read and one `--add-label` per decision, nothing else.
  The derived active label is validated in `main()` the way the CLI override
  always was (`resolveActiveLine`), and every number in a release label or a
  version is canonical -- `release-02.1` no longer folds into the 2.1 line,
  `02.1.1` derives nothing.
- The system-browser sign-in's origin gate: `isClaudeUrl` had look-alike cases
  but no SIBLING-subdomain case (a mutant accepting any `*.claude.ai` was
  green), and the layers `runSignIn` stacks on it were only observed together.
  `tests/unit/account-web-origin-gate.test.ts` has one case per layer.
- The boot-wiring and preload shape tests let six mutants through (a once-flag
  reset in `createWindow()`, a re-declared once-flag, a shared try/catch around
  the resume+wipe registrations, `--no-sandbox` appended from the splash
  module, a permissive handler on the default session from the splash, a third
  top-level bridge key, a dynamic channel subscribed or disposed on the wrong
  channel). Each is now pinned.

### One behaviour fix

The three CLI probes (`cli:check`, the setup probe, the setup PTY) fell back to
`/bin/zsh` on every non-Windows platform when `$SHELL` was unset. Right for
macOS, wrong for Linux, where zsh is optional: ENOENT, reported as "CLI not
found". `src/main/login-shell.ts` centralises the rule: `$SHELL`, else
`/bin/zsh` on macOS, else `/bin/sh`. (The Codex and Claude spawn paths fall
back to `/bin/bash` and are unchanged.) Changelog line added to 2.1.1-beta.1.

### Decisions recorded, no change

- **zod 4.5 counts `.min/.max/.length` in code points** (verified locally:
  `z.string().max(2)` accepts two astral characters, four UTF-16 units). The
  ~28 free-text `z.string().max(N)` IPC fields therefore accept up to 2N
  UTF-16 units of astral text. Accepted: those are soft bounds; the hard byte
  bounds are re-checked downstream (`Buffer.byteLength`, the stores' own
  `.length` checks), the residual is a 2x soft bound on emoji-only input and a
  less specific error for an emoji note that passes the schema but not the
  store. Not worth a 28-site mechanical change through a security-sensitive
  path in a patch release; revisit if a field ever loses its downstream bound.
- **The disposition job checks out `beta`** (`issues: write` token, script from
  a non-default branch). Kept, with the reasoning now in the workflow file:
  both branches are owner-controlled, the token only edits labels, and the
  alternative would run the previous label grammar for a whole patch cycle.
- **"Electron 43.7.1 is a security floor" -- not confirmed.** The claim (four
  HIGH advisories since 43.4.0) was checked against the GitHub Advisory
  Database (`gh api advisories?ecosystem=npm&affects=electron`: nothing
  affecting 43.x) and against the 43.4.1 through 43.7.1 release notes (no
  security line). The changelog does not say it.
- **node-pty 1.2.0-beta.15 changes ConPTY connect failure.** The agent now
  arms a 5 s connection timeout on the conout pipe and FAILS the spawn when it
  fires (`_failPtyConnection`), where beta.14 connected anyway. A wedged
  conout on Windows is now a spawn error surfaced to the session, not a silent
  terminal with no output. No change needed; noted so the next "spawn failed
  after 5 s" report is read correctly.
- **CI does not rebuild the Windows natives.** Windows packaging uses the
  upstream N-API prebuilds (`--config.npmRebuild=false` in `release.yml` and
  `ci.yml`); macOS and Linux rebuild from source. The 2026-09-16 fragment's
  "CI builds the installers" is right; anything that reads it as "CI rebuilds
  node-pty for Windows" is not.

### Process

- #616's squash-merge body was auto-filled from the branch's commit subjects
  and published a detail the PR body, the fragment and the changelog had all
  been scrubbed of. A public merge commit cannot be amended; the mitigation is
  to ship 2.1.1 promptly. The rule -- hand-write the squash body for any PR
  that ever carried embargoed material -- is now in AGENTS.md ("Security
  embargo") and `docs/security-embargo-runbook.md`.
- Docs reconciled: AGENTS.md's "NOT the line label" now says what the
  reconciler actually does with a leftover line label; the disposition
  workflow header names `in-release` and the patch labels; LoopReady and
  StartLoop say the public tracker holds only public error reports since #551.
- The five attackers of the pass ran on Fable; that is the last time. Fable
  orchestrates (scoping, synthesis), Opus and Sonnet attack.
