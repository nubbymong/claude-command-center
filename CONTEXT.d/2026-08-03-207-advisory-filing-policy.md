## 2026-08-03 -- Advisory filing is now executable, not just documented (#207)

Filing a private advisory took five failed API calls and a wrong diagnosis. The cause was
not missing knowledge: `docs/security-embargo-runbook.md` already carried a working CLI
recipe. The cause was that nothing forced the runbook to be read, so the payload was
re-derived from the GitHub API docs instead and omitted `vulnerabilities[]` and
`cvss_vector_string`.

The trap that turned a two-minute mistake into a long detour:

    POST /repos/{owner}/{repo}/security-advisories/reports
    -> 500 Internal Server Error, Content-Length: 0

A missing required field returns a BODYLESS 500, not a 422 naming the field. That is
indistinguishable from an outage, so it was read as one -- which sent the work off to verify
`private-vulnerability-reporting` (`{"enabled":true}`), retry with a minimal payload, and try
the maintainer endpoint (403, which the runbook already documents as the wrong endpoint). All
five attempts created nothing. The runbook's own recipe worked first time once read.

Deployed, in the order that matters:

- `scripts/file-advisory.mjs` is now the required path. It fills in every required field,
  validates BEFORE a request exists, names the offending field when something is wrong, and
  defaults `start_private_fork` to true. `--dry-run` prints the payload without filing.
  Its failure message says explicitly that a 500 from this endpoint is evidence about the
  payload and not about GitHub's health, so the next person cannot repeat the misdiagnosis.
- The script enforces the embargo MECHANICALLY: a `--desc` path inside the repository working
  tree is refused. That is the `CONTEXT.d/` trap the runbook warns about -- it reads like a
  scratch notebook and is a tracked file, so a repro written there is a disclosure with
  reproduction steps attached. A path check turns a rule into a guard.
- `tests/unit/file-advisory-payload.test.ts` pins the required-field list, the CVSS and CWE
  shapes, and the path guard (including that a sibling directory sharing a name prefix is
  not mistaken for "inside"). CI now owns that list rather than memory.
- The runbook's Gotchas table leads with the 500 row, and its CLI section points at the
  script instead of a hand-assembled `node -e` block.
- AGENTS.md says to read the runbook BEFORE the first API call, not after one fails.

The general lesson, which is why this is a policy and not just a script: this repo writes
executable procedures precisely because prose gets skipped under momentum. A procedure that
can be bypassed will be. The fix for "the runbook was not read" is not a louder runbook -- it
is a script that cannot be run wrongly, with the reason baked into its error messages.

Gate: 11 new unit tests, all three script guards exercised end to end (dry-run succeeds,
in-repo description refused, missing summary refused -- each exiting non-zero without
issuing a request).
