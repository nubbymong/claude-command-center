# ADR-018 — One-row command bar: Core · Global · Session, sections on the row, Notes in Core, hideable Core tools, a small Custom Commands settings page

- **Status:** Draft — design approved by the owner on the Agent Canvas ("Command bar — one row", v7, 2026-08-21); finalised with the first PR
- **Date:** 2026-08-21
- **Issues:** #358 (bar), #359 (dialog look), #380 (Notes in Core), #381 (hide + Settings)
- **Supersedes:** the row model shipped in #345 ("the row is the truth") — the truth moves from the row to the chip

## Context

The shipped bar draws a tool row (`⌄ Commands N · Snap · Canvas · Logs · Browser · Partner · +`) and two labelled rows (`CLAUDE` / `SHELL`, and `Partner`) with user sections rendered as collapsible header buttons. The owner's review of beta.16: nothing should say "Commands"; the "weird › Global buttons" must go (they are literally user sections *named* "Global"); user buttons should look like the Core tools (icon + label); Add is a bare `+` at the far edge; the two rows below the tool row steal terminal height. The canvas review (R1) added: the bar and the dialog must know what kind of session they are in; overflow may use a second row if it makes sense; drag re-ordering; sections stay (rename/move; Global is fixed); the `+` offers Add section; the encrypted-notes lock-plus in the session header moves to the toolbar as a tool with a count; Core tools can be hidden (this session / everywhere) with a restore in Settings; Settings gains a Custom Commands page kept deliberately small.

Ground truth established by the read-only multi-agent investigation (file:line anchors in the run record):

- The bar's only type-awareness is one boolean, `mainPaneIsShell` (App.tsx, CommandBar.tsx); provider and transport never reach the labels. A Codex session is labelled "Claude" and its dialog offers "Send a prompt to Claude" (CommandDialog.tsx). `CommandDialog` receives only `configId` + `mainPaneIsShell`.
- The partner pane is a LOCAL shell PTY on every session, including SSH (App.tsx passes no `ssh` prop to the partner TerminalView). A shell command on an SSH Claude session therefore runs on the user's machine; the dialog says only "The partner shell".
- Secret arguments reach only local shell spawns (pty-handlers.ts, providers/claude/spawn.ts) and the typed reference is host-platform-shaped (shared/command-secret.ts) — on Windows→Linux SSH the button types `$env:…` into bash with nothing set.
- Ordering is array position in one flat `commands.json` across all configs; `handleDrop` reorders the whole array, re-parents `sectionId` by in-place mutation and cannot insert at the end. Sections carry `target` and are filtered by it; a bar-created section can never be global while a config is active.
- `commandBarUi` persists exactly `{collapsedSectionIds, barCollapsed}`, is written whole on every toggle, and hydration casts to that two-field shape — any new field must be added in both places or it is dropped on load and clobbered on the next click.
- Settings has no command-bar setting at all; the established hide pattern is a denylist by id + `HideDockFeatureDialog` naming Settings as the way back. Snap's colour/auto-delete are reachable only by right-clicking Snap (old-palette dialog). `loggingEnabled` already removes Logs.
- Encrypted notes are `NotesBar` in `SessionHeader` (coloured chips + lock-"+"), backed by `notes.list/save/load/delete`; `notes.list` returns label/colour/scope only — content is decrypted only when a note is opened.
- The bar is a flex sibling under the terminal; any height change runs `fit()` + `pty.resize` (documented ConPTY aggravator); "height changed under the pointer" is a previously fixed defect class.

## Decisions

**D1 — Layout.** One row, three fixed bands in order **Core · Global · Session**, each a `role="toolbar"` with one tab stop (roving tabindex). Bands are SCOPE, not sections: Global and Session cannot be renamed, moved or deleted. No text on screen says "Commands"; the bar's only static words are the two band labels and the labelled `Add ▾` control. The CLAUDE/SHELL/Partner row labels go; the target rides on each chip (D4). `barCollapsed` survives as "Hide the command bar" in the empty-bar menu with its restore in Settings.

**D2 — One derived `sessionCapabilities`.** Replace `mainPaneIsShell` with one shared function of (provider, sessionType, shellOnly) returning `{ agent, agentName, mainAccepts, mainRunsOn, partnerRunsOn: 'local', panesOnDifferentMachines, canIndexLogs, canSendImageToAgent, canDeliverSecret(target), hasConfig }`. `canIndexLogs` calls LogsPane's own predicate. CommandBar, CommandDialog (prop widened), the Notes tool and the Settings page read this and nothing else. Rejected: more booleans threaded alongside; per-component derivation (the drift we have today).

