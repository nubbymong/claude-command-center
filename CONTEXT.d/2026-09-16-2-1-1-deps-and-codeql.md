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

Zero exploitable. Two fixed in code rather than dismissed:

- #13 `src/main/account-web/sign-in.ts` `isCloudflareChallenge`: hardened (the
  notice-only detector now decides from the parsed page address, https-only;
  `isClaudeUrl` was and is the gate on every privileged step). The assessment
  and the pinned cases are in `tests/unit/account-web-cloudflare.test.ts`; the
  written analysis is deferred to the post-release record per SECURITY.md
  ("Embargo"), even though the pass rated it non-exploitable.
- #15 `tests/unit/main/splash-build-info.test.ts`: the inline-script oracle
  `/<script>/` missed `<SCRIPT>`, `type="module"` and `defer`; CodeQL's textbook
  `/<script\b/i` would also reject the page's legitimate `src=` tags and its
  inert `text/x-logo-src` block, so the oracle excludes those two forms
  explicitly. Harmless either way: the CSP assertions beside it are the guard.

Dismissed on the repo, each comment citing the repro that failed:

- #18 / #19 splash `innerHTML` from SVG path data: the data is captured from
  the bundled inert `logoSrc` block by `/<path d="([^"]+)"/`, so it can never
  contain a quote and cannot close the attribute (an `onload` payload truncated
  at the first quote); raw markup injected past the regex executed nothing in
  Chromium under the page's CSP (`script-src 'self'`, no unsafe-inline); the
  window is sandboxed, isolated, preload-free, `connect-src 'none'`.
- #11 / #12 clear-text logging in two manual dev scripts: the logged values are
  presence literals, ids, paths and case labels; the credential value is
  discarded at a ternary and the host password field is never read. Neither
  script runs in CI.
- #14 / #17 test oracle and fixture construction, not sanitizers.
- #16 a test helper fed only two literal filenames with no other metacharacter.

The Dependabot alerts (#174-#177, #187, #189) close on their own once the
lockfile reaches `main`; the Dependabot PRs #592-#596 and #613 are closed in
favour of this branch.
