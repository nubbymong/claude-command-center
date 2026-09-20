# WP1 owner disposition, 2026-09-20

Gate 0 (commit `49514d1e`) is accepted subject to one final targeted
confirmation of the three post-PASS guard changes, bound to that exact commit.
The WP1 design is approved for production implementation with the amendments
below. This record supplements `gate0-report.md`; it does not rewrite it.

| Decision | Disposition | Effect on the implementation |
| --- | --- | --- |
| D1 | Approved with correction | Claude realm isolation uses the existing `USERPROFILE` mechanism, plus `HOME` on Linux. `CLAUDE_CONFIG_DIR` is not an implementation mechanism. Modelled as a provider-neutral **realm environment patch** (`{ set, unset }` applied last) that each provider package produces for a bound realm. |
| D2 | Approved for WP1 only | The current macOS Claude multi-account limitation is preserved in WP1. Not a permanent architectural exclusion. Codex managed realms must work on macOS. |
| D3 | Amended | Setup, auth, status and logout subprocesses run under a strict allowlisted environment. Interactive PTYs inherit the developer environment for terminal-wrapper fidelity, then every ambient authentication variable able to override the selected CLI's bound realm is removed, then the validated realm environment is applied last. Each provider package declares its ambient authentication variables; poisoned-environment negative tests cover the removal. |
| D4 | Decided | A private planning-repo premise issue, linked from the eventual public PR. No public issue. The planning lead supplies the link. |
| D5 | Approved | `ubuntu-latest` joins the `test` job matrix. |
| D6 | Approved | `@vitest/coverage-v8` devDependency; the before figure is produced on `6bafcc33`. |
| D7 | Conditionally approved | `0.153.4` may be the minimum only if it passes the conformance, realm-isolation and real-binary evidence. `0.155.1` stays the pinned reference. The release-candidate version is tested separately. |
| D8 | Decided | Blocks merge, not implementation or opening a draft PR. |
| D9 | Approved | Evidence stays under `docs/wp1/` and `tests/wp1/`. |
| D10 | Option B, narrow | Tokenomics must discover sessions from active managed Codex realms and the external-default realm. No Tokenomics redesign beyond preventing that regression. The two tokenomics ledger rows move from `defer` to `replace` (narrow: sessions-directory discovery only). |
| D11 | Approved | Replacement coverage must exist and pass before a legacy test or fixture is deleted. The ledger gate's evidence-path check enforces existence at the candidate; the suite enforces passing. |
| D12 | Approved | The base-behaviour descriptions in the Gate 0 evidence may be published. |

## Implementation order under this disposition

1. Provider-core contracts, registry, package entry points, composition roots
   and dependency-boundary enforcement (main and renderer). Local commits on
   the existing branch; no push, no PR until reported.
2. Claude adapter (realm env patch = existing profile-home mechanism),
   migration, compatibility shadow; Codex adapter, managed realms, auth.
3. Neutral Accounts, Setup and Settings surfaces; onboarding provider
   selection.
4. Launch handoff, leases, lifecycle, journals, recovery; Tokenomics realm
   discovery (D10).
5. Documentation sweep, evidence records, matrix runs; draft PR.

Every commit: focused tests, typecheck, independent ADR-009 review of the
uncommitted diff, then commit with the review record and diff digest.