**D3 — Core-tool matrix from capabilities.** Core tools are components, never data, never drop targets. Local Claude: all live. Local Codex: Logs dimmed ("Codex transcripts aren't indexed"), prompt card says "to Codex". Terminal-only: Snap not drawn (it types a prompt into a shell), Logs dimmed, Canvas/Browser/Partner live. SSH Claude: Logs dimmed ("the transcript lives on <host>"), Partner badged "this PC". Ask Conductor: as local Claude, no Session band. Dimmed-with-reason is the default for "structurally empty"; removal is reserved for "types nonsense" and for user hides (D9).

**D4 — Target on the chip.** Every user chip sits in a cluster opened by a small target mark (agent glyph — the provider's own — / shell prompt / globe); on any session where the panes are on different machines (every SSH session) the shell mark and the Partner tool carry a **this PC** badge. The same mark is drawn in the dialog preview, the overflow list and the right-click header.

**D5 — Global means "every session it can actually run in".** Applicability is COMPUTED from capabilities at render time, never stored. Structurally impossible → overflow popover, greyed, one-line reason. Possible-but-different (a shell command on SSH) → on the row with the badge. Nothing is deleted or rewritten.

**D6 — Data model.** `CustomCommand` gains `icon?` (key into a curated ~40-glyph stroked set; absent = monogram tile of `label[0]` on a tint of `color`), `pinned?`, `order?` (per-band ordinal). `scope` unchanged; the dialog relabels it "Where it shows" (Global — every config / Session — this config only). New `COMMAND_SWATCHES` (the eleven section pastels); `COLOR_SWATCHES` not re-pointed. `CommandSection` keeps id/name/color/scope/configId; `target` is retained one release but ignored as a filter — a section is bound to a scope band, not a pane. `CommandBarUiState` gains `overflow: 'fold' | 'wrap2'`, `hiddenCoreTools: { everywhere: ToolId[], byScope: Record<ScopeKey, ToolId[]> }`; the hydration cast is widened in the same commit. Rejected: target-scoped sections; free-text icons; hide state keyed on session id alone.

**D7 — Drag.** `reorderCommands(movedId, band, beforeId|null)` rewrites one band's ordinals and saves immediately. Four drops: within a band = reorder (explicit end-of-band slot); Session→Global = widening scope change, confirmed; Global→Session = narrowing (keep only here), confirmed with the count; onto a section = the only path that writes `sectionId`. Core is a no-drop zone; Core tools are not draggable into bands. Bar height is frozen while dragging. Keyboard parity: Alt+←/→ within, Alt+Shift+←/→ across (same confirm); mirrored in the menu as Move ▸.

**D8 — Overflow.** A persisted user setting `overflow = 'fold' | 'wrap2'`, default `'fold'` (one row; the remainder folds into a per-band "N more" pill with a filterable popover; Global folds first, Session last, pinned never). `'wrap2'` wraps to at most a second row, bands contiguous, then folds. No "wrap freely", no horizontal scroll. Layout recomputed only on resize and add/delete/pin/drop, with hysteresis.

**D9 — Sections on the row + hiding.** A user section is an inline chip group (coloured label + chips), renameable in place, movable by dragging its label, deletable (keeps its buttons); "Collapse to a chip" is an option backed by the existing `collapsedSectionIds`. Sections created in the Global band are scope `global` (possible for the first time). Core tools get their own context menu (own actions first · Hide this tool ▸ In this session / Everywhere · Move); "In this session" = the live session; "Everywhere" persists; a confirm for Partner and for Canvas/Browser while their pane is open (the pane closes first); "Show hidden tools ▸" in the empty-bar menu; `loggingEnabled` takes precedence over a hide of Logs.

**D10 — Notes in Core (replaces the earlier "Secrets tool" idea, which misread the owner).** The encrypted notes move from the session header into Core as a lock with an unobtrusive grey count (notes visible to this session = global + this config). Click → a popover listing the notes (label, colour, scope, last edited; Edit/Delete; Add note; other configs folded); a note opens `NoteDialog` restyled to the E5 look. Same store, same IPC, same encryption; content decrypted only while the dialog is open. `NotesBar` is removed from `SessionHeader`. **Command secrets get no tool of their own** — the command dialog's toggle and the chip's lock mark are the whole surface (owner: embedding is enough).

**D11 — Settings → Custom Commands, kept small.** Tab id `commands`. Four cards only: Command bar (One row · Two rows then fold; Show the command bar), Core tools (restore hidden; Logs notes the privacy toggle), Snap (colour, auto-delete — migrated; Snap's right-click deep-links here), Commands (plain searchable list · Edit / Delete). Explicitly NOT: density, default-icon style, applies-to chips, bulk operations, a sections panel, a secrets list, import/export.

**D12 — Dialog.** Props widened to `capabilities`; every "Claude" string derived from `agentName`; kinds offered = "Send a prompt to <agentName>" only when an agent exists, "Run a command" and "Open a page" always. "Where it runs" is a machine-explicit segment on every kind, disabled with a reason where only one answer exists (SSH Claude: "On <host> — no remote shell in this session" / "On this PC — partner shell"). The secret toggle is hidden where the destination cannot receive it. New fields: Icon, Colour, Where it shows, Section (with inline create, re-validated on scope flip). E5 restyle with glyph kind tiles, the Ask Conductor chip, the lock callout, and a preview that draws the real chip; the shared icon+colour picker is also the right-click quick picker. No backdrop `onClick`.

**D13 — Upgrade review of existing commands (owner, 2026-08-21).** On the first launch after this change every existing command is checked against the new model and tagged `needsReview: [reasons]` when something clashes — never changed automatically. Reasons: an argument that looks like a secret (a flag named token/secret/password/api-key/bearer, or a value shaped like a key — `sk-`, `ghp_`, JWT, long hex/base64) → "store this as a secret?"; a Global prompt button that is inert on the user's terminal-only configs; a button in a dissolved "Global" section; a target whose meaning changed (a shell button on an SSH config now says "this PC"); an off-palette colour kept as an extra swatch. Surfaces: an amber mark on the chip, a banner at the top of that command's dialog listing the reasons with one-click fixes (Make this argument a secret → value to the keychain and `{secret}` in the line · Make it Session-only · Keep / Dismiss), "Review N commands" in the Add ▾ menu while any remain, a "Needs review" filter in the Settings list. The tag clears on fix or dismiss; dismiss is remembered per command. Rejected: silent auto-conversion of arguments to secrets (the app cannot know which value is sensitive; a wrong move breaks a command with no visible cause); no review at all (the exact silent-drift class the owner flagged).

## Consequences

- First real ordering model (`order`, `pinned`) and the invariant that only a section drop writes `sectionId`; the untested drag handlers gain tests in the same PR.
- One shared capabilities function becomes the single place session-type truth lives; a future session type is added in one function.
- User-visible on upgrade: rows → bands; collapsed sections → inline (collapse-to-a-chip available); Snap leaves the row on shell-only sessions; Logs dims where empty; the dashed "global" chip leaves the chip; user sections named "Global" with all-global members dissolve; note chips leave the header for the Core lock. All named in the changelog.
- New persisted fields are optional and hydration fails open: a damaged `command-bar-ui.json` degrades to "everything shown".
- The SSH partner-is-local fact becomes VISIBLE rather than fixed; a remote shell pane is out of scope.
- Wrap-to-two-rows exists but is opt-in; default stays one row.

## Migration

- M1 Commands: `icon` absent → monogram; `pinned` absent → false; `order` assigned once from current array position within each band; existing off-palette hexes kept and shown as an extra swatch.
- M2 Sections: a section named "Global" (case-insensitive) whose members are all global-scope is dissolved (members keep order, `sectionId` cleared); otherwise renamed "Global (yours)" with a one-time line; `target` ignored from this release, removed from the type one release later.
- M3 `commandBarUi`: existing fields carry forward; new fields default (`overflow: 'fold'`, `hiddenCoreTools` empty); hydration cast widened; `reconcile()` drops dead `sess:` keys.
- M4 Snap settings keep their store; Settings becomes the editor; Snap's right-click deep-links.
- M5 Notes: no store change; the header chips and lock-plus are removed.
- M6 Upgrade review (D13): run once after M1–M2, tags written to `commands.json` as `needsReview`; cleared per command on fix or dismiss; a fresh install has nothing to review.

## Security notes

- No change to how a command line is built or typed (`buildCommandLine`, PTY argv) — not ADR-009 territory by itself.
- ADR-009 applies only if the work touches `src/main/ipc/**` / `src/preload/**` (the optional removal of the unused plaintext `credentials.load` bridge, or any names-only list channel if a secrets tidy list is ever added) — run once over the finished stack, bounded to those files plus the dialog's secret path and the deletion sweeps.
- The secret toggle is hidden wherever `canDeliverSecret(target)` is false, so a command never runs with an empty credential unannounced.
- Notes: content is decrypted only inside the open dialog, exactly as today; the count and the popover use the existing names-only `notes.list`.

## Owner decisions (taken 2026-08-21, first option of each unless the owner says otherwise)

Overflow default = fold · "Hide in this session" = the live session · SSH Claude: badge + "runs on this PC", no remote pane · cross-band drag changes scope with confirm; Global→Session = keep only here · "Global"-named sections dissolve when all-global · Snap not drawn on terminal-only · Logs dimmed with reason · existing colours kept · "Send a prompt — to Codex"; band name "Session" · "Run command…" palette is a separate item · icon sheet: first cut, then prune · Settings page kept small (owner, explicit).
