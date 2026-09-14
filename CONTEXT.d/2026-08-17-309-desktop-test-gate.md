## 2026-08-17 -- Desktop-test merge gate moved to a required label check (#309)

The "a human must open the app on a real desktop before this ships" rule had no teeth: it
lived in a reviewer's head and a PR-body note. Headless CI has gone green while the packaged
app failed to run usefully on a real desktop (the Conductor Proxy MVP: vision crash-loop +
main-loop stalls), so green CI is not proof the app works.

Converted it to a GitHub gate, mirroring the `ci-run` pattern but inverted:

- `ci-run` is OPT-IN -- present => run the Win/macOS matrix.
- `desktop-tested` / `skip-desktop-test` are REQUIRED-TO-ALLOW -- the new `Desktop test gate`
  job FAILS unless the PR carries one of them, so absence blocks merge.

Implementation is a single job in `.github/workflows/ci.yml`. Two design points that are load
-bearing:

- The job ALWAYS runs (guarded only on `event_name == 'pull_request'`, decides pass/fail from
  the labels internally). A required check that is *skipped* is treated as pending and blocks
  forever -- so an `if:` that skips the job when the label is present would deadlock the merge
  once branch protection requires it. Decide inside, never skip.
- `on.pull_request.types` gained `unlabeled` next to `labeled`, so removing `desktop-tested`
  re-runs the check and turns it red again instead of leaving a stale green.

Scope: ALL PRs into beta/main/release; docs/deps/CI/changelog-only PRs clear it with
`skip-desktop-test` (chosen over a path-filter that auto-passes "non-runtime" PRs, to avoid a
"what counts as runtime" maintenance surface).

The check is advisory until @nubbymong marks `Desktop test gate` a **required status check** in
branch protection for beta (and main) -- that is the admin-only step that turns the red X into
an actual merge block, and the one piece of #309 an agent cannot do.

Docs: CONTRIBUTING.md gains a "Desktop-test gate" subsection next to the ci-run / in-beta /
release-line label docs.
