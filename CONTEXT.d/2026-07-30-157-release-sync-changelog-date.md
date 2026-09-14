## 2026-07-30 -- release.js now syncs the changelog entry DATE, not just the version (#157)

Changelog entries are hand-authored BEFORE a release (release.js rewrites the first
entry's version to whatever it bumps to). It did NOT touch `date`, so an entry
written days earlier shipped with the authoring date. `beta` is never frozen, so a
pending entry sitting for a week was normal -- and nothing caught it, because
`gen-changelog.js --check` only compares the generated file to the source: a
wrong-but-consistent date is green.

Found while adding the 2.1.0-beta.3 entry (#149), which is dated 2026-07-30 purely
because that is when it was written.

- `syncChangelogEntry(source, version, date)` -- new PURE helper in scripts/release.js
  (exported for tests, alongside the existing parseVersion/nextVersion/tagFor). Rewrites
  the FIRST entry's version AND date, reporting `versionChanged` / `dateChanged`
  separately. This also puts the previously-INLINE, UNTESTED version rewrite under test
  -- it had already corrupted an old entry once (a loose regex without the prerelease
  suffix skipped `2.0.0-rc.2` at the top and rewrote the first BARE version it found).
- Both regexes REQUIRE quotes, which is what keeps them off the `ChangelogEntry`
  interface at the top of the file (`version: string`, `date: string` -- unquoted).
- `todayIso(now = new Date())` -- LOCAL calendar parts, deliberately NOT
  `toISOString().slice(0,10)`. That is UTC, so in Denver (UTC-6/-7) any release after
  ~17:00 local would stamp TOMORROW's date, silently, in a user-visible file. Injectable
  `now` so the timezone behaviour is testable without faking the clock.
- ALSO FIXED as a side effect: release.js never regenerated CHANGELOG.md after rewriting
  changelog.ts, and step 5 does `git add -A` + commit. So any release where the version
  rewrite actually changed something would commit a stale generated file and fail its own
  `Changelog in sync` CI gate. Step 3 now runs gen-changelog.js after a successful sync.
  (Latent until now only because the authored version usually already matched.)
- Header docs updated: both fields in a pending entry are placeholders now.
- Verification: typecheck clean; full suite 3173 passed / 4 skipped; 10 new tests in
  tests/unit/scripts/release.test.ts (both-fields rewrite, older entry untouched,
  interface untouched, date-syncs-when-version-already-matches = the #157 case, no-op
  when both match, bare stable version, missing version, missing date field, and the
  UTC-vs-local guard). Also dry-run against the REAL changelog.ts: 72 date fields before
  and after, so exactly one replaced in place, all 71 older entries intact.
