# 2026-09-19 — WP1 (provider, identity, setup foundation): Gate 0

Work Package 1 of the 2.1.1 Codex-parity programme starts with a
pre-implementation checkpoint before any production code moves. Everything
Gate 0 produced is machine-checked evidence under `docs/wp1/` and `tests/wp1/`,
not narrative; the human-readable summary is `docs/wp1/gate0-report.md`.

Decisions recorded at Gate 0:

- **Base is the design's research snapshot.** Live `beta` was identical to
  `6bafcc33` at audit time (`docs/wp1/base-delta.md`), so no rebase-impact note
  was needed; the note is re-recorded if `beta` moves before the PR opens.
- **Claude account isolation is the profile home, not `CLAUDE_CONFIG_DIR`.**
  The base redirects `USERPROFILE` (Windows) / `HOME` (Linux) through
  `withProfileHome`, and an existing test asserts `CLAUDE_CONFIG_DIR` is absent.
  WP1 preserves that mechanism; the design's variable name is treated as a
  label. macOS has no Claude multi-account on the base and that stays so.
- **The legacy Codex surface is inventoried by predicate, not by touched
  file.** `scripts/wp1/legacy-codex-manifest.mjs` runs 14 fixed predicates over
  every tracked file; the ledger `tests/wp1/legacy-codex-ledger.json` carries
  one decided disposition per matched path and the gate test re-runs the
  predicates on every tree. The gate is strict in both directions (unmatched,
  predicate drift, predicate-set change, not-retired at the candidate, vacuous
  evidence, contradictions between a source entry and the tests it claims to
  adapt).
- **Characterization before replacement.** The full suite on the exact base is
  recorded with artifact digests (`docs/wp1/baseline-2026-09-19.md`, per-file
  inventory in `docs/wp1/baseline-test-inventory.json`), and the nine
  behaviours WP1 touches that had no behavioural test got one
  (`tests/wp1/*-characterization.test.ts`). Eight source mutants were run and
  went red before the tests were accepted.
- **Owner decisions are listed, not assumed.** Where the design and the base
  disagree (realm mechanism, macOS, launch environment policy, CI Linux matrix,
  coverage tooling, CLI version floor, real-CLI/packaged/keyring resources,
  tokenomics indexing of managed realms, deliberate test replacement), the
  report names the decision and no production change is made until it is
  answered.

Review: two independent Opus reviews (specification compliance; quality plus an
attacker pass on the gates), two fix rounds (the second one's fixes introduced
two gate-mechanism defects the attacker pass caught), each re-checked by the
same reviewers before the commit. The mutation runner is committed as
`scripts/wp1/mutants.mjs` so the red-under-mutant claim is reproducible.
