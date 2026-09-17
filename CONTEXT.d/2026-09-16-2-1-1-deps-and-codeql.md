## 2026-09-16 -- 2.1.1 prep: dependency refresh and the nine CodeQL alerts

Branch `build/2.1.1-prep`, stacked on `refactor/pty-manager-simplify` (#615).
It first merges `main`'s 2.1.0 version bump back into the line: `beta` had no
commit that 2.1.0 lacked (main contains all of beta), only the version line
differed. So 2.1.1 = 2.1.0 + #615 + this.

### Dependencies

| package | from | to | why |
| --- | --- | --- | --- |
| electron | 43.4.0 | 43.7.1 | latest 43; 44 stays deferred to 2.2 (#594: clipboard API break, rebuild ABI gap) |
| vitest, @vitest/mocker | 4.1.10 | 4.1.11 | Dependabot #187 / #177 (medium, dev); #613's 5.0.0 is a test-semantics migration, refused |
| hono (via the MCP SDK) | 4.13.1 | 4.13.8 | Dependabot #174-#176 (medium, runtime); patched from 4.13.5 |
| js-yaml (dev, via commitlint and electron-builder) | 4.3.1 | 4.3.2 | Dependabot #189 (high, dev) |
| node-pty | 1.2.0-beta.14 | 1.2.0-beta.15 | #595 |
| zod | 4.4.3 | 4.5.4 | #596 |
| marked | 18.0.5 | 18.0.11 | #593 |
| @types/better-sqlite3 | 7.6.13 | 9.6.0 | #592; typecheck clean, the runtime stays 13.0.3 |

Local note: `electron-rebuild` cannot build node-pty on the owner's desktop
(Visual Studio 18 lacks the Spectre-mitigated libraries, a known trap); the unit
suite mocks the natives and CI builds the installers, as for every prior
release.

### CodeQL: nine open alerts, adversarial pass (two Opus attackers, Fable orchestrating)

Zero exploitable. Seven dismissed on the repo (false positives and test oracles;
each dismissal comment cites the repro that failed) and two addressed in code: a
hardening in `src/main/account-web/sign-in.ts` and a stronger test oracle in
`tests/unit/main/splash-build-info.test.ts`. Per SECURITY.md ("Embargo") the
written assessment is published with the release record, not before, even
though the pass rated the pre-change code non-exploitable; the regression tests
carry the cases, as the policy allows.

The Dependabot alerts (#174-#177, #187, #189) close on their own once the
lockfile reaches `main`; the Dependabot PRs #592-#596 and #613 are closed in
favour of this branch.
