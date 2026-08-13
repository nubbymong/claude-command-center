# ADR-015: Serve Agent Canvas content over a privileged `ccc-ux://` scheme

Date: 2026-08-11
Status: accepted

## Context

The Agent Canvas (2.2 headline) needs to render agent-authored web content --
design mockups and built project output -- inside the app, review it, and draw
over it. The content is untrusted-by-posture (it is whatever an agent built),
so it must not run in the app renderer's origin, must not open a localhost
port (every port is reachable by any local process), and must not weaken the
renderer CSP.

## Decision

- Content renders from a custom scheme, `ccc-ux://`, registered privileged
  (`standard`, `secure`, `supportFetchAPI`; never `bypassCSP`) and served by a
  `protocol.handle` responder in the main process. No server, no port.
- URL shape `ccc-ux://<canvasId>/<versionId>/<path>` puts the canvas id in the
  HOST, so every canvas is its own origin: storage and service-worker scope
  cannot leak across canvases or sessions.
- The responder is read-only and triple-confined: a decoded-segment filter
  (no dot-segments, separators, drive/ADS colons, NUL), lexical containment
  under the version's content root (`validatePath`), and physical containment
  (realpath of the served file must stay under the realpath of the root, so a
  link planted inside the tree cannot escape; the root itself is a trusted
  anchor, same stance as `mkdirSecure`).
- Every response carries a restrictive per-mode CSP (egress `connect-src
  'self'` only) plus `nosniff`/`no-store`; design mode additionally allows
  inline scripts because single-file agent mockups are the product (D14 --
  the canvas must not degrade what the agent can build).
- The renderer embeds content in a sandboxed iframe (`allow-scripts
  allow-same-origin allow-forms` -- same-origin is safe because the frame
  origin is never the app's own) and the app CSP gains exactly `frame-src
  ccc-ux:`. The host's `onHeadersReceived` CSP injector passes `ccc-ux://`
  responses through untouched so the per-mode policy survives.
- The in-page bridge is plain page JS injected at serve time and speaks
  postMessage only, read-only from the content side. No CDP, no preload, no
  Node in the frame.

## Consequences

- The app carries its first custom protocol; privilege registration must stay
  at module scope of `src/main/index.ts` (before app ready) or canvas
  documents silently lose fetch/storage.
- Canvas content capability is bounded by the per-mode CSP; per-project
  allowlisting of external asset hosts (spec 3.1) is future explicit config,
  never a default.
- The serving path is security-sensitive (ADR-009 applies to every change
  touching it) and is pinned by unit guards (`tests/unit/main/
  ccc-ux-protocol.test.ts`, `tests/unit/renderer/agent-canvas-security-guard
  .test.ts`) and a live-frame Playwright spec.
