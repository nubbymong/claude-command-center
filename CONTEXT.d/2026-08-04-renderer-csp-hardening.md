# 2026-08-04 — Enforce the renderer CSP in packaged builds (defense-in-depth)

The renderer's Content-Security-Policy was only ever delivered as an
`onHeadersReceived` response header. That reaches the renderer in dev
(`loadURL` → `http://localhost`), but a header cannot reach a `file://`
document, so the **packaged** renderer ran with no enforced CSP. This closes
that gap — defense-in-depth, not an exploitable-hole fix: an independent audit
(sink enumeration + taint analysis) found the renderer has a single raw-HTML
sink (`SanitizedMarkdown`), DOMPurify-gated with an `https:`-only, no-`img`/`svg`
allowlist, and every other untrusted source is React-escaped text or
`xterm.write()`. The CSP restores the second layer behind that in shipped
builds.

## Shape

- `src/shared/csp-policy.ts` — one `CSP_POLICY` string, used by the dev header
  and mirrored in a `<meta http-equiv="Content-Security-Policy">` in
  `src/renderer/index.html` (the meta is what enforces on `file://`). A unit
  test fails if the two drift.
- Over the old header the policy adds `'wasm-unsafe-eval'` + `worker-src
  'self' blob: data:` (Excalidraw's WASM image pipeline — WASM compile only, not
  JS eval, so injected script stays blocked) and `object-src 'none'; base-uri
  'self'; form-action 'self'` backstops. `connect-src` allows no remote origin
  (all network is IPC-routed through main).

## Excalidraw fonts (coupled fix)

Enforcing `font-src 'self'` surfaced that Excalidraw fetches ~15 font families
from `esm.sh` (a CDN) at runtime. The eight Latin families are now vendored
under `public/excalidraw-assets/` and pointed at via `EXCALIDRAW_ASSET_PATH`
(set in a side-effect module imported **before** the library evaluates — load
order was the subtle bug; the library bakes font URLs on module init). Excalidraw
now renders its fonts locally with no CDN traffic; the ~13MB CJK Xiaolai family
is intentionally not bundled (system-font fallback). Excalidraw still lists its
hardcoded `esm.sh` fallback in every font `src`, so the CSP logs a cosmetic
blocked-fallback warning per font on canvas open — no functional, user, or
network impact (the local source wins); accepted as an upstream wart.

## Verification

`npm run typecheck` clean; `npx vitest run` 3725 passing (incl. new
`csp-policy-sync` + `excalidraw-fonts-guard` tests). On the Windows VM the built
app boots and the full shell renders under the enforced `<meta>` CSP with 0
violations; the multi-source Excalidraw FontFace loads from the local bundle.
Adversarial-review PASS recorded on the PR (touches CSP → ADR-009).
