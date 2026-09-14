## 2026-08-04 -- A pinned Saved Configs panel came back invisible (#217)

Reported: with the Saved Configs panel pinned, it does not display after launching the app;
you have to unpin and re-pin to see it.

Two states drove one panel and they have different lifetimes:

- `configPanelPinned` -- PERSISTED in settings, restored on launch.
- `configPanelOpen` -- LOCAL `useState(false)`, reset on every mount.

The panel's `maxHeight` read `configPanelOpen` alone (`Sidebar.tsx:662`), so a restored pin
rendered with the pin lit, `aria-expanded="true"`, and a height of 0. The header already
disagreed with the body: `aria-expanded` and the chevron rotation both computed
`configPanelOpen || configPanelPinned`, so they reported expanded while the panel was
collapsed -- an accessibility defect in its own right, and the clue that the body was the
odd one out.

The root cause is that pinning never opened the panel. It opened as a SIDE EFFECT inside the
pin handler:

    setConfigPanelPinned(prev => {
      if (!prev) setConfigPanelOpen(true)   // the only thing that opened it
      return !prev
    })

Restore the pin from disk and that line never runs. Unpin/re-pin was the user manually
re-triggering it.

Fixed with a DERIVED default plus an explicit override, extracted into
`components/sidebar/configPanelState.ts` so the regressed case is unit-testable without
mounting the whole Sidebar:

    const [configPanelOpen, setConfigPanelOpen] = useState<ConfigPanelOverride>(null)
    const configPanelExpanded = resolveConfigPanelExpanded(configPanelOpen, configPanelPinned)

The load-bearing detail: `useState(configPanelPinned)` -- the obvious fix -- does NOT work.
Settings hydrate ASYNCHRONOUSLY AFTER MOUNT, so the initial value latches the pre-hydration
`false` and the bug survives. `??` re-evaluates every render, so the panel opens by itself
the moment the setting arrives, with no `useEffect` and no ordering race. A test asserts
both sides of hydration with the same override.

Two behaviour changes that came with it, both deliberate:

- The chevron now works while pinned. It was gated on `!configPanelPinned`, so "pinned" also
  meant "stuck open". The user asked for pinnable AND collapsible.
- Pinning CLEARS the override rather than forcing `true`. Forcing it looks identical until
  the user has previously collapsed the panel, at which point the stale `false` wins and
  pinning appears to do nothing -- the original symptom with extra steps.

Accepted: collapsing a pinned panel is not persisted, so a pinned panel starts expanded next
launch. "Pinned" means "starts open"; persisting the collapse would need a second settings
field and was not asked for.

Investigation note worth keeping: the first pass chased the WRONG pin entirely -- the
per-config `config.pinned` / `PinnedConfigsPanel` feature -- and audited its whole
read/write/render path (all sound) before the reporter clarified it was the panel-level pin
for the left-hand bar. When a report says "pin", establish WHICH pin before tracing code;
this codebase has two unrelated ones, and the on-disk evidence for the per-config pin
(everything `false`) was real but irrelevant.

Gate: 3547 unit tests pass (10 new), typecheck clean. The new guard was verified to fail
against the old semantics -- 5 of 10 cases fail when `override ?? pinned` reverts to
`override === true`.
