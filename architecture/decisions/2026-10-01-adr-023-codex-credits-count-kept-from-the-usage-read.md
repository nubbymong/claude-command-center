# ADR-023: Keep a Codex account's credits count from the usage read

- Status: Accepted by the orchestrator under the owner-approved plan; the owner confirms it on return
- Date: 2026-10-01
- Amends: ADR-022, bound 8 only

## Context

ADR-022 bound 8 lists what the app keeps from the Codex app-server's answer:
"percentages, reset times, window lengths, limit name and plan". Credits are
not on that list, and the Account usage page's Codex card has no credits row,
where Claude's card has one. `docs/wp2/parity-checklist.md` row 17 asked for
it ("credits: parity, shown once a real read shows their unit", recorded with
the usage plan on 2026-09-27), and the owner-approved completion plan carries
it as P3.14 (`docs/wp2/completion-plan.md`, section 8). ADR-022 says widening a
bound needs a new decision and a new ADR; this is that ADR.

The unit was the open question. P3.1 ran on a managed account that has credits
(`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 7). The
schemas declare the fields and no unit: `CreditsSnapshot` in
`tests/fixtures/codex/app-server/<version>/usage-schema.json` is `hasCredits`
(boolean), `unlimited` (boolean) and `balance` (string or null), identical in
0.153.4, 0.155.1 and 0.157.1. The unit is read from the CLI's own wording,
which prints the balance followed by "credits" (a string search of the binary,
not a live read of that screen), and from the real balance, a decimal string
with 10 fraction digits. So the unit is Codex credits, a count, not money.

## Decision

The app keeps one more thing from a Codex usage reading, and nothing else:

1. **What is kept.** The credits count: `hasCredits` (boolean), `unlimited`
   (boolean) and `balance` (a decimal string, kept as a number). Bound 8 now
   reads "percentages, reset times, window lengths, limit name, plan and the
   credits count"; every other part of it stands.
2. **Where it is read from.** The answer's own `rateLimits.credits` for a fresh
   read, and the `rate_limits.credits` of a rollout's `token_count` event for
   the live and last-seen figures. Never the credits of an entry of the
   per-limit map, and never those of a rollout event for a sub-limit. The
   reset-credit grants (`rateLimitResetCredits`) are a different thing and stay
   unread. The credits are the newest account-wide (default limit) report's,
   the report the main bars come from: a figure, or none now when that report's
   credits are null (what an account without credits writes) or unusable. A
   later such report clears an earlier figure; a report with no credits key, or
   a sub-limit's, leaves it.
3. **How it is treated (bound 8's rule).** Own properties of a plain object
   only. A flag that is not a boolean drops the whole credits. A balance must
   match `^\d{1,13}(\.\d{1,12})?$`, else it is null: a balance with more than
   13 integer or more than 12 fraction digits is not read, so a CLI that writes
   one shows no row (it fails closed). No other key is copied. The client's
   schema checks (bound 5) are not widened: a credits object of the wrong shape
   is dropped, never a reason to call the CLI unsupported.
4. **What does not change.** The three code-built messages, the argv, the realm,
   the lease, the lifecycle, the supported versions, the triggers and the
   verdict rules (bounds 1 to 7) are exactly as before. The usage IPC channels
   and the preload are untouched: the page's view gains an optional `credits`
   of the same three fields.
5. **How it is shown.** A "Credits" row under a Codex card's bars, in the
   styling of Claude's, in Codex's own unit: "N credits" (the CLI's wording), or
   "Unlimited". It is a count and is never formatted as money. The balance
   shows to two fraction digits, and a positive balance under 0.005 reads
   "<0.01 credits", never "0 credits". There is no row when the account has no
   credits (none now), when `hasCredits` is false and the credits are not
   unlimited (whatever the balance), or when `hasCredits` is true and the
   balance is missing or not readable (and the credits are not unlimited).
   `hasCredits: false` has not been observed, so nothing is invented for it.

## Carry marks (round 1)

The credits row brought a second thing to keep. Switch Account carries a
conversation into the account it moves to (`conversation-carry.ts`): the copy in
that account's sessions folder is the earlier account's rollout, so it holds the
earlier account's events, and a reader that takes the newest event as the
account's own would show the earlier account's bars, plan and credits on the
new account's card until its session reports. This is not about the read bounds
above; it changes what the app itself keeps, so it is recorded here.

1. **What is kept.** One record per carry: the destination account's realm id,
   its sessions folder, the conversation id (lower case) and the time of the
   carry (epoch ms), made when the copy lands. A copy that was already there
   keeps the record it has; an extension (the conversation coming back to an
   account) replaces its record with the newer time. No text of the
   conversation, no figure, no credential.
2. **Where, and how long.** In memory, and in `carry-marks.json` in the app's
   own `providers/` configuration folder next to the account registry, never in
   an account's folder (`src/main/carry-marks-port.ts`; the composition root
   hands the port to the Codex package). Written atomically, owner-only where
   there are modes, read back with every field validated (a file that is not the
   expected shape reads as no marks). The newest 256 records are kept. A realm's
   records are dropped when its account is archived and when its folder is
   removed.
3. **What reads it.** The session watcher (the live figure) and the last-seen
   reader count, in a rollout that has a record, only the token_count events
   dated after the carry time. An event whose timestamp has no zone designator
   (or that is not a time) counts for nothing there, the same zoneless rule as
   the transcript reader's (P3.12), so a doubt shows no figure rather than the
   earlier account's. The new account's own events after the carry show as
   usual. Everything else a rollout says (tokens, context, edits) is read as
   before.
4. **Limits.** The folder is recorded as a path: if the app's data folder is
   moved, the records no longer match their folders and the rollout reads whole,
   as it did before. An account's events from before an extension (the
   conversation going A, B, A) are not counted for it either; they appear again
   with its next report. A carry made before this change has no record.

## Consequences

- The privacy wording (`PRIVACY.md`) names the credits count beside the
  allowance figures and the plan, and the carry notes among what the app
  stores.
- Parsing the helper's untrusted output is security-sensitive (ADR-009): the
  change gets an adversarial pass. The exact change for the attackers is the
  addition in item 1 and the one reader that implements items 2 and 3
  (`readCredits` in `src/main/providers/codex/rate-limits.ts`).
- The carry marks sit beside the conversation carry (realm-folders.ts runs the
  copy under both realm locks and marks it after it lands), a new file in the
  app's configuration folder, and the archive path of the accounts service
  (`forget`): the pass covers them too (ADR-009). A mark that cannot be kept
  never fails a carry or an archive.
- Rejected: taking credits from rollouts only. A closed account on a supported
  CLI is shown from the fresh read, which replaces last-seen, so its row would
  vanish exactly when the page reads afresh; that is not parity.
- Rejected: showing the raw balance with no unit, or no row. The CLI's own
  wording is the unit.
- The live check (a closed account read afresh, an open session, last-seen with
  its age) runs on the test VM's managed account at release.
