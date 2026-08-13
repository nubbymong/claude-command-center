# 2026-08-10 — GHSA-58r3-f5hg-vxcq published (MCP token world-readable)

The Conductor MCP server's auth token was written world-readable on POSIX (and
junction-redirectable on Windows), so any other local user could read it,
authenticate to the loopback MCP server, and reach `vision_eval` (arbitrary JS
in the embedded browser) plus host file-access and cross-session tools.
Precondition: a second local user account on the machine. Severity high,
CWE-276. Reported/credited: ssbn.

Fixed on beta before beta.7: the config dir + token file are created private via
`mkdirSecure`/`atomicWriteSecure` (0600) and repaired if found otherwise, the
token rotates on upgrade, and the per-session `mcp-<sid>.json` / hooks
`settings-<sid>.json` files that carry it are 0600 too; `config-manager` is
fail-closed and `pty-manager` omits `--mcp-config`/`--settings` when the file
was not written. Landed via the private-fork merges `3176892` (+ follow-up
`4233279`) and `aada4ca`. Shipped in **v2.1.0-beta.7** (`f4f0a91`); advisory
patched = 2.1.0-beta.7, affected <= 2.1.0-beta.6 (stable 2.0.0 is in range).

Adversarial re-attack of the fix: PASS (see the earlier local embargo note on
the #244 sweep, now moot). This finding was routed privately throughout;
public record (this fragment + the beta.7 changelog entry + the advisory) all
written at publish time.
