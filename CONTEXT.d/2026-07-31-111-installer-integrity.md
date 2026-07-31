## 2026-07-31 -- Verify installer SHA-256 before launching it (#111)

The updater downloaded an installer and handed it to the OS to execute with NO
client-side integrity check on any platform. CHECKSUMS.txt was already generated and
attached to every release by the release workflow (`sha256sum *`) -- the client simply
never read it.

Why each OS backstop does not cover this:
- Windows .exe is not code-signed in this repo, and SmartScreen gates on Mark-of-the-Web,
  which a Node `https` download never sets.
- macOS .dmg is notarized but `dmg.sign: false`, and a programmatic download carries no
  quarantine xattr, so Gatekeeper is only partial.
- Linux .AppImage has no signing convention and no OS check at all.

Implementation:
- Verification lives INSIDE `downloadGitHubRelease`, not at the call site. That function is
  the only way an installer enters the app, so putting the check there means a returned
  path is a verified path and no future caller can forget.
- `digestForAsset(manifest, assetName)` is exported and pure so the parse half -- the half
  an attacker shapes input for -- is directly testable.
- `fetchChecksumManifest` mirrors the existing download cascade: derive the CHECKSUMS.txt
  URL from the installer's own asset URL (same release, same host), then fall back to
  `gh release download --pattern CHECKSUMS.txt`.
- Hashing is streamed. Installers are 100-200 MB and the main process must not buffer them.

FAILS CLOSED, deliberately and without exception. Manifest unfetchable, asset missing from
it, file unreadable, digest mismatch -- every path deletes the download and returns null.
There is no "could not verify, proceed anyway" branch: an attacker who can tamper with the
installer can usually also make the manifest fetch fail, so a soft check would be no check.

Parser refuses ambiguity as well as malformity. A manifest listing the same asset twice
with DIFFERENT digests returns null rather than picking first- or last-match, since
injecting a second line is the cheapest attack on a lenient parser. An exact duplicate line
is accepted. Filename matching is exact after stripping any path prefix, so
`evil-<asset>` and `<asset>.bak` do not match.

THREAT MODEL, recorded so nobody over-trusts this. Same-origin checksums defend against
corruption, truncation, a tampered CDN edge, and partial compromise. They do NOT defend
against an attacker holding GitHub release-write credentials -- that attacker rewrites
CHECKSUMS.txt to match their payload. Closing that requires SIGNING the manifest
(ed25519/minisign in CI, public key pinned in the app, signature checked before the digests
are trusted). This change is a floor, not a ceiling; the signing follow-up is worth its own
ticket.

Not implemented from the issue's suggestion list: comparing byte count against the asset
`size` from the releases API. The SHA-256 subsumes it -- any length change alters the
digest -- and plumbing `size` through `ReleaseInfo` would have widened the diff for no
security gain.

Tests: tests/unit/main/github-update-integrity.test.ts, 21 cases, weighted toward the
fail-closed paths (asset absent, malformed digest, HTML error page served instead of the
manifest, duplicate-with-different-digest, prefix/suffix filename near-misses).

ADVERSARIAL ROUND 1 (blast-radius lens) found a BLOCKER I caused and several real gaps:

- BLOCKER: the change broke 5 PRE-EXISTING tests in tests/unit/github-update.test.ts. I had
  claimed "typecheck clean" having run only my new test file. Exactly the failure this
  repo already learned once on #151 -- a claim about the suite made without running the
  suite. Fixed by splitting transport from policy: downloadInstallerFile() is the
  unverified transport half (redirects, gh fallback, stale-path handling -- what those 5
  tests always actually tested), and downloadGitHubRelease() wraps it with verification.
  Better design than the mock-fabrication alternative, and the old tests keep their intent.
- MAJOR: an integrity failure surfaced to the user as "Installer not found. Check your
  internet connection" -- wrong cause, and on a genuine tamper event, no signal at all.
  Now throws a typed InstallerIntegrityError carrying the asset and release, rethrown by
  update-handlers. BottomBar had no .catch at all on installAndRestart (unhandled
  rejection); added, wrapped in Promise.resolve because the test mock returns undefined.
- MAJOR (release-side): a rolling re-release onto an existing tag can regenerate
  CHECKSUMS.txt without a platform whose build flaked (build-linux is continue-on-error)
  while the OLD asset stays attached -- offering an update that can never verify. Partially
  addressed: scripts/release.js promoted from warn to FAIL when CHECKSUMS.txt is missing,
  since the client now hard-requires it. The post-upload asset-vs-manifest gate in the
  workflow is a follow-up.
- Manifest is now fetched BEFORE the installer. Discovering "no usable manifest" after
  pulling 150-200 MB wastes bandwidth and delays the failure by minutes.
- Manifest read capped at 1 MiB (synchronous read in the main process).
- On verification failure, if unlink fails (Windows lock) the file is renamed .INVALID --
  leaving an unverified installer in ~/Downloads under its expected name is how a user
  ends up double-clicking it.
- Threat-model claim corrected: the manifest comes from the SAME host and release, so this
  does NOT cover a tampered CDN edge. It covers corruption, truncation, interrupted or
  resumed downloads, and a partial compromise replacing only the installer asset.

Full suite 3225 passed after the fixes; typecheck clean; release.js syntax-checked.
