# Versioning & release channels

How AI Code Conductor versions builds, what the prerelease suffixes and
channels mean, and — importantly — when a rebuild ships to users versus when you
must bump the version. This documents the behavior encoded in
`.github/workflows/release.yml`, `scripts/release.js`, and the in-app updater
`src/main/github-update.ts`.

## Scheme

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, with
dot-numbered prerelease suffixes:

- `-beta.N` — in testing on the `beta` line (e.g. `2.1.0-beta.2`)
- `-rc.N` — release candidate, stabilizing toward stable (e.g. `2.0.0-rc.2`)
- no suffix — final stable release (e.g. `2.0.0`)

## Single source of truth

`package.json` `version` is authoritative:

- The release workflow derives the git tag `v<version>` from it.
- `scripts/release.js` syncs the top `version:` line in
  `src/renderer/changelog.ts` (the in-app "What's New" + generated `CHANGELOG.md`).
- Tag rule (`release.yml`): if `package.json` already carries a prerelease suffix,
  the tag is `v<version>` verbatim; a bare version gets the channel suffix appended.

## Channels

**Release side** — `gh workflow run release.yml -f channel=<...>`:

| channel  | meaning                          | GitHub release |
| -------- | -------------------------------- | -------------- |
| `stable` | final release                    | Latest         |
| `beta`   | pre-release on the beta line     | Pre-release    |
| `dev`    | experimental pre-release         | Pre-release    |

**Client side** — the in-app updater (`github-update.ts`) serves two channels:

- `stable` — final releases only (`vX.Y.Z`).
- `beta` — final **plus** `-beta.N` and `-rc.N` prereleases.
- `-dev` tags are **not** served by the updater — manual download only.

## Ordering: which build is "newer"

The updater ranks by **semver, not by date**:

- final > `rc.N` > `beta.N`; within the same base version a higher `.N` wins.
- A `beta`-channel user is therefore offered the `rc` and final of a line as they
  publish; a `stable` user only ever sees finals.

## Rolling re-release vs. a new version (read this)

Re-running the release workflow with the **same** `package.json` version does
**not** create a new version. `release.yml` detects the existing `v<version>`
release and **replaces its assets in place** (`gh release upload --clobber`),
leaving the hand-written notes untouched — a *rolling re-release*.

- **Use it** to refresh a build for **manual download** (e.g. fold in a
  just-merged fix without a version churn).
- **The auto-updater will NOT notify existing users** — same version = same
  semver rank = "not newer".
- **To push an update users actually receive, bump the version first.**

## When to bump

- Each new beta you want the updater to **deliver**: bump the prerelease number
  (`2.1.0-beta.1` → `2.1.0-beta.2`).
- Stabilizing a release: move to `-rc.N` on a `release/vX.Y.Z` branch.
- Shipping stable: drop the suffix (`2.1.0`) and release from `main` with
  `channel=stable`.

## End-to-end flow

1. Bump `package.json` `version` and add the matching `src/renderer/changelog.ts`
   entry.
2. `npm run changelog` to refresh `CHANGELOG.md`; commit both (CI gate:
   `Changelog in sync`).
3. Release — `scripts/release.js` (local bump + dispatch) or
   `gh workflow run release.yml --ref <branch> -f channel=<...>`.
4. `release.yml` tags `v<version>` at the exact built commit (`--target`, so the
   updater orders it correctly), builds Windows + macOS + Linux, and publishes the
   GitHub release with notes generated from `changelog.ts`.
5. The updater compares the published tag against the installed version for the
   user's channel and offers it only if it outranks what's installed.

See also: `CONTRIBUTING.md` (release process, issue lifecycle, changelog) and the
ADRs under `architecture/decisions/`.
