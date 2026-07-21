## 2026-07-20 -- Issue lifecycle: `in-beta` label for beta-merged-but-unshipped

Adopted a three-state issue lifecycle to distinguish "merged to beta / in testing"
from "shipped in main", instead of closing issues the moment a fix hits `beta`.

- Why: GitHub only auto-closes issues on merges to the DEFAULT branch (`main`),
  never on `beta`. Under the RC-branch model, fixes live on `beta` (in testing)
  well before a stable `main` release. Closing on beta-merge hides "shipped"
  behind "merged, still baking".
- States: open/no-label = todo; open + `in-beta` = fix merged to beta, in testing;
  closed = promoted to `main` (shipped).
- Label `in-beta` created (amber). Applied to the currently beta-merged-but-open
  issues: #117, #119, #120, and #130 (which had been prematurely closed on
  beta-merge; reopened + labeled).
- Documented in CONTRIBUTING.md ("Issue lifecycle (beta vs. main)") and AGENTS.md
  (one-line pointer so agents apply it). Partially addresses the governance
  codification ask (#116).
- Close-on-promotion is MANUAL for now; automating it (a GitHub Action that closes
  `in-beta` issues covered by a main promotion) is tracked in #134.
