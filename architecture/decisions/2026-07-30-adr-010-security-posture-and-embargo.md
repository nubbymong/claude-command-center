# ADR-010: State security posture, not guarantees — and embargo findings from every tracked artefact

- **Status:** Accepted (2026-07-30)
- **Deciders:** @nubbymong (owner)
- **Related:** #159, SECURITY.md, ADR-009 (adversarial review), CONTEXT.d/2026-07-30-159-security-policy.md, #111 (updater checksum verification)

## Context

Two failures surfaced on the same day, from opposite directions.

**The document overclaimed.** `SECURITY.md`'s "Security Design" section listed six
properties as flat guarantees — among them "credentials never plaintext", "**all**
inter-process messages validated with Zod schemas", and "no remote code execution — no
eval". Checked against the code, some were absolute, some were conditional, and the
document drew no distinction. The app persists locally-minted secrets to disk by
necessity; schema validation is enforced at the preload bridge but not uniformly on every
path data arrives by; and the vision MCP tools evaluate JavaScript in a controlled browser
by design, behind the MCP token.

None of that is a bug. The *document* was the bug. An unqualified guarantee is an
instruction to a reporter: this boundary is handled, look elsewhere. It steers attention
away from precisely the places where assumptions are load-bearing. It also misleads users
about what they are trusting.

**The process leaked.** While working #151, an adversarial-review pass (ADR-009) surfaced
an unrelated pre-existing issue. It was correctly kept out of the issue tracker — because
`SECURITY.md` says "do not file a public issue" — and then written, with a repro, into a
`CONTEXT.d/` fragment and committed. It was caught before any push and redacted, so
nothing was disclosed. But the near-miss was structural, not careless: the running log
*feels* like a private notebook, it is written routinely and often by agents, and the
policy's only stated control named the issue tracker specifically.

The threat model was also stale. It described a conventional desktop app, and omitted the
updater (which ships code to users' machines), prompt injection leading to command
execution (the defining risk of an agentic tool), malicious MCP upstreams, and other local
accounts on a shared machine. The stated SLA — 48-hour acknowledgement, 7-day critical fix
— is not achievable at this project's maintenance capacity, and a missed SLA discourages
the next reporter more than a modest one would.

## Decision

**1. Security claims are stated as posture, with their conditions attached.**

`SECURITY.md` gains a "Security posture" section replacing "Security Design". Each
property says whether it is *enforced* or *conditional*, and conditional ones state the
condition. Three specific corrections: credential storage now distinguishes provider OAuth
credentials (OS store) from locally-minted secrets (on disk, because a spawned child
process must read them); IPC validation is scoped to the preload bridge with other paths
named as in scope for reports; and code execution acknowledges that the vision tools
evaluate JavaScript by design, so the boundary under test is *authentication of that
capability*, not its existence.

The bar: a reader must not be able to conclude from this document that an area is covered
when it is only partly covered. Where we are unsure, the document says the area is in
scope for reports.

**2. An embargo covers every tracked artefact, not the issue tracker.**

A finding stays out of issues, PRs, commit messages, branch names, `CONTEXT.d/` fragments,
ADRs, and the changelog until its fix has shipped. Development happens in the private fork
GitHub attaches to the advisory — never in a branch on this repo, however innocently
named. The public record is written all at once, after release.

The operative reframing, because the old rule was the wrong mental model:
**anything that gets pushed is publication.** "Do not file a public issue" invites the
inference that other files are safe. They are not.

A fragment written during an embargo may record *that* a finding exists and was routed
privately, with no component, mechanism, or repro. Regression tests are the deliberate
exception — a test pinning the fix necessarily describes the bug, so it is written at
release time and ships with the fix.

This rule is mirrored in three places on purpose: `SECURITY.md` (for reporters),
`AGENTS.md` (for anyone working the repo), and the adversarial-review skill (for the
process most likely to *generate* an embargoed finding). Stating it once would have left
it exactly where the near-miss happened.

**3. The threat model matches the product.** Scope gains update/installer integrity,
prompt-injection-to-execution, malicious MCP upstreams, the loopback MCP server, and
local-account boundaries. Out-of-scope gains the "already running attacker code" and
"no demonstrated impact" exclusions.

**4. Response targets are honest.** 7-day acknowledgement, 14-day triage, no fixed fix
deadline, 90-day coordinated-disclosure default, credit by default, and safe-harbour
terms.

**5. The document names its own tooling** — CodeQL, Dependabot, adversarial review — and
the scope section is declared the source for the skill's path table, so the policy and the
merge gate cannot drift apart silently.

## Consequences

**Positive.** Reporters get an accurate map, including an explicit invitation to the two
areas previously implied to be closed. Users get a description of what they are actually
trusting. The embargo rule closes a systematic leak on the path agents take most often.
Naming the pipeline tells contributors what bar applies before they open a PR.

**Negative.** The policy is longer, and longer policies are read less. Honesty about
conditional properties can read as weakness to someone skimming — a reader who sees "not
uniformly held to the same standard" may conclude the project is less careful than one
that flatly claims full validation, when the opposite is true. Accepted deliberately:
overclaiming buys goodwill from skimmers at the cost of misleading the people who would
have found real bugs.

Keeping the same rule in three files creates drift risk. Mitigated by making `SECURITY.md`
the normative text and the other two explicit pointers to it, rather than restatements.

**Rejected alternative — fix the code so the original claims become true, and change
nothing in the document.** Attractive, and partly correct: some of that hardening is worth
doing on its own merits and is tracked separately. But it fails as a policy answer. "All
IPC validated with Zod" is a claim about every present and future path; it would be false
again the first time someone adds a channel. Posture statements survive contact with a
changing codebase; absolute guarantees have to be re-earned on every commit and will
silently rot.

**Rejected alternative — a shorter policy that just says "report privately".** It is the
current document's failure mode. The specific list of tracked artefacts is the entire
value here, because the near-miss happened to someone who *had* read "do not file a public
issue" and complied with it.
