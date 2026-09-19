# WP1 base audit and delta note

Recorded 2026-09-19 (UTC) before any production change.

| Item | Value |
| --- | --- |
| Design base (research snapshot) | `6bafcc33c9b9465713376bf6ad9b8b672ae1b890` (`2.1.1-beta.1`) |
| Design candidate digest | `e4d5b99a562952694be034ed8e71db6da379d8cb15bb24df6c2ca3f02cd83140` |
| Live `origin/beta` at audit time | `6bafcc33c9b9465713376bf6ad9b8b672ae1b890` (commit date 2026-09-18T00:24:26Z) |
| GitHub compare `6bafcc33...beta` | `identical`, ahead 0, behind 0 |
| Tree id of the base | `4faa5cf7f595f274fd148fff73a48cfb21319cee` |
| Implementation worktree | a fresh `git worktree` on branch `session/beta/33e13aa0-wp1` from `origin/beta`, claimed through `scripts/session-guard.mjs` |
| Dirty primary checkout | not used (behind `beta` and carrying untracked owner files) |

## Delta impact

The live base equals the design's research snapshot, so no rebase-impact note is
required for this audit. If `beta` moves before the PR is opened, this note is
re-recorded against the new head and every implementation claim is revalidated
against it (design 14, 18.2).

## Premise discrepancies found on the base

These are places where the design text describes the base differently from
what the code does. They are recorded here so the implementation follows the
code, not the text, and so the review lead can decide whether the design wording
should be amended.

1. **Claude account isolation is not `CLAUDE_CONFIG_DIR`.** The local Claude
   launch isolates an account by redirecting the child's `USERPROFILE`
   (Windows) or `HOME` (Linux only) to the profile home through
   `withProfileHome` (`src/main/account-profiles.ts`), and
   `tests/unit/pty-spawn-env.test.ts` asserts that `CLAUDE_CONFIG_DIR` is
   absent from the spawn env. The design's "exact `CLAUDE_CONFIG_DIR`" is read
   throughout WP1 as "the exact Claude profile home applied by the existing
   mechanism". The realm kind name `claude-config-home` is kept as a label
   only (decision D1).
2. **macOS has no Claude multi-account support today.** Three independent
   gates disable it (Accounts panel, the onboarding `accounts` step, and
   `withProfileHome` not redirecting `HOME` on darwin, because the login
   keychain is located through `$HOME`). WP1 preserves that: Claude realms on
   macOS remain the single default account, and only Codex gains isolated
   realms there (decision D2).
3. **Codex has no realm concept on the base.** Every managed Codex operation
   resolves `process.env.CODEX_HOME ?? ~/.codex`; five independent resolvers
   exist, two of which ignore `CODEX_HOME` entirely
   (`src/main/account-identity.ts`, `src/main/tokenomics/tokenomics-service.ts`).
   The manifest and ledger under `docs/wp1/` and `tests/wp1/` record the
   disposition of each.
4. **The Codex enablement preference is a renderer setting.** `codexEnabled`
   lives in the renderer settings store (not `src/shared/types.ts`); the main
   process reads it only through a payload the renderer passes when it
   registers MCP tools. WP1 keeps that key as the durable preference and
   compatibility shadow and makes the provider registry authoritative.
5. **The CI test matrix is Windows + macOS only.** Linux runs the unit suite
   only inside the (experimental, `continue-on-error`) release build job.
   Playwright e2e never runs in CI; it is a labelled manual/VM gate
   (decision D5).
6. **No coverage toolchain exists on the base** (no `@vitest/coverage-*`, no
   `coverage` config), so the design's "current coverage report using the
   repository's existing toolchain" has no source (decision D6).
