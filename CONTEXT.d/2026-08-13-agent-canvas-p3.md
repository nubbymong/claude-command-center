# 2026-08-13 — agent canvas P3: the review loop

Follows the P2 rounds and the `canvas_render` fragment. Branch continues the
canvas work; not merged anywhere yet (build-and-test phase; the security passes
on the new surfaces are batched for the end of it, per owner directive).

## What landed

P3 is the half of the canvas the user actually touches (spec §6, §10): make a
selection, write notes against it, submit the batch as a review, and work the
resolution checklist when the agent hands back a new version. It is also the
shared unlock for all three modes — plan, mockup, and live-UAT review all ride
this same loop.

**Contracts (spec §4).** `AnchorRef` (ux-id primary / fingerprint fallback /
plan-step for P5), `FocusObject`, `Annotation` (element/region/general;
open→approved|reannotated|dismissed; optional sketch; `supersededBy`),
`Review`, `ReviewPayload`. `shared/canvas.ts` no longer carries only the
version/serving subset.

**Bridge additions.** Two requests and two reported events:

- `inspect {x,y}` returns the selection ladder at a point — the meaningful
  element the hover chip would name, then each meaningful ancestor, deepest
  first, every rung carrying the fingerprint (role + accessible name +
  meaningful-ancestor path + ordinal among look-alikes) it could later be
  re-found by. One reply carries everything expand-to-parent will need; one
  shared scan + role/name memo keeps the accname cost flat.
- `resolveAnchors {anchors[]}` re-finds stored anchors in the CURRENT document,
  1:1 with the request: ux-id by attribute comparison (never a CSS selector, so
  nothing needs escaping), fingerprint by candidates[ordinal] — with one
  deliberate judgment call: a candidate field collapsed to exactly ONE is
  accepted (the list shrank around the same element), an ambiguous shrunken
  field refuses. A wrong "found" silently re-points the user's note at someone
  else's element; "needs re-pointing" is the honest failure.
- `contentClick` — the host cannot see clicks inside the frame, so the bridge
  reports them (capture phase; the page's own behaviour untouched — D8).
- `contentKey` — ONLY `Escape`/`ArrowUp`, and never from an editable target:
  the frame owns keyboard focus in browse mode, so "one key expands to parent"
  cannot work without relaying — and relaying anything wider from a page full
  of real inputs is a keylogger wearing a feature's name.

**Main store.** `canvas-review-store.ts`: one `reviews.json` per canvas beside
`canvas.json`; sketch PNGs as real files under `reviews/<rid>/`. The whole
store follows the persist-before-commit order `renderVersion` had to learn the
hard way — every mutation builds the next record off to the side, persists it,
and only then touches memory. Two properties worth naming:

- Submit refuses any half-attached sketch pairing (export missing, export for
  a sketchless note, export from outside the review, not-a-PNG, over-cap) and
  the refusal leaves the draft fully intact.
- A `reviews.json` that exists but does not validate marks that canvas BROKEN:
  reads answer empty, mutations refuse. Treating it as absent would let the
  next note overwrite the whole review history with a fresh record — a corrupt
  file is preserved evidence, not free space.

**`canvas_review` (MCP tool #3 of 4).** The pull side of D10: submit drops a
one-line marker in chat (`Review #N — K notes · canvas_review RN`, typed into
the session PTY), and the agent fetches the payload itself. Transport-bound
session like its siblings; drafts are not fetchable; unknown ids answer with
the store-minted fetchable list. The payload text rides INSIDE the untrusted
envelope (user notes and page-derived labels are data, not instructions);
envelope notes outside carry only minted values (ids, statuses, counts).
Sketches return as PNG image content blocks — loaded BEFORE serialization so
the text's image numbering can never drift from the images actually attached;
a failed read becomes a counted note, not a shifted index.

**Renderer.** Focus lock (click reported by the bridge → `inspect` → ladder in
the review store), ArrowUp expand / Escape clear (both host-side and relayed),
marquee region selection (its own pointer-owning layer, same ownership pattern
as the glass), the docked notes panel (resolution checklist → composer →
pending notes → submit), sketch attach from the live glass selection (D6 — the
records reference glass elements; export happens once, at submit; a sketch
whose glass elements were since erased is dropped from its note before submit
rather than half-submitted). The resolution pass runs once per version on
screen (D12), all open notes' anchors in ONE `resolveAnchors` request;
found → live box, gone → ghosted old bbox + "needs re-pointing". Frame RPC
extracted to `canvas-frame-rpc.ts` so snapshot/inspect/resolve share one
hardened path (random correlation ids, source+origin checked, targeted post).

**UAT unlocked.** A local session's working directory registers as a canvas
UAT root at PTY spawn — `canvas_render mode:'uat'` can now serve a real built
`dist/` (SSH sessions excluded: their cwd names a remote path). The allowlist
stays default-empty otherwise.

## State

Suite 4492 green (+44 new), `npm run typecheck` clean across node/web/bridge.
Fragment written before any local-installer packaging work.

## Still open (P3-adjacent)

- The spec's P3 acceptance gate (5 mixed-scope notes end-to-end on a real
  page, ≥4/5 re-anchored via ux-id, restart round-trip) needs the LOCAL test
  build — the restart half is unit-covered, the real-page half is not
  jsdom-testable.
- Playwright E2E for the loop, draw/browse toggle, checklist (spec testing
  requirements) — deferred with the rest of the end-phase batch.
- `snapshotContext` on ReviewPayload annotations is typed but not populated
  (the agent scopes `canvas_snapshot` instead).
