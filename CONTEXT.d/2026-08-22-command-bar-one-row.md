## 2026-08-22 -- One-row command bar, E5 command dialog, Notes in Core, Custom Commands settings (ADR-018; #358 #359 #380 #381)

Branch `feat/command-bar-one-row`. Design approved on the Agent Canvas ("Command bar -- one row" v8, owner R2 "OK this is good enough now", R3 "Approved"); build plan canvas "Command bar build -- plan" v2.

What shipped on the branch (three commits, one per issue group, plus tests):

- Capabilities: `lib/session-capabilities.ts` is the one derived description of a session (agent + name, where each pane runs, partner always local, secret deliverability, logs emptiness). The bar, the dialog, the Logs button and the Settings page read it and nothing else.
- Data model: `CustomCommand.icon/pinned/order/kind/needsReview`; `commandBarUi.overflow/hiddenCoreTools/upgradeReviewVersion` with field-by-field coercion (fail-open); sections bound to their scope band (`target` ignored); user sections named "Global" with all-global members dissolve once; every existing command is reviewed once on upgrade and tagged `needsReview` -- never changed automatically.
- The row: Add (far left, prominent) . Core (Snap, Canvas, Logs, Browser, Partner, Notes -- components, never data) . Global . Session; target marks per cluster; "this PC" badge on SSH; sections inline with collapse-to-a-chip; fold (default) or two-rows-then-fold; per-band "N more" popover with greyed inapplicable rows and the reason; drag with four drops (cross-band confirms; a drop onto a section of the other band writes nothing until confirmed; a section label dropped across bands confirms); Alt+arrows / Alt+Shift+arrows; menus per surface; Core tools hideable (this session / everywhere; confirm for Partner and for Canvas/Browser while their pane is open -- the pane closes first).
- Dialog: capabilities prop; agent name everywhere (never "Claude" on Codex); machine-explicit "Where it runs" on every kind with a disabled chip + reason where only one answer exists (SSH: "On <host> -- no remote shell in this session" / "On this PC -- partner shell"); secret toggle hidden where the value cannot arrive; stored `kind`; Icon / Colour / Where it shows / Section (re-validated on scope flip; "New section..." in the band); Ask Conductor chip; the preview draws the bar's real chip; the upgrade-review banner with one-click fixes (Make this argument a secret; Make it Session-only; Keep as is).
- Notes: one lock with a grey count in Core; popover list; E5 NoteDialog with Where it shows; NotesBar and the header lock-plus removed. Same store/IPC/encryption.
- Settings -> Custom Commands: four cards only (Command bar, Core tools, Snap, Commands). Snap's right-click deep-links here; `MagicButtonSettingsDialog` removed. App sweeps per-session hide entries on boot.
- IPC: the unused plaintext `credentials:load` bridge removed (preload, main, channel, type) -- ADR-009 pass covers it.

Decisions taken while building (owner where marked):
- Notes on the bar = ONE lock chip + count; notes only in its popover (owner: "NO definitely option 1").
- The popover says "added Nd ago", not "edited": the notes index keeps only `createdAt` (preserved on update) and adding `updatedAt` would touch main/IPC for cosmetics -- deferred.
- Fold priority is by band, not by geometry: when the row overflows, Global gives way from its end even when its own chips fit; Session last; pinned never; room for the pill is reserved. The first cut folded each band against the same un-folded layout and never unfolded, so the band that should fold LAST folded first (caught by the round-1 reviewers).
- Snap keeps no right-click of its own: it is a Core tool like the others (Core menu with "Screenshot settings..." first), so it can be hidden and its settings have one editor.
- `openSettingsTab` reuses the existing `app:openSettings` window event (App already validates the tab against `SETTINGS_TAB_IDS`); no second event.
- One PR for #358 + #359 + #380 + #381 (three logical commits) rather than three stacked PRs: CommandBar.tsx carries the Notes and Snap wiring, so the stack could not be built without hand-splitting one file; the review is per commit instead.

Verification: `npm run typecheck` clean; full `npx vitest run` 640 files / 6773 tests green (baseline on beta 6536); new tests: command-bar-layout, session-capabilities, command-upgrade-review, commandStore-bands, commandbar-one-row/-overflow/-drag/-menus, hide-core-tools, command-dialog-capabilities/-tokens, notes-tool, custom-commands-tab; every guard mutation-checked (round 1: 121 mutations, 114 killed, 7 survivors -> all turned into tests in round 2). VM proof and the ADR-009 pass follow before the PR is marked desktop-tested.

Open follow-ups: #382 (welcome page for the upgrade, same PR), #377 (tips re-review), the VM screenshots listed in the plan canvas.
