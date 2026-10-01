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

## Carry marks (rounds 1 and 2)

The credits row brought a second thing to keep. Switch Account carries a
conversation into the account it moves to (`conversation-carry.ts`): the copy in
that account's sessions folder is the earlier account's rollout, so it holds the
earlier account's events, and a reader that takes the newest event as the
account's own would show the earlier account's bars, plan and credits on the
new account's card until its session reports. This is not about the read bounds
above; it changes what the app itself keeps, so it is recorded here.

1. **What is kept.** One record per carry: the destination account's realm id,
   its sessions folder, the conversation id (lower case) and a time (epoch ms),
   the later of the moment of the carry and the newest event time that has a
   zone in the bytes that were copied (so an earlier machine clock, stepped back
   before the move, cannot let the earlier account's later-dated events count;
   a stamp more than 7 days ahead of the clock is taken for garbage and
   ignored). The record is made before the copy and taken back if the copy
   fails (a crash in between leaves a record, which only counts less); a
   record that cannot be kept stops the carry ("not carried over"), never
   lets it go on unmarked. A copy that was already there keeps the record it
   has; an extension (the conversation coming back to an account) replaces its
   record with the newer time. No text of the conversation, no figure, no
   credential.
2. **Where, and how long.** In memory, and in `carry-marks.json` in the app's
   own `providers/` configuration folder next to the account registry, never in
   an account's folder (`src/main/carry-marks-port.ts`; the composition root
   hands the port to the Codex package). Written atomically, owner-only where
   there are modes. The file fails closed:
   - It is looked at before it is read: a link, a folder or any other thing
     that is not a plain file, or a file over 4 MiB, is not read and is dealt
     with as the next item says.
   - A file that is not what this code wrote (not the expected shape in any one
     field, not valid text) is set aside (renamed to `carry-marks.json.bad-<ms>`,
     the newest 3 kept), never overwritten; a floor at that moment is kept in
     the new file, and no rollout counts an event dated before it. So the
     events of a carried conversation that lost its record are not counted
     either; an account's own events written after the floor count as usual.
   - A file that cannot be read now (busy, locked, the folder missing) is read
     again after a wait of 1 second that doubles to 30 seconds, not at every
     call. While it cannot be read, no event of any Codex rollout counts, and a
     carry is refused: the Usage page shows no last-seen Codex figure and the
     live strip no Codex allowance until the file reads, then they come back.
     Nothing the app shows is wrong, and nothing is hidden for good: a file
     that stays unreadable shows no Codex last-seen figure until it is fixed.
   - A record is kept only when it is written. The file is trimmed oldest first
     when it is written so it always fits what a read accepts (1 MiB of text).
   - A realm dropped while the file could not be read is remembered (up to 256)
     and filtered out when the file is read, so its records do not come back.
   - Every field read back is validated, and only the object's own properties
     are read.
   The newest 256 records are kept. A realm over its share evicts its own
   oldest record, never another account's. A realm's records are dropped when
   its account is archived (the realm it has now and every realm it has had,
   such as a folder a Sign in again moved it off) and when its folder is
   removed. A Sign in again (copying the history into a replacement folder)
   moves the old folder's records to the new one, and refuses to go on if they
   cannot be kept.
3. **What reads it.** The session watcher (the live figure) and the last-seen
   reader count, in a rollout that has a record, only the token_count events
   dated after the record's time (or the floor, if later). An event whose
   timestamp has no zone designator (or that is not a time) counts for nothing
   there, the same zoneless rule as the transcript reader's (P3.12), so a doubt
   shows no figure rather than the earlier account's. The new account's own
   events after the carry show as usual. Everything else a rollout says
   (tokens, context, edits) is read as before.
4. **Limits.**
   - The folder is recorded as a path: if the app's data folder is moved, the
     records no longer match their folders and the rollout reads whole, as it
     did before. An account's events from before an extension (the conversation
     going A, B, A) are not counted for it either; they appear again with its
     next report. A carry made before this change has no record.
   - Past 256 records an account with the most records loses its oldest: that
     conversation's rollout, if it is still on disk, reads whole again
     (the earlier account's figures could show on its card until its session
     reports). The bound is a count, not an age.
   - The reports carry no account identifier (the fixtures hold none: a limit
     id, a name, the two windows, a plan and the credits), so a sub-limit's bars
     (an extra metered limit with its own id) cannot be tied to an account.
     After a mark they are dated like every other event and an earlier
     account's are not counted. In a rollout with no record (a carry made
     before marks existed) an earlier account's sub-limit bars can still show
     beside the new account's own main bars, and a newer main report does not
     remove them: an account's own sub-limit is written only when that limit is
     used, so removing older ones would hide the account's own wrongly. The
     credits do follow the newest main report that states them (Decision, item 2).
   - While the file cannot be read, the page withholds every Codex last-seen
     figure (above), not only the carried conversations': the file says which
     rollouts are carried, and that is not known.

## Consequences

- The privacy wording (`PRIVACY.md`) names the credits count beside the
  allowance figures and the plan, and the carry notes among what the app
  stores.
- Parsing the helper's untrusted output is security-sensitive (ADR-009): the
  change gets an adversarial pass. The exact change for the attackers is the
  addition in item 1 and the one reader that implements items 2 and 3
  (`readCredits` in `src/main/providers/codex/rate-limits.ts`).
- The carry marks sit beside the conversation carry (realm-folders.ts runs the
  copy under both realm locks, marks it before it starts and takes the mark
  back if it fails), a new file in the app's configuration folder that is
  read, set aside and trimmed, and the archive and sign-in-again paths of the
  accounts service (`forget`, `adopt`): the pass covers them too (ADR-009).
  A mark that cannot be kept stops that carry ("not carried over") and never
  fails an archive.
- Rejected: reading an unreadable marks file as "no marks". It would let the
  earlier account's figures show on a new account's card whenever the file was
  busy, and a corrupt file overwritten blind would lose every record at once.
  The cost is that an unreadable file withholds every Codex last-seen figure
  until it can be read (Carry marks, item 4); the wait before each new try
  keeps that from costing a read at every call.
- Rejected: taking credits from rollouts only. A closed account on a supported
  CLI is shown from the fresh read, which replaces last-seen, so its row would
  vanish exactly when the page reads afresh; that is not parity.
- Rejected: showing the raw balance with no unit, or no row. The CLI's own
  wording is the unit.
- The live check (a closed account read afresh, an open session, last-seen with
  its age) runs on the test VM's managed account at release.
