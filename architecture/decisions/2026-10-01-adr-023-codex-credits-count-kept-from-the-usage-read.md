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

## Carry marks (rounds 1 to 4)

The credits row brought a second thing to keep. Switch Account carries a
conversation into the account it moves to (`conversation-carry.ts`): the copy in
that account's sessions folder is the earlier account's rollout, so it holds the
earlier account's events, and a reader that takes the newest event as the
account's own would show the earlier account's bars, plan and credits on the
new account's card until its session reports. This is not about the read bounds
above; it changes what the app itself keeps, so it is recorded here.

The proportion that rules every choice below: the harm guarded against is a
temporary display of the user's OTHER account's figures on the wrong card. It
is never a reason to refuse a carry or a Sign in again, and never a reason to
blank every card. Round 2 refused both, and withheld every Codex figure, while
the marks file could not be read; round 3 replaces that with failing closed by
time, below.

1. **What is kept.** One record per carry: the destination account's realm id,
   its sessions folder, the conversation id (lower case) and a time (epoch ms),
   the later of the moment of the carry and the newest event time that has a
   zone in the bytes that were copied (so an earlier machine clock, stepped back
   before the move, cannot let the earlier account's later-dated events count;
   a stamp more than 7 days ahead of the clock is taken for garbage and
   ignored; the scan reads the copy's last 256 KiB and, if that holds no time
   and the copy is longer, its last 2 MiB, as the last-seen reader does). The
   record is made before the copy and taken back if the copy fails (a crash in
   between leaves a record, which only counts less). A record that cannot be
   made never stops the carry: with the file unreadable or unwritable it is
   held in memory (item 2). A copy that was already there keeps the record it
   has, and is given this carry's record only when it has none. One whose
   record cannot be read yet keeps the file's record once the file reads, and
   is given this carry's record then only when the file has none (round 4; up
   to 64 such copies are held in memory, and past that the carry's own record
   stays, which only counts less); an extension
   (the conversation coming back to an account) replaces its record with the
   newer time. No text of the conversation, no figure, no credential.
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
     the newest 3 kept) and, in the same step, replaced by a file that holds the
     floor (the moment it was set aside) and what this run has made. It is never
     overwritten. No rollout counts an event dated before the floor, so the
     events of a carried conversation that lost its record are not counted
     either; an account's own events written after the floor count as usual. If
     the replacement cannot be written, the file is put back where it was, so
     the next start finds it again and sets it aside again, rather than finding
     no file; the store stays as for a file that cannot be read. After 3 such
     failures in a run it is not set aside again in that run (one log line), so
     it is not renamed aside and back at every try: it stays where it is, is
     still read after each wait (a file put right is taken), and the store stays
     as for a file that cannot be read (round 4).
   - A file that cannot be read now (busy, locked, the folder missing) is read
     again after a wait of 1 second that doubles to 30 seconds, not at every
     call. The resources folder not being known yet at startup is not a failed
     read: it is asked again at once. Meanwhile carries, Sign in again and
     archives go on and no card shows an error for it. Marks, dropped realms
     (up to 256) and adoptions (up to 64, applied in order) are kept in
     memory and written once the file reads, beside the file's own marks (this
     run's record of a conversation wins). The failure fails closed by time:
     the first failed read is a floor, in memory, for the folders this run has
     carried a conversation into or adopted a history into; no event dated at
     or before it counts there (nor before a conversation's own record, if
     later). Every other folder reads whole.
   - A record that cannot be written (disk full, a locked file) is held in
     memory, and is written at the next ask after a wait of 1 second that
     doubles to 30 seconds. The file is trimmed oldest first when it is written
     so it always fits what a read accepts (1 MiB of text).
   - A realm dropped while the file could not be read is remembered (up to 256)
     and filtered out when the file is read, so its records do not come back.
   - Every field read back is validated, and only the object's own properties
     are read.
   The newest 256 records are kept. A realm over its share evicts its own
   oldest record, never another account's. A realm's records are dropped when
   its account is archived (the realm it has now and every realm it has had,
   such as a folder a Sign in again moved it off) and when its folder is
   removed. A Sign in again (copying the history into a replacement folder)
   moves the old folder's records to the new one, and goes on whether or not
   they can be moved yet (an adoption that cannot be applied now is queued).
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
   - While the file cannot be read, which conversations an earlier run carried
     is not known. Only the folders this run carried into are held, so a
     conversation carried in an earlier run reads whole until the file reads
     (one to 30 seconds between tries): the earlier account's figures can show
     on the new account's card for that time. This is the accepted cost of never
     refusing a carry and never blanking a card.
   - If the app quits before the file could be read or written, what was held
     in memory is lost: a mark made then is not kept for the next run, and a
     realm dropped then keeps its records in the file (an archived account's
     records are then not deleted from it).
   - A marks file that is deleted reads as missing, which is no marks: the
     conversations carried before then read whole again, and the earlier
     account's figures can show on the new account's card until its session
     reports. A deleted file leaves nothing to tell it from a new install.
   - The floor of a file set aside holds in every folder, because which
     rollouts were carried is lost with the file: every account's figures dated
     before it show again with its next report, not at once. The set-aside
     copies (the newest 3) hold the same kind of records as the file, an
     archived account's included, and are not edited: they stay until three
     newer copies replace them.
   - A copy whose last line is over 2 MiB hides its newest time from the scan;
     the record is then the carry's own moment. A replacement that cannot be
     written and a file that then cannot be put back leaves the file renamed
     with its copy beside it (the next start finds it missing, as a deleted one).

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
  A mark that cannot be kept never stops a carry, a Sign in again or an
  archive.
- Rejected: reading an unreadable marks file as "no marks" with nothing held,
  and overwriting a corrupt file blind: the first would show the earlier
  account's figures on every carried card, the second would lose every record
  at once. Rejected too, and this is round 2's design: refusing a carry or a
  Sign in again, or withholding every Codex figure, while the file cannot be
  read. The harm guarded against is a temporary wrong display, and refusing a
  re-authentication, or blanking every card, costs the user more than it
  protects. Failing closed by time (Carry marks, item 2) holds what this run
  carried and leaves the rest as it was.
- Rejected: taking credits from rollouts only. A closed account on a supported
  CLI is shown from the fresh read, which replaces last-seen, so its row would
  vanish exactly when the page reads afresh; that is not parity.
- Rejected: showing the raw balance with no unit, or no row. The CLI's own
  wording is the unit.
- The live check (a closed account read afresh, an open session, last-seen with
  its age) runs on the test VM's managed account at release.
