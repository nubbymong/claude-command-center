# 2026-08-24 — Agent Hub "New pipeline" crash (#442)

Owner repro: Agent Hub → New pipeline → the whole app went down.

Root cause: `TeamBuilder` selected `s.getAllTemplates()` from
`agentLibraryStore` — a method building a FRESH array per call. Zustand's
Object.is equality never holds, `useSyncExternalStore` re-renders for ever,
React throws "Maximum update depth exceeded" on mount, and the app-wide
ErrorBoundary takes the window down. The repo already documents this exact
rule (TipCard / AskConductorDock: derive outside the selector). Audit: one
other method-call selector exists — `WebviewPane.tsx` `s.homeFor(configId)` —
benign only because it returns a primitive (Object.is holds); no other live
instance of the array/object shape remains, and the store's three getter
methods are DELETED so the footgun cannot be re-selected.

Why CI was green: the save-failure suite stubs the store with a plain selector
call — no subscription, no loop. The new `team-builder-mount.test.tsx` mounts
against the REAL store; it fails with the old selector (verified by reverting)
and passes with the fix. The stub in the save-failure suite now serves the
stable `templates` array the component actually selects.

Fix: select `s.templates` (stable reference) and `useMemo` the
`[...user, ...BUILTIN_TEMPLATES]` concat.

The wider Agent Hub usefulness review (library, pipelines, multi-account fit)
is #443 — owner decision pending; this fix keeps the surface honest meanwhile.
