# 2026-08-21 — first launch: one surface, one queue, one version

Owner report, from a preview build installed for UAT: *"whats new is a horrible wall of
text — I literally asked you to use the full screen approach"*, and it *"came up at same
time as resume prompt and the seintinal ui"*.

Both halves were real, and the first had a cause nothing on screen could reveal.

## The model the owner set

- The **full app window is the delivery** for What's New on an updated install AND for the
  first-run tour. One surface, two flavours.
- **Updated install:** What's New first, then any first-run-tour pages whose setting was
  *released in this version*, marked as new.
- **First install:** no What's New — the full end-to-end tour.
- **Feature Guide** stays the permanent place to return to, updated alongside tips.

## Why the modal was what actually shipped

`bootWhatsNewSurface` had a `'modal'` arm for "a version change where no tour will run".
That reads like an edge case. It was the common case, because of a second bug sitting
underneath it:

`shouldShowWhatsNew()` and `markWhatsNewSeen()` compared against `changelog[0].version` —
the newest entry **authored**. The pending changelog entry is written *before* the version
bump by design (the accumulator entry is edited, not added, when a beta is cut). So on
every dev build, every preview build, and every build between two releases, the changelog
head is AHEAD of the version running:

- a machine running `beta.15` read as a *within-line upgrade to beta.16* → `showTour:
  false` → the modal, on every launch;
- dismissing it stamped `lastSeenVersion = beta.16`, a version the user had never run —
  which is exactly what the owner's `app-meta.json` held. The real beta.16 would then have
  read `same-version` and shown **nothing at all**.

The version a user has "seen" is the version they **ran**. Both functions moved out of
`WhatsNewModal.tsx` (which had `settle.ts` importing a React component to stamp a version)
into `onboarding/whats-new-gate.ts`, keyed on `__APP_VERSION__`.

## What changed

- `bootWhatsNewSurface` → `'tour' | 'none'`. No modal arm. `WhatsNewModal` survives only as
  the on-demand reader in Settings.
- The harness gained a **what's-new-only mode**: notes page + `stepsNewSince(lastSeen)` and
  nothing else, each extra page badged "New in this release". `settleWhatsNewOnly` settles
  narrowly — it must not claim setup pages it never showed were completed.
- `sinceVersion` on the onboarding registry is finally **read at runtime**. It has been on
  every step since the registry was written and was used for nothing. A page whose content
  materially changes bumps its own `sinceVersion` and re-surfaces by the same rule.
- **The beta-channel full re-walk is gone.** It re-ran all twelve pages on every beta build
  so testers saw the current flow; the cost was twelve pages to deliver one page of notes,
  which is the wall the owner rejected. Beta takes the ordinary upgrade route now.
  `ONBOARDING_VERSION` and a crossed release line still force the full flow.
- `pickBootGate` gained **`resume`**, and `SentinelPanel` is suppressed while any gate is
  up. Those two were the only boot surfaces still outside the chain — the resume prompt
  gated on `bootGate !== 'onboarding'` alone (which did not cover the separate notes gate),
  and Sentinel on nothing at all. That is the stacking the owner photographed.
- `settleWhatsNewOnly` also stamps `lastTrainingVersion`. Not cosmetic: `trainingDue` holds
  the boot chain open, and with the auto-chain into the tour removed, an un-retired trigger
  would have sat above `resume` and stopped it appearing at all — a deadlock this change
  would otherwise have introduced.

## Verification

- Full suite green (6159 passed / 15 skipped), `npm run typecheck` clean.
- The new `whats-new-gate` tests were **mutation-tested**: reverting `runningVersion()` to
  the changelog head turned 3 of 5 red, including both bug assertions. Mutation confirmed
  present by reading the file back, then restored by exact bytes.
- `tests/` is in no typecheck project, so a green `npm run typecheck` says nothing about
  test files — three test files referenced the removed `showWhatsNew` field and only the
  test run found them.

## Left open

Whether an upgrader should ALSO be shown setup pages they skipped or never finished (e.g.
never signed into Codex), on top of the pages new in the release. Currently: delta only.
