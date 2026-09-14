# 2026-08-25 — Agent Hub deprecated (#443)

Owner decision (recorded on #443): deprecate the Agent Hub in 2.1 — disable the
code and its references; no more stored agents in the app. 2.2 replaces it with
richer functionality. Implementation chose deletion over dead-code (typecheck
then proves zero dangling references; the code stays reachable at tag
`v2.1.0-rc.2` for the 2.2 rebuild).

Gone: the Pipelines (teams) and Library tabs with their left rail
(`TeamsPanel`, `TeamBuilder`, `TeamRunView`, `AgentLibrary`,
`AgentTemplateDialog`), `agentLibraryStore` (with `BUILTIN_TEMPLATES`),
`teamStore`, main's `team-manager` + `team-handlers`, the 7 `TEAM_*` IPC
channels, the preload `team` bridge, the `AgentTemplate`/`Team*` shared types,
and the `agentTemplates`/`agentTeams`/`agentTeamRuns` config keys (files on
disk from older installs are left in place, simply unread).

Survives: the cloud agents surface — the page is titled **Cloud Agents** now
(nav, page tab, tips, guided tour, app-knowledge all follow), with its
explainer and first-run examples (`agent-hub/AgentHubOnboarding.tsx` — file
and settings-key names keep the old spelling; the settings key is persisted).

Contract changes worth remembering:
- `claudeOptions.agentIds` is now tolerated-and-ignored: nothing resolves it,
  no `--agents` flag is built from it, but the field still round-trips a
  config edit untouched (`agentpicker-codex-gate.test.ts` pins both halves).
  Main's generic `agentsConfig` spawn plumbing stays, dormant — deliberately
  untouched so this change does not enter PTY argv construction.
- The config-latch worked example moved from the retired Agent Library to the
  browser favourites store (`config-read-failure-latch.test.ts`).
- The persist-latch independence test's second subject moved from `agentTeams`
  to `magicButtons`.
- `cloud-agent-manager`'s completion-callback extension point (only consumer:
  team-manager) is removed.
- Training steps 21 → 20; the `tip.agent-teams` tip, its
  `agents.agent-teams` usage id, and the teams `trackUsage` call left in
  lockstep (the tips invariants require all three together).
- The zustand rule from #442 (never a getter in a selector — select the
  stable array, derive with `useMemo`) loses its in-tree example with
  `TeamBuilder`; the rule lives on in
  `CONTEXT.d/2026-08-24-team-builder-crash.md`.
