## 2026-09-05 -- aicc_planning#43: SSO sign-in browser picker hidden by per-user browser installs

**Report.** On 2.1.0-rc.14 an SSO account's authentication panel no longer offered
the Edge / Chrome "Sign-in browser" choice on a managed workstation that has both
browsers installed. Not a rc.13 -> rc.14 regression: the reporter noticed it in
rc.14, but the path list involved is as old as the picker (#439).

**Mechanism.** `getBrowserPaths()` (`src/main/browser-paths.ts`) listed only the
Program Files locations on Windows. The reporter's Chrome is a per-user install
(`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, the no-admin default on a
managed box), so `resolveBrowserBinary('chrome')` found nothing and fell back to
Edge; `detectAuthBrowsers()` keeps only browsers that resolve to THEMSELVES, so it
reported `['edge']`; the picker renders only when `detectedBrowsers.length > 1`,
so it hid itself by design and Edge could not be chosen.

**Fix.** `getBrowserPaths()` gains an `env` parameter (default `process.env`) and,
on win32, appends the per-user location for each browser
(`%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`,
`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`) AFTER the system-wide
candidates, so an existing system install keeps winning. No entry is added when the
variable is unset. The same list feeds the vision browser, so a per-user Chrome now
drives vision as well.

**Tests.** `tests/unit/vision-browser-paths.test.ts` pins the historical Windows
lists via an empty env and the new per-user entries via a fake env;
`tests/unit/account-web-detect-browsers.test.ts` drives the real
`detectAuthBrowsers()` / `resolveBrowserBinary()` over the real path list with a
fake filesystem shaped like the reporter's machine, and includes the pre-fix list
as a regression case that FAILS to see Chrome (proves the check can fail).

**Deliberately not changed.** The `> 1` gate on the picker. With one browser
genuinely installed the launcher's not-silent fallback already says what ran; the
design follow-up SSBN raised (surface which browser will be used, and why the
picker is hidden) is a separate ticket, not an rc fix. The Windows `App Paths`
registry lookup for non-standard install roots is also left out: `browser-paths`
is deliberately pure and dependency-free, and no report needs it yet.
