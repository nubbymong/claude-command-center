## 2026-07-22 -- Added docs/versioning.md

Prompted by a beta Mac rebuild: re-dispatching the release workflow at the SAME
package.json version (2.1.0-beta.1) is a rolling re-release (assets replaced in
place), and the in-app updater does NOT notify existing users because it ranks by
semver, not date — same version = same rank = "not newer". That behavior wasn't
written down anywhere.

- New `docs/versioning.md` documents: the SemVer scheme + `-beta.N`/`-rc.N`
  suffixes; package.json as the single source of the version/tag; release channels
  (stable/beta/dev) vs. updater channels (stable = finals only; beta = finals +
  beta + rc; `-dev` not served by the updater); semver ordering (final > rc.N >
  beta.N); rolling re-release vs. version bump; and the end-to-end release flow.
- Grounded in the actual logic: `github-update.ts` (classifyTag/parseTag),
  `release.yml` (tag derivation, --clobber rolling re-release, --target), and
  `release.js` (changelog version sync).
- Linked from CONTRIBUTING.md (release process) and AGENTS.md (Deeper references).
- Merge-order note (resolved): this branched off beta (11bb42d) before #135 landed
  its "Issue lifecycle" section in the same part of CONTRIBUTING.md, which produced
  a conflict. Rebased onto beta and reconciled by keeping BOTH — the versioning
  pointer sits with the release-process bullets, followed by the Issue lifecycle
  section.
- Follow-up surfaced while releasing 2.1.0-beta.2: the `release/**` ruleset
  (verified signatures + no merge commits) makes a `release/vX.Y.Z` branch cut from
  `beta` un-pushable, because beta's history already contains a merge commit
  (efbc34e, PR #72). The documented RC-branch step therefore cannot be followed
  as written; the beta.2 bump used a `chore/` branch instead.
