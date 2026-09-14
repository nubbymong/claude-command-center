# 2026-08-21 — GHSA-m8p2-cf72-7p35: the renderer could read and overwrite the Conductor MCP bearer token (fixed in 2.1.0-beta.16)

Public record, written after publication as the embargo requires. Found by the single
ADR-009 pass over the beta.16 substrate (`CONTEXT.d/2026-08-21-adr009-beta16-pass.md`,
"the one pre-existing finding routed privately"); fixed in the advisory's private fork,
merged from the advisory page as `2317e1fe` ("Merge commit from fork"), shipped in
v2.1.0-beta.16, advisory published the same hour.

## What was wrong (since `08ba3e3d`, v2.0.0-rc.1)

`config:loadAll` handed the renderer **every** config file in CONFIG/, including the two
`config-manager.ts` itself classes as secrets (`SECRET_CONFIG_KEYS`): `conductorSecret`
(`conductor-secret.json`, the 32-byte bearer token that is the ONLY gate on the loopback
Conductor MCP server, which exposes `vision_eval` = arbitrary JS in the embedded browser)
and `sshCredentials` (legacy safeStorage-encrypted SSH passwords). The renderer had no
reader for either. In the other direction `config:save` accepted **any** registered key
from the renderer — the `ConfigKey` annotation was compile-time only — so a renderer
could also persist an attacker-chosen token that `install-secret.ts` would trust on the
next launch. Chained, not direct (a renderer compromise comes first); assessed Moderate
on CVSS, "High" by GitHub's banding.

## The fix (`src/main/config-manager.ts`, `src/main/ipc/config-handlers.ts`)

`RENDERER_CONFIG_KEYS` = every registered key minus `SECRET_CONFIG_KEYS`;
`isRendererConfigKey(key: unknown)` (exact string match, unregistered and secret keys both
false); `loadAllConfig()` iterates the renderer keys only; `config:save` refuses any other
key (false, one warning naming the key, never the data). Main-process consumers of the
secrets (`install-secret.ts`, `credential-store.ts`) use `readConfig`/`saveConfig`
directly and are unchanged. `tests/unit/config-renderer-boundary.test.ts` (6) drives
both directions through the real IPC handlers with the files on disk, including the
serialised result containing neither value; both guards were mutation-checked. The
re-attack round (attacker E) confirmed no other `config:*` path reaches the files and
that no renderer hydrate path relied on the two keys.

## Process notes

- The maintainer account's `gh` cannot use private vulnerability reporting on its own
  repo (403 on `/security-advisories/reports`); the maintainer endpoint
  (`POST /security-advisories`) with `scripts/file-advisory.mjs`'s validated payload
  created the advisory and its temporary fork in one call. Path B of the runbook.
- Workspace-fork PRs cannot be merged by API ("forbidden on workspace repositories") —
  the Merge button on the advisory page is the only route; GitHub deletes the temporary
  fork on publication by itself.
- Related, same-user-only hardening noted for later: the canvas served-root floor could
  also refuse the resources directory (a session whose cwd IS the resources dir can
  serve CONFIG/ over the canvas) — no privilege gain, the agent already runs as the user.
