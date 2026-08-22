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

## Release gate (the cut is refused until it passes)

`scripts/release-gate.mjs` runs before any release is made — as the first step
of `scripts/release.js` (before `package.json` is touched) and as the first job
of `release.yml` on every dispatch (`gate`; every build job `needs` it). It has
no bypass. Two checks, both must pass:

1. **Milestone (#375).** A GitHub milestone titled exactly the version being cut
   (e.g. `2.1.0-beta.17`) must exist and have **no open issue** without the
   `excluded` label. Open issues are printed by number; pull requests on the
   milestone are ignored. A missing milestone **fails closed** — the gate cannot
   tell "nothing outstanding" from "nobody made the list". To clear it: close
   the issues, move them to a later milestone, or have the owner label them
   `excluded` (owner-excluded from the current milestone gate).
2. **Model registry (#385).** `resources/model-registry.json` must cover every
   model in Anthropic's [Claude Code model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)
   article. The expected set is hard-coded in
   `scripts/fixtures/claude-code-model-configuration.json` with its fetch date
   and refresh instructions; a dated article id (`claude-opus-4-5-20251101`) is
   covered by the undated registry entry (`claude-opus-4-5`). A missing model
   **fails** with a diff; a registry Claude model the article no longer lists is
   a **warning** (flagged for the owner, not fatal). That article is the
   reference whenever the model/effort options are set for a release: registry
   `dropdown` rows, aliases, `--model` values, 1M variants, effort levels.

Run it by hand at any time: `node scripts/release-gate.mjs [--version X]`
(exit 0 pass, 1 refused, 2 could not evaluate — also a refusal).

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
