## 2026-08-11 -- Agent Canvas P1: ccc-ux:// serving, glass, bridge, draw/browse toggle

P1 of the Agent Canvas (2.2 headline; P0 measurement-delta gate passed GO) is
built on `feat/agent-canvas-p1`, targeting `beta` under the `release-2.2`
label (held until 2.1 promotes).

What landed:

- `ccc-ux://` privileged scheme + main-process `protocol.handle` responder
  serving canvas content with no open port; per-canvas origins; three-layer
  path confinement; per-mode CSP + nosniff/no-store. See ADR-015.
- Canvas store (main): one canvas per session, monotonic linear versions
  (`v1`, `v2`, ...), design documents stored as real files under
  `<resources>/canvas/<canvasId>/versions/`, uat versions registered as dist
  roots. Writes via `mkdirSecure`/`atomicWriteSecure`. Restart rescan.
- IPC domain `canvas:*` (getState/render/setActiveVersion + changed push),
  Zod-strict; preload + d.ts mirrors; renderer `canvasStore`.
- The per-session Draw button became **Canvas** (Agent Canvas). Empty state
  renders the untouched `ExcalidrawPane` -- classic scratchpad lost nothing.
  With content: iframe below, transparent Excalidraw glass above (scene
  pinned 1:1 to content scroll so marks track the page), transient
  highlight-overlay divs on top, and the draw/browse pointer-events toggle
  as the primary toolbar control.
- Serve-time-injected postMessage bridge (plain page JS, read-only from the
  content side): ready/viewport/pointer events, snapshot/boxMap/
  elementAtPoint requests, P1 role/name heuristics (P2 upgrades to
  dom-accessibility-api + aria-query + axe).
- Coordinate module `canvas-coords` (page <-> stage <-> scene, glass-binding
  helpers) with unit tests, including the binding theorem.
- Tests: 3959 unit green (traversal/junction-escape suite, handler Zod
  gates, bridge protocol in jsdom, source-text security guards) + a
  Playwright frame-security spec (no Node/IPC/preload in frame, egress
  confined to the canvas origin) for CI/VM.

Decisions of note: design-mode CSP allows inline scripts (single-file agent
mockups are the product; frame stays sandboxed + egress-confined); the glass
has no free camera in P1 (content is the camera); sanitizer rejects decoded
`/` in segments (caught by the traversal tests -- layer 1 must hold alone).

Follow-ups: adversarial review (ADR-009) before merge; canvas MCP tools land
P2/P3 and must validate handles against the transport-bound session id (#188
precedent); form-state semantics + sr-only heuristic are HARD P2 scope; the
normative spec file stays untracked pending an owner call on committing it.
