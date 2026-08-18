## 2026-08-17 -- Updater: pre-emptive repo-rename soft-switch

The repo will be renamed claude-command-center -> ai-code-conductor after 2.1
stable. Built BEFORE the rename so a shipped build follows it automatically.

`github-update.ts`: `adoptRenamedRepoIfLive()` runs once at startup (index.ts,
after registerUpdateHandlers, non-blocking):
- a valid `GitHubRepo` registry override already set (manual, or a prior adopt)
  WINS -- never second-guessed;
- else probe `RENAMED_REPO = nubbymong/ai-code-conductor` via the public API.
  GitHub 404s it until the rename; the moment it is live -> writeRegistry the
  override + use it THIS session (activeRepo() cache), so no restart needed;
- any 404/error/timeout -> stay on DEFAULT_REPO (fail-safe, never adopt on
  uncertainty).
The module-level `const REPO` became `activeRepo()` (cached, override-aware) at
every fetch/download site. Only the SOURCE repo changes -- verification
(checksums/signature) is unchanged, and the target is a hardcoded same-owner
slug, not caller input.

Security: touches the updater path (ADR-009). The switch cannot be steered to an
arbitrary repo (hardcoded target; a registry override is REPO_PATTERN-validated
and is a same-machine write). Run /adversarial-review before the official cut.

Tests (injected deps, no network/registry): adopt+persist when live / stay on
404 / stay on throw / respect a valid override (no re-probe) / ignore a malformed
override / session-only when persist fails. Mutation-checked: adopt-on-uncertainty
fails the fail-safe test.
