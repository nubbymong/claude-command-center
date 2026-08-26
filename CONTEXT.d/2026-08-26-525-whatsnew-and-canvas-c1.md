# 2026-08-26 — #525/#526: What's New rename page + the canvas C1 state machine (one PR)

Owner-directed single PR combining two strands, both canvas-designed live with
the owner before any code (5 review rounds on the page, 3 approved design
artifacts for the canvas rework: C1 state machine, C2 review pane, C3 header).

## What's New rename/roadmap page (canvas v8, approved)

First page of the What's New run: "Claude Command Center is now:" over the
real brand lockup (`src/renderer/assets/brand-icon.png`, byte-identical to
`docs/screenshots/brand-icon.png`), tagline "Same application, exciting new
roadmap (tentative preview below).", the roadmap band (Claude Code NOW /
Codex BETA today; Copilot CLI, Antigravity, Qwen Code, OpenCode, Ollama
tagged 2.2 with drawn brand glyphs), one carry-over bullet. Cohorts:
pre-rename upgraders (last seen < 2.1.0-beta.6) and ALL fresh installs
(lead-in "Welcome to", no carry-over bullet); post-rename testers and the
2.0 line never see it. Owner calls recorded in `RenamePage.tsx` header.
Quick Start pins lost the word "Start" (glyph only).

## Canvas C1 state machine (owner-approved spec, canvas artifact "Canvas review state machine (C1)")

Per artifact, at most ONE ready version is OPEN — ever. `CanvasVersion.verdict`
(approved/rejected/superseded/withdrawn/dismissed × user/agent-chat/system):

- READY renders auto-supersede the previously open version (`renderVersion`
  returns the ids; the ingresses settle those versions' notes — the two
  stores meet only at composition points).
- Reviews are decision-first: Approve/Reject at compose, reject mandates a
  note, Submit is dead until decided; a plain Approve files a version verdict
  with no review record (`canvas:versionVerdict`).
- Chat verdicts: `canvas_version_verdict` MCP tool records the USER's stated
  verdict/reopen, always stamped `agent-chat` — it can never impersonate a
  click. Reopen withdraws later versions (hidden in History behind an
  audit-trail reveal, recoverable).
- Legacy piles heal on load (versions → superseded; their open/addressed
  notes → stale/`closedBy: 'supersede'`, reopened notes shielded), so the
  phantom "Review needed · 1" / "5 reviews open" counts clear on first
  launch. The queue derivation reads exactly one debt class: an open version.
- Version-stamped drawing: regions/element locks and glass sketches render
  only on the version they were made on (stamped at creation; foreign
  versions stash + restore; the submit export reads the union).

## C3 header + global open-target settings

Header: two rows (identity / tools) per the approved mockup; subject
dropdown, "+N elsewhere", "N reviews open", mid-row Library button and the
mode-strip row all deleted; History lists versions with outcome badges.
X-Ray owns its name (Inspect chip removed). Settings: two GLOBAL knobs —
artifacts open target (window default / in-app pane; right-click chooser on
the Artifacts tool; session-menu action follows it) and claude.ai sign-in
target (global successor to #439's per-account mode, which is preserved via
read-time fallback — nothing stored is migrated or lost).

## Deviations owed to the owner

- Migration runs SILENTLY (no one-time "cleared N stale rounds" notice) —
  smaller surface, judged lower-risk for a release-bound PR.
- UAT content-keyed versions (build digest = version identity) and the
  shift-click-to-navigate rule for X-Ray-on UAT review are NOT in this PR —
  flagged as follow-ups; the owner marked them "worth considering".

Suite: 8,620 unit tests green; typecheck clean across all three configs.
ADR-009: the Conductor MCP server and canvas IPC changed — adversarial pass
required before merge.
