## 2026-08-14 -- 2.1.0-beta.9 released; two Windows CI fixes (Chocolatey + eSigner KSP)

2.1.0-beta.9 shipped on the beta channel. It is a security release plus the #216
per-account claude.ai web session feature and three fixes (#241 win32 SSH
ControlMaster, #250 installed-version + channel in the update UI, #183 flaky
config-manager atomic-write test). The quick fixes landed via #260; the release
notes are generated from src/renderer/changelog.ts.

Two previously-embargoed advisories were published alongside the release:

- GHSA-q83v-phcc-hgv4 (high): cross-session MCP tool access. The install-wide
  Conductor token is replaced with per-session HMAC-bound tokens; the server
  derives the calling session from the authenticated token, never a query
  parameter.
- GHSA-phr3-g5qh-q4v5 (medium): remote ~/.claude re-hardening plus symlink-safe,
  exclusive-create (flag 'wx') token writes on SSH session setup.

Both fixes were developed on private forks and merged to beta before the release;
patched version 2.1.0-beta.9.

Cutting the release surfaced two Windows-only CI problems, both now fixed so
future releases do not hit them:

1. Chocolatey rate-limiting. The Windows job installed VS Build Tools via
   `choco install visualstudio2022buildtools` to run an @electron/rebuild of
   node-pty and better-sqlite3. community.chocolatey.org rate-limits per source
   IP (behind Cloudflare; ~5/min for *.extension packages, 1-hour ban) and
   intermittently blocks GitHub's shared runner IPs, so the install failed at
   random with "not valid XML" / unresolved dependency -- while a normal client
   gets HTTP 200. Both modules ship N-API prebuilt win32-x64 binaries that load
   unchanged under Electron (verified locally under electron-as-node), so
   release.yml now packages them with `--config.npmRebuild=false` and drops the
   choco + rebuild steps; ci.yml drops the Windows choco step and skips the
   rebuild on Windows only. macOS and Linux keep their from-source rebuild.

2. eSigner code signing broke once the VS install was removed. signtool found the
   certificate but rejected it with "no private key" (its /debug showed "After
   Private Key filter, 0 certs were left"), and nothing reached SSL.com's signing
   logs. The SSL.com eSigner CKA silent installer lays down RegisterKSP.exe,
   eSignerCSP.Config.exe and vc_redist.x86.exe but does not register the CNG key
   provider, and the 64-bit eSignerKSP needs the x64 VC++ runtime that the VS
   Build Tools install had been supplying incidentally. release.yml now runs
   SSL.com's canonical trio after the installer -- vc_redist.x64 (from aka.ms;
   the CKA bundles only x86), RegisterKSP.exe, eSignerCSP.Config.exe -- before
   config/load. Signing and signature verification are green. Note: eSigner's
   "Signing credentials not configured" line is benign noise -- it prints on
   successful runs too; the real signal is signtool's "After Private Key filter".
