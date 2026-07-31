## 2026-07-30 -- Close the 12 open Dependabot alerts via the overrides block (#152)

All twelve open alerts were TRANSITIVE -- none was a direct dependency at a vulnerable
version -- entering through only three direct deps:

- `@modelcontextprotocol/sdk@1.29.0` -> hono (3 alerts), `@hono/node-server` (1),
  ajv -> fast-uri (2), express -> body-parser (1)
- `@excalidraw/excalidraw@0.18.1` -> mermaid -> dompurify (1), sass -> immutable (2)
- dev-only: js-yaml (1), brace-expansion (1)

Closed by bumping pins in the `overrides` block package.json already carries for exactly
this purpose, plus one direct dep:

  hono ^4.12.21 -> ^4.12.27 (resolves 4.12.32)   fast-uri ^3.1.2 -> ^3.1.4
  dompurify ^3.4.10 -> ^3.4.12 (direct)          body-parser NEW ^2.3.0
  immutable NEW ^4.3.9                           js-yaml NEW ^4.3.0
  brace-expansion NEW ^5.0.7 (resolves 5.0.9)

`npm audit` also surfaced two the Dependabot list did not yet carry, both already pinned
in overrides at stale floors -- postcss (path traversal via sourceMappingURL, vulnerable
<=8.5.17) and tar (uncatchable stack-overflow DoS, vulnerable <=7.5.20). Bumped to
^8.5.18 / ^7.5.21. Note the installed versions were ALREADY above the old override floors
and still vulnerable, so the floor alone proves nothing -- the audit range is what matters.

THE ONE REAL JUDGEMENT CALL -- `@hono/node-server` 1.19.x -> 2.0.12, a MAJOR bump of an
MCP SDK transitive:

- Alert 123 / GHSA-frvp-7c67-39w9 has NO 1.x backport. Verified against the advisory:
  affected `< 2.0.5`, patched `2.0.5`. `^1.19.14` resolves to 1.19.17, still in range.
  So closing the alert requires the major; there is no cheaper path.
- The SDK declares `^1.19.9`, so this override forces it past its own declared range.
  Empirically: `streamableHttp.js` loads clean under 2.0.12, and the only symbol it uses,
  `getRequestListener`, has an unchanged `(fetchCallback, options = {})` signature.
- This matters because CCC DOES use that transport (conductor-mcp-server.ts:708), not just
  SSE -- so it is a live code path, not dead weight.
- Honest limit of the verification: a scratch harness that drives
  StreamableHTTPServerTransport over a real socket TIMED OUT -- but it timed out
  IDENTICALLY on 1.19.17, so the timeout is the harness, not a regression. The bump is not
  proven harmful; neither is it proven exercised. Only running the app closes that gap,
  which is why the ticket requires a desktop MCP smoke test before merge.
- Worth recording for whoever revisits this: the vulnerability itself is very likely
  UNREACHABLE here. It is a path traversal in hono's `serveStatic` on Windows via encoded
  `%5C`, and neither the SDK's server code nor CCC calls `serveStatic` at all (grepped).
  The defensible alternative was to dismiss alert 123 as unreachable and stay on 1.x.
  Taking the bump was a deliberate call to keep the alert list at zero rather than carry a
  standing exception; if 2.x ever causes trouble in the field, reverting to 1.x plus a
  documented dismissal is the fallback, not a regression.

Verification: `npm audit` 0 vulnerabilities across the whole tree (prod and dev), typecheck
clean, 3163 unit tests pass, `npm run build` succeeds. NOT yet verified: the MCP paths
(Conductor Proxy, vision) exercised in the running desktop app on Windows.
