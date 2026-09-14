## 2026-08-03 -- Forced-login countdown, proactive refresh, and duplicate-account detection (#203, #202)

The accounts view only offered a Sign in button once an account was already broken, and said
nothing about how long a working sign-in had left. Both gaps were fixable from data already
on disk.

`.credentials.json` carries TWO expiries and conflating them produces a wrong, alarming UI:

- `expiresAt` is the ACCESS token. Measured across eight real profiles: 0.5 to 7.8 HOURS.
  Renewed automatically; the user never needs to know. Presenting this as "your sign-in
  expires in 30 minutes" would be false.
- `refreshTokenExpiresAt` is the REFRESH token. Measured: 1.0 to 27.4 DAYS. THIS is what
  forces an interactive login, and it is the only one that belongs in a countdown.

At the time of writing, three PROD accounts were inside 48 hours (1.0d, 1.6d, 2.0d) with
nothing in the UI saying so.

Landed:

- `src/shared/account-auth.ts` -- `ProfileAuthInfo` plus a PURE `describeAuthWindow(info,
  now)`. `now` is injected so the thresholds are tested against fixed clocks instead of the
  wall clock, and it is shared so main and renderer cannot disagree about what a credential
  state means. Tones: expired/critical (<2d) red, warning (<7d) amber, else neutral. Under a
  day it switches to hours rather than saying "0 days". An older credential file with no
  `refreshTokenExpiresAt` reports "renewal date unknown" -- a fabricated countdown is worse
  than none.
- `src/main/account-auth-info.ts` -- reads `<home>/.claude/.credentials.json` and
  `<home>/.claude.json` per profile. Pure file reads, no network, no `claude` spawn, so it is
  cheap enough to call on panel open. New `accountProfiles:authInfo` IPC.
- Accounts view: "Refresh sign-in" on HEALTHY accounts too (the whole point is acting before
  the forced login), the countdown per card, and the identity warnings below.

The load-bearing detail, found while wiring it: **`refreshIdentity` OVERWRITES
profiles.json's `accountEmail` with whatever the profile's home reports**
(`account-profiles-handlers.ts:58-61`). So when someone signs a profile in as the wrong
account, the app silently RELABELS the profile and the label-vs-home divergence disappears --
while the duplication remains and keeps invalidating tokens. A divergence-only check would go
quiet exactly when the damage is done.

So the cross-check is two independent things:

- `identityMismatch` -- profiles.json disagrees with the home. Catches the state observed in
  dev before any relabel.
- `duplicateOfProfileIds` -- another profile's home resolves to the SAME account, matched on
  the HOME's identity rather than the label. This is the one that hurts: three homes on one
  account means each refresh rotates the OAuth refresh token and invalidates the other two,
  which is exactly the `OAuth session expired and could not be refreshed` failure chased in
  #191. Both are tested, including the post-relabel case a naive check would miss.

The duplicate warning states the causal chain in the UI rather than just flagging it, because
"these are the same account" is not obviously a problem until you know that refreshing one
breaks the others.

Gate: 3479 unit tests pass (18 new), typecheck clean. Not yet verified in the running app.
Still open: #201 (Insights pre-flight, which reuses this reader as its layer 1) and the
re-auth identity verification half of #202.
