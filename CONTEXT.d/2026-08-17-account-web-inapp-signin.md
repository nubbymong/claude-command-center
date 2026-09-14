## 2026-08-17 -- claude.ai web sign-in moved in-app (no debug port)

The per-account claude.ai web sign-in (#216) looped on Cloudflare's "verify you
are human" check indefinitely and could not complete. A controlled A/B on the
target machine isolated the cause precisely:

- plain Chrome, fresh profile, **with** `--remote-debugging-port` (nothing even
  attached) -> challenge loops forever;
- the **same** Chrome **without** that port -> signs in cleanly;
- claude.ai loaded in an **Electron** window (no port) with a normal Chrome
  user-agent -> signs in cleanly.

So claude.ai's bot-detection flags the remote-debugging port itself, which the
`system-browser` sign-in path opens to read the session cookie back over CDP.
The earlier fixes (#269/#276 stopped scripting the page every poll, #282 survived
a transient cookie read) reduced the aggravation but could not remove the port,
which is the actual signal.

**Fix:** for non-SSO accounts, sign in DIRECTLY inside an Electron window bound to
the account's partition -- no launched browser, no debug port. The session cookie
then lands in Electron's own store for that partition (the same store the
artifacts window already reads), so there is nothing to harvest or inject and no
automation signal to catch. One partition per account keeps the isolation model.

- New `in-app-sign-in.ts`: the window flow. Sandboxed, context-isolated, no
  preload/node, permissions denied. Auth-flow nav policy (https top-level allowed
  for IdP hops; non-https blocked; popups denied). Presents a plain Chrome UA
  (Electron token + app-name token stripped). Identity read runs page script only
  after the session cookie exists and only when the frame's own origin is
  claude.ai -- the same origin gate the CDP path used. Window destroyed the instant
  sign-in completes or is cancelled, so a session-bearing window never lingers. A
  post-read recheck refuses to report done if a sign-out cleared the partition
  mid-read.
- `sign-in.ts` routes by auth method: `sso` keeps the `system-browser` + CDP path
  (its identity provider may need a policy-installed browser extension an Electron
  window lacks); everything else goes in-app. The in-app path leaves no on-disk
  browser profile, so the profile-lock/orphan machinery does not apply to it.
- `cookie-harvest.ts` gains a pure `webSessionFromElectronCookies` (sessionKey
  present + its expiry), mirroring the CDP harvest's success rule.
- New `in-app` value on `WebSessionOrigin`. Renderer copy no longer claims the
  user's own browser opens for every account.

As a side effect this removes an attack surface the `system-browser` path's own
comments flag: the loopback debug port that "anything that can reach it can read
the cookies". Every new guard is mutation-proven; full suite green, typecheck +
byte-scan clean. Security-sensitive (credential/account code) -> ran the ADR-009
adversarial pass before merge.
