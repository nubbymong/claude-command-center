# 2026-08-24 — Two-mode left panel (Saved ⇄ Running) + Quick Start

The sidebar's Saved-Configs hover fly-out (and its pin-open machinery, notch,
height measurement) plus the #362 cards/find views and the always-below
PinnedConfigsPanel are replaced by ONE structure, agreed on the canvas
("Saved Configs design pass", v14, owner-approved 2026-08-24):

- The left panel is now **two modes**: `Saved` (the launcher) ⇄ `Running`
  (live sessions), tabs at the top; default tab **Running**
  (`sessionsPanelDefaultTab`, resolver-read, Settings › General picker).
- **Quick Start** leads the Running tab: launch-only strip of `pinned`
  configs (the field is reused — pins carried over with no migration). A
  pinned config whose session is LIVE is omitted and counted as "N running"
  in the header, returning when the session closes — which is what killed
  the old duplicate-pinned-at-top bug. Collapsible (`quickStartCollapsed`).
- **Saved** keeps the sections/groups list; rows re-identified — the
  session-TYPE badge leads, the config colour is a small chip beside the
  name, no folder/user text. A config with a live session is **locked**:
  greyed dashed row, lock + Running pill, no launch/edit/delete (menu items
  disabled with reasons too), click/Enter jumps to its session.
  Launch-all (group/section) now skips running configs for the same reason.
- Pin from BOTH context menus ("Pin to Quick Start", deferral hint on a
  running unpinned config). Session menu's item pins the underlying config;
  hidden for config-less sessions (Ask).
- The guided tour's "Saved configs live here" anchor moved to the
  always-mounted Saved tab (`data-tour="new-config"`) — inside the Saved
  body it was unresolvable at tour time and the step silently skipped.
- Retired-but-typed settings: `configPanelPinned`, `savedConfigsView`
  (@deprecated, hydrate-compat only).

Acceptance gate: owner's visual pass in the Hyper-V VM with a staged fake
config/session set covering every state (tab switch, Quick Start collapse,
locked row, pin from both menus, light mode).
