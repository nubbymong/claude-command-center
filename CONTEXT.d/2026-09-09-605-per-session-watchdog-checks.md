## 2026-09-09 -- #605: the watchdog's three checks become switchable, globally and per session

The Session Watchdog was all-or-nothing and global. `startWatchdog` gated only on
`settings.watchdog.enabled`, so a user driving one session by hand had to turn the
watchdog off everywhere to stop it typing. Underneath, it already had three
independent auto-type paths -- usage/rate-limit resume (`tickWaiting`), API
overload (`tickOverload`) and safeguard (`tickSafeguard`) -- but only two of them
had an `enabled` flag, neither was reachable from Settings, and both gated only
detection ENTRY, so a session already in that status kept sending.

### The model

- **Global (Settings)** decides what a NEWLY LAUNCHED session starts with. The
  master switch is unchanged; the three checks are now listed under it.
- **Per session (right-click)** overrides them for THAT RUN, in real time.
  Runtime only -- nothing is persisted, so relaunching returns the session to
  the global defaults. This is what the owner asked for: "just within that
  session only, leave the global one in settings to handle if it comes back."
- **The silence/sleep indicator is never gated.** It lives in `WatchdogManager`
  (`evaluateSilence`), is status-only and never sends, so a muted session still
  reports that it has gone quiet. That separation was already in the code and is
  what made the split cheap.

### Implementation notes

- `SessionWatchdog` carries a live `checks` triple seeded from the resolved
  config, with `setChecks()` to change it. Each check gates BOTH its detection
  and its send. `rateLimitEnabled` is new in `WatchdogConfig` (the other two
  already existed) and is threaded from settings like the rest.
- Turning a check off mid-incident drops the session to `monitoring`: nothing is
  typed and the pending wait is dropped. The incident's spend is PARKED rather
  than discarded (`parkedBudget`), so turning the check back on while the same
  condition is still on screen resumes THAT incident with its budget already
  used up -- an off/on pair buys no extra retries, and because every give-up is
  derived from the counters, a given-up incident comes back given up. A park is
  discarded the moment `feedMonitoring` sees the condition genuinely gone, and
  that discard runs even while the check is off, so a park can never outlive the
  incident that created it. Turning a check ON never fabricates an incident --
  only a later `feed()` re-detects.
- `enterWaiting` is guarded as well as `feedMonitoring`, because `tickOverload`
  and `tickSafeguard` escalate INTO it when a usage limit appears mid-incident.
  It returns a boolean: FALSE means it declined and made no transition, and the
  caller settles the machine itself. That matters because all four escalation
  callers zero their own incident's budget immediately before calling, so a
  silent decline used to leave the session pinned in `overload`/`safeguard` with
  a zeroed budget that the next tick would refund in full.
- The `feedMonitoring` rate-limit gate is real behaviour, NOT defence in depth
  over the `enterWaiting` guard: without it a tail carrying both a usage-limit
  banner and an overload banner runs the rate-limit branch, which returns early
  and never reaches the overload or safeguard branch at all.
- The three `tick*` send guards are defence in depth only: `setChecks` always
  transitions out of the matching status first, so they are unreachable today.
- `WatchdogPublicState` carries `checks`, so the renderer shows the LIVE state of
  the running session rather than re-deriving it from a config that may have been
  edited since launch.
- New IPC `watchdog:setChecks` is validated field by field -- a non-object, an
  unknown key or a non-boolean is dropped rather than coerced, and an unknown
  session id is a no-op. The payload can only ever make the watchdog type LESS.

### Surfaces

- Session right-click gains a Watchdog auto-retry block, shown only when a
  watcher is actually armed for that session, so the toggles are never offered
  where they would no-op.
- The session header gains a Watchdog pill immediately right of the account, on
  every branch that can carry a watcher (local, SSH-mapped, and SSH with no local
  profile). Green = all three on, "partial" = some, "off" = none, and NO pill when
  nothing is armed -- an absent pill is the honest reading of "no watchdog here"
  and beats an "off" pill on every session when the feature is switched off. Ask
  sessions never arm one, so their slim header is untouched.
- Settings lists the three checks under the master switch. Changing them there
  does not retroactively alter a running session, matching how the existing
  `retryMessage`/`maxRetries` knobs already behave (config is baked at arm time).
- `changelog.ts`, `app-knowledge.ts` and a `tips-library.ts` discovery tip are
  updated; the app-knowledge text previously described the global switch as the
  only control.

### Verification

Mutation matrix (scratchpad `mutate-605.py`, 24 mutants):
23 killed, 1 unreachable-by-construction survivor -- M5, the `tickWaiting` send guard, which `setChecks` makes
unreachable by always transitioning out of `waiting` first. New tests:
`tests/unit/main/watchdog/session-checks.test.ts` (the runtime cases are the ones
that pin the live `checks` triple rather than the config; the round-2 cases pin
the parked-budget resume in both directions),
`tests/unit/main/watchdog-set-checks-ipc.test.ts` for the payload gate, plus
manager, context-menu and header-pill cases.

Two rounds of ADR-009 review landed on this. Round 1 found that an off/on toggle
refunded the retry budget and cleared a give-up, so a safeguard-FLAGGED message
could be auto-resubmitted without bound. The first fix suspended the INCIDENT,
and the independent quality review then found that over-corrected: nothing
cleared the suspension when the check came back on, so a live incident stayed
permanently disarmed while the pill still reported the check as on. Round 2
suspends the BUDGET instead, which keeps the anti-resubmission property while
honouring the toggle in both directions.

Adds an IPC channel, so this sits in the ADR-009 security-sensitive path table
and needs an adversarial pass before merge.
