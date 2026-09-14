## 2026-07-30 -- Security policy rewritten: posture over guarantees, plus an embargo rule (#159)

Triggered by a near-miss during #151. An adversarial-review pass surfaced an unrelated
pre-existing finding; it was kept out of the issue tracker as SECURITY.md instructed, and
then written with a full repro into a CONTEXT.d fragment and committed. Caught before any
push and redacted -- nothing was disclosed -- but the failure was structural, not careless.
The old policy's only stated control named the issue tracker, which invites the inference
that other files are safe. They are not: this repo is public, and anything pushed is
published. Decision and rationale in ADR-010.

What changed in SECURITY.md:

- "Security Design" (six flat guarantees) -> "Security posture", each property marked
  enforced or conditional. Three corrections, all of them cases where the document was
  stronger than the code:
  - Credential storage: distinguishes provider OAuth credentials (OS store) from
    locally-minted secrets that are on disk by necessity, because a spawned child has to
    read them. The old "never plaintext" was not accurate.
  - IPC validation: scoped to the preload bridge. The old "ALL inter-process messages"
    was a claim about every present and future path; other arrival paths are now named as
    in scope for reports rather than implied to be covered.
  - Code execution: acknowledges the vision MCP tools evaluate JS by design. "No remote
    code execution" read as though authenticated execution tooling did not exist, which
    would steer a reporter away from the token boundary that actually matters.
  Verified before writing: contextIsolation/nodeIntegration/sandbox ARE enforced on the
  app windows (src/main/index.ts), so that bullet was left as an enforced guarantee.
- New Embargo section listing every tracked artefact -- issues, PRs, commit messages,
  branch names, CONTEXT.d, ADRs, changelog -- and the private-fork workflow. Regression
  tests are called out as the deliberate exception: a test pinning the fix describes the
  bug, so it is written at release time and ships with the fix.
- Scope now covers what this product actually is: updater/installer integrity (with #111
  named as known-open so reporters don't spend time on it), prompt injection leading to
  command execution, malicious MCP upstreams, the loopback MCP server, and local-account
  boundaries on a shared machine.
- Response targets made achievable: 7-day ack, 14-day triage, 90-day disclosure default,
  credit by default, safe-harbour terms. The old 48h/7d-critical SLA was not reachable at
  this project's capacity, and a missed SLA costs more goodwill than a modest one.
- Supported-versions table matching the beta/rc/stable channel model.
- Documents the actual pipeline (CodeQL, Dependabot, adversarial review) and declares the
  Scope section the source for the skill's path table, so policy and merge gate cannot
  drift apart silently.

Also confirmed while reviewing: GitHub private vulnerability reporting IS enabled on the
repo, so the advisory link in the policy works for any reporter without write access. Added
a no-detail fallback for anyone who cannot reach it.

The embargo rule is mirrored in three files deliberately -- SECURITY.md (reporters),
AGENTS.md (anyone working the repo), and the adversarial-review skill (the process most
likely to GENERATE an embargoed finding, added on the #150 branch). Stating it once would
have left it absent from exactly where the near-miss happened. SECURITY.md is the
normative text; the other two point at it rather than restating it, to limit drift.

Merge order note: this branch's SECURITY.md references ADR-009 and the skill path, both of
which land with #150. Merge #150 first.
