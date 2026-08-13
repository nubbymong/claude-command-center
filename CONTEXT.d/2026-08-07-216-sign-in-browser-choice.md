## 2026-08-07 -- 216: the claude.ai sign-in browser is a per-account choice

First live exercise of #216's sign-in on the target managed workstation. It failed,
and the reason invalidated an assumption the feature was built on, so the fix is a
new per-account setting rather than a patch to the launcher.

### What was assumed, and what was measured

The design note in `browser-launch.ts` claimed that because Chrome's
`ExtensionInstallForcelist` lives under HKCU, force-installed extensions "install
into ANY profile -- including the fresh one this module creates", and that this was
what made a dedicated profile viable. The policy claim is true. The timing is not.

Measured on the box, 2026-08-06:

- Chrome's HKCU forcelist holds exactly two extensions: `Microsoft Single Sign On`
  (`ppnbnpeolgkicgegkbkbjmhlideopiji`) and a password manager. There is no
  compliance or DLP proxy extension, which is what the original note guessed at.
- A force-installed extension is fetched ASYNCHRONOUSLY after Chrome starts. The
  sign-in creates a fresh `--user-data-dir` by design, so claude.ai loads before
  the SSO extension exists and the SSO step fails. Two launch attempts, no harvest.
- Edge's forced list does NOT include an SSO extension, because Edge does Entra
  SSO natively. A fresh Edge profile, launched with the identical argv, completed
  the same login by hand.

So the browsers are not interchangeable for SSO, and which one an account needs
depends on its organisation. Pre-seeding Chrome's fresh profile was considered and
rejected on evidence: the `extensions_crx_cache` in the real user-data-dir does not
contain the SSO extension's CRX, and hand-copying `Default\Extensions` plus its
prefs fails Chrome's Secure Preferences MAC, which lands the extension disabled.

### What changed

- `AuthBrowser`, its labels and `DEFAULT_AUTH_BROWSER` ('edge') now live in
  `src/shared/account-web-session.ts` so the renderer's picker and the launcher
  share one definition; `browser-launch.ts` re-exports the type.
- The choice is persisted per account (`session-store.ts`, schemaVersion 3,
  `authBrowsers`), read at the IPC seam, and passed into `runSignIn`. A new
  `accountWeb:setAuthBrowser` channel validates it against the two known values,
  because the string selects an executable to spawn.
- A FALLBACK IS NEVER SILENT. If the chosen browser is absent the other one is
  still used -- a machine may only have one -- but the resulting `SignInState`
  carries `browser` and a `notice`, and the panel shows it. Substituting quietly
  would turn the setting into an unexplained failure at the identity provider.
- Fixed a regression found on the way in: `removeWebSession` wrote back only
  `sessions`, so signing an account out of claude.ai silently discarded its CLI
  sign-in flow (and would have discarded its browser choice).
- Fixed a red-but-passing suite: `accounts-panel.test.tsx` renders
  `AccountWebSession` but its `window.electronAPI` mock had no `accountWeb`, so
  `status()` rejected on undefined. Twelve unhandled rejections and a non-zero exit
  with every assertion passing -- it would have blocked CI on this branch.

### State

17 new unit tests; full unit suite 3871 passed, exit 0, no unhandled errors.
Typecheck and build clean. Committed on `feat/216-account-web-session`, unpushed.

Verified by hand: Edge completes the SSO login in a fresh profile. NOT yet
exercised: the picker itself, the harvest through Edge end to end, and T10
(two-account isolation). ADR-009 adversarial pass on the new IPC surface is still
owed before a merge is recommended.
