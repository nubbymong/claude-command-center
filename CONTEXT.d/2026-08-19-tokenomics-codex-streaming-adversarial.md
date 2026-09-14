## 2026-08-19 -- Codex streaming ingest: adversarial pass, three rounds, FINDINGS

Ran the ADR-009 pass over `fef7773a` (stream Codex rollouts instead of reading
them whole) before merging #301. Asked for one bounded round; it took three,
because rounds 2 and 3 found that the FIXES had introduced new defects. That is
the whole argument for re-attacking a patch rather than trusting it.

Nine independent attacker agents. Verdict recorded on #301 as FINDINGS with the
`needs-review` label. Head at the time: `2ba5b3ba`.

### What the pass found and what was fixed

Round 1 against `fef7773a` -> fixed in `22ce81c3`:

- Rows and the file cursor were written in SEPARATE transactions, and the
  supervisor hard-kills the worker on app quit, so the window where rows are
  committed and the cursor is not is hit in normal use. Replaying that byte
  range renumbered the same turns from a moved base and minted fresh dedup
  keys: +50% spend, permanent, cumulative. Now one transaction, with the
  ordinal base held per-FILE on the cursor.
- The model is announced by `turn_context`; a tick starting past it priced its
  turns `unknown`, which matches no pricing row and costs $0. Measured at 20.3%
  of turns over the real tree.
- The pre-filter dropped any line over 64 KB before testing it for markers,
  `session_meta` included. Without a session id the parser returns nothing while
  the cursor advances -- silent, total, permanent loss of a rollout's spend. The
  largest real `session_meta` was already 47 KB, 72% of that bound, and it grows
  with the user's MCP servers and AGENTS.md.
- The streaming rewrite had dropped the per-file `catch` that `readFileSync`
  had, so one EIO aborted the whole sweep -- reproducing the original nine-hour
  "Indexing 1700/1997" wedge through a different door.
- The read loop rebuilt the accumulated run on every 256 KB read, quadratic in
  line length. Real rollouts hold 34 MB tool-output lines. Independently
  measured: a 48 MB line went 4512 ms -> 25 ms.

Round 2 against `22ce81c3` -> fixed in `d450782b`:

- The migration gave every existing cursor an ordinal base of 0 while its
  `lastOffset` sat deep in the file, so the over-count had become a silent
  UNDER-count for every existing user on upgrade. 10 turns lost on a drained
  rollout, 40% on a part-indexed one.
- Judging completeness with a query over `tk_files` was wrong because nothing
  prunes that table: a row for a deleted file vetoes the first index forever.
  The live 221 MB database already holds 9 such rows among 24,256 dead ones.
- None of it reached the UI anyway -- supervisor and renderer store both latched
  "complete" on any `index-complete`. That message now carries `drained`.

Round 3 against `d450782b` -> partially fixed in `2ba5b3ba`:

- The per-turn model fix was neutralised by the worker handing the freshly
  derived identity back as the parse seed. `codexIdentityFrom` returns the LAST
  model in the slice, so every turn before the slice's first `turn_context` took
  the model the slice ENDED on. 33% under on a two-switch session.

### Left open, deliberately -- both are owner decisions

- **Subagent rollouts collide (pre-existing, also in shipped beta).** 145 of the
  owner's 320 real rollouts carry TWO `session_meta` lines: their own id, then
  the parent's. `codexEventsFromRollout` keeps the last, so a subagent file
  resolves to the parent session and its ordinals collide. Across three fully
  counted groups, 647 of 1312 turns are lost (49.3%); 163 of 320 files are in a
  colliding group. Fixing it means either keying dedup on the FILE or taking the
  FIRST `session_meta` as identity -- and changing the key format risks
  re-counting everything already stored, which is not a call to make unattended.
- **An unreadable transcript now wedges a FIRST index.** Making completion
  honest also made it absolute, so a file that can never be opened keeps
  `drained` false and the page shows a spinner for the life of the install, with
  no error path. Only affects databases that never latched the flag (new
  installs). Round 2 explicitly asked for this gate; round 3 showed the opposite
  failure is worse in practice. It wants a bounded escape and a banner, which is
  a UX decision.

### Method notes worth keeping

- Every regression test was verified by reverting its fix and watching it go
  red. 14 mutations. That caught two guards that could not fail -- a wall-clock
  assertion swamped by fixed overhead, and an unterminated-tail fixture too
  small to notice a re-read -- and a bug in a fix itself (an early version
  skipped the final partial line of any file being appended to).
- Anchors for mutation testing must be CRLF-aware in this repo. A multi-line
  anchor written with `\n` matches nothing, and a mutation that never landed
  looks exactly like a guard that held.
- `git checkout --` to undo a mutation also discards any UNCOMMITTED fix in the
  same file. That silently reverted a fix here; it was caught only by grepping
  the file afterwards rather than trusting the test run that preceded it.

### Changelog

No beta.15 changelog entry has been written for any of this yet, on purpose:
the text depends on whether the tokenomics commits stay in the release or are
held out. #301's other work (canvas, nav/tabs, Feature Guide, README) is
unaffected either way and is already covered.
