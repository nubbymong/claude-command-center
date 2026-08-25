## 2026-08-25 -- #501 Artifacts button in the command bar

**What.** Added an `artifacts` core tool to the command bar, beside Browser. It
opens the current account's artifacts on claude.ai via the existing
`accountWeb.openArtifacts(profileId)` IPC -- the same action the Sidebar's
per-session menu already exposes. Previously that was the ONLY entry point.

**How.**
- `commandBarStore.ts`: `'artifacts'` added to `CORE_TOOL_IDS` (after `browser`),
  so hide/show + the settings "Core tools" list pick it up generically.
- `CommandBar.tsx`: an inline action button (modelled on Partner/Snap, not a
  pane tool) rendered right after Browser, gated `!hiddenHere.has('artifacts') &&
  artifactsApplicable`. Applicability mirrors the Sidebar: local, non-shell, with
  a resolvable profile (`session.profileId ?? primary`). Click -> openArtifacts,
  surfacing a failure the way the Sidebar does. Also a right-click menu entry.
- `CustomCommandsTab.tsx`: the settings `TOOL_LABEL` (a `Record<CoreToolId>`)
  gained `artifacts` (required, or typecheck breaks) + a caveat note.
- `tipsStore.ts`: registered `artifacts.opened` in `DIRECT_FEATURE_IDS` so the
  trackUsage-id prune guard passes.

**Not security-sensitive.** Renderer-only; reuses an existing IPC. No new
IPC/preload/PTY/credential surface -> no adversarial-review trigger (ADR-009).

**Tests.** `commandbar-artifacts-button.test.tsx` (renders for an applicable
session, opens the resolved profile on click, primary fallback, hidden for
shell-only / no-profile / SSH). Updated `custom-commands-tab.test.ts`'s hardcoded
`CORE_TOOL_IDS` assertion. Full unit suite green locally (8357).

**Local limit.** This box cannot build `better-sqlite3` for Electron (node-gyp
emits a Utility project), so the full app / e2e cannot run here; validated via
unit + typecheck + build. CI builds native on its runners.

**Follow-up (not merge-blocking).** A tips-library entry + Feature-Guide mention
per the release user-facing-surface sweep.

**Gates.** Human desktop-test (`desktop-tested`) + green CI before merge.

**Ref:** #501.
