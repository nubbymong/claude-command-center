# 2026-08-24 — `in-release` issue state (rc lifecycle governance)

Pre-rc.1 governance (owner: nothing sat between `in-beta` and closed): a fix
rolled into a cut release candidate is now **open + `in-release`**, replacing
`in-beta` — one lifecycle label at a time. ADR-019 holds the reasoning.

What changed:

- `scripts/roll-issues-into-release.mjs` (new): swaps `in-beta` → `in-release`
  on the rc milestone's open issues, with an audit comment. Dependency-free
  ESM; labels/plumbing imported from `release-gate.mjs`. `--dry-run` previews.
- `release.yml`: new final `roll-rc` job — runs the script automatically after
  every successful `-rc.N` publish (job-level `issues: write`; loud on failure,
  blocks nothing). Gate comment updated.
- `scripts/release-gate.mjs`: `in-release` exempted like `in-beta` (shipped,
  not outstanding).
- `scripts/close-in-beta-issues.js`: close-on-promotion accepts either
  lifecycle label, removes what is carried, and words the comment by state.
- Docs: CONTRIBUTING "Issue lifecycle" (four states), AGENTS.md lifecycle
  bullet + release-line invariant, `docs/loop-autonomy.md` state diagram,
  LoopReady scope filter (`in-release` also means "already merged").
- Tests: the two existing script suites extended + a new
  `roll-issues-into-release.test.ts` (fail-safe classify, label swap, plan).

Also confirmed while here: `release.yml` has **no rc channel input** — options
are stable/beta/dev. An rc is a version-suffix cut (`2.1.0-rc.1` in
package.json) dispatched with `-f channel=beta`; the rc suffix rides the beta
update channel and outranks beta (docs/versioning.md).
