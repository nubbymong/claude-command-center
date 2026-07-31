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

ADVERSARIAL ROUND 2 (fresh attacker, bypass + patch-regression lens) -- 3 MAJOR:

- MAJOR, and the worst thing in this ticket: my parser regex
  /^([0-9a-f]{64})\s+\*?(.+)$/i REINTRODUCED THE EXACT ReDoS CLASS #151 FIXED, four
  commits later, in a different file. Same \s+ followed by .+ followed by an outer
  trim(). Measured: 1666 ms at 64k spaces, 27 s at 256k; with the 1 MiB manifest cap the
  ceiling was ~7 MINUTES of a fully blocked Electron main process, since the parse is
  synchronous and in main. Worse than #151, which was capped by llhttp and
  http.maxHeaderSize -- this had no limiter and needs only CHECKSUMS.txt bytes, strictly
  less access than the release-write compromise the threat model already concedes.
  Replaced with an index-based splitChecksumLine (search /\s/ once, require index 64,
  walk the separator run) plus SP/HTAB-only separators, the same narrowing #151 applied.
  Guard: tests/unit/main/github-update-redos.test.ts. Verified by reverting to the regex --
  the run does not fail an assertion, it HANGS (10 min, killed). Inherent: a synchronous
  quadratic regex blocks the event loop so vitest cannot preempt it. Documented in the
  test header so a future CI stall in that file is read correctly.
- MAJOR: the round-1 "fix" for invisible failure was INERT. Rethrowing the typed error
  achieved nothing because every renderer path discards it (console.error or a bare state
  reset) and there is no toast component -- the user saw the overlay vanish and nothing
  else, exactly what round 1 claimed to fix. Worse, the BottomBar line I edited is dead
  code: App.tsx always supplies onUpdateRequested, so that else branch never runs. Now
  dialog.showErrorBox in the main process, the one channel nothing downstream can swallow.
- MAJOR: TOCTOU with real teeth. The file is hashed, then killAllPty() runs (tens of ms to
  seconds with sessions open), then spawn. Path is predictable from the public release feed,
  ~/Downloads is a directory every browser writes into, and nsis is oneClick:false +
  allowElevation:true -- so a NON-elevated local process that wins the race gains admin on
  a UAC prompt the user is already expecting. downloadGitHubRelease now returns
  { path, sha256 } and the handler re-hashes via stillMatchesDigest() immediately before
  the point of no return. ~1 s for 150 MB, window down to microseconds. Moving the download
  out of ~/Downloads entirely is the better fix and is a follow-up.

MINORs also fixed: manifest URL now derived with the URL API and origin-pinned (the string
replace produced host `checksums.txt` for a path-less URL, and for a URL with a fragment it
rewrote inside the fragment so https.get FETCHED THE INSTALLER as the manifest -- violating
the "no installer bytes when unverifiable" guarantee); truncate-before-unlink so a rejected
installer is inert even if unlink and rename both fail; release.js now requires the exact
name CHECKSUMS.txt (the old substring predicate greenlit checksums.txt and
CHECKSUMS.txt.sig, both of which the client refuses); corrected a now-false comment in
release.yml claiming the updater does not verify.

Still open, deliberately deferred to follow-ups: signing the manifest (the real ceiling),
the post-upload asset-vs-manifest gate in the release workflow, moving downloads out of
~/Downloads, and a size cap on httpsDownload so the 1 MiB manifest limit is enforced before
bytes reach disk rather than after.

Full suite 3233 passed. Typecheck clean.
