## 2026-07-30 -- CodeQL alert remediation, worked through adversarial review (#151)

First real exercise of the adversarial-review skill adopted in #150. Four independent
attacker sub-agents, then two bounded fix -> re-attack rounds. The pass paid for itself:
the code fixes were sound, but almost every GUARD around them was not.

Alert dispositions:
- Alert 8 (js/polynomial-redos, conductor-mcp-server.ts) -- FIXED. `/^bearer\s+(.+)$/i`
  replaced by a linear prefix parse.
- Alerts 9/10 (js/insecure-randomness) -- FIXED. New `src/shared/id.ts` (`randomId`,
  crypto.getRandomValues); all 13 duplicated inline `Date.now()+Math.random()` generators
  converged onto it.
- Alert 6 (js/insufficient-password-hash, account-color.ts) -- FALSE POSITIVE, dismissal
  justified with a traced root cause: CodeQL's `maybePassword()` heuristic in
  SensitiveDataHeuristics.qll contains the literal alternative `oauth`, which matches the
  containing property name `oauthAccount` at both taint origins. The field itself,
  `emailAddress`, matches no heuristic. Not yet dismissed on GitHub -- pending.

What the attackers found that a self-review would not have:
- BOTH regression tests were VACUOUS, and one of them twice. The ReDoS flood was
  `'bearer ' + spaces`, which `authHeader.trim()` reduces to the 6-char string `'bearer'`
  -- and which the vulnerable regex MATCHES anyway in one backtrack. It passed at 0.15ms
  against the very code it was supposed to catch. The quadratic path needs a
  LineTerminator `.` cannot cross plus a non-whitespace tail surviving trim:
  `'bearer' + SP*n + 'X\nY'`, which fails at 2270ms. Then the round-2 tri-state test
  repeated the mistake -- `Bearer wrong` is not a refusal under ANY implementation.
  Both are now verified by reverting the parser and confirming they fail.
- A real gap in round 1's fix: the separator check looked only at the FIRST character, and
  the following `slice().trim()` absorbed the rest, so `Bearer<SP><NBSP><token>` was
  accepted. One legal space defeated the whole narrowing. Now scans the run.
- `timingSafeEqual(<empty>,<empty>)` is true and `?token=` yields `''` not null, so an
  empty `expectedSecret` authorized every request. Latent (the provider always mints 64
  hex) but the gate must not trust its own input.
- 32-char ids moved the Windows MAX_PATH cliff 18 chars closer for
  `<resourcesDir>/status/<id>.json`, whose write is a bare `catch {}` inside an emitted
  script -- the symptom would be a silently blank ContextBar. ID_BYTES 16 -> 12.
- Three factually wrong claims in my own comments, corrected: the ReDoS is NOT reachable
  through Node's HTTP parser (llhttp 400s bare CR/LF, maxHeaderSize caps at 16 KB); RFC
  9110 section 11.4 gives `auth-scheme 1*SP`, so accepting HTAB is MORE permissive than
  the RFC, not "the only legal form"; and Codex IS a header-only client
  (`bearer_token_env_var`, no `?token=`), so the Authorization header is its sole
  credential channel.

Process lesson worth keeping: the attackers found no bypass in 211k+ attempts, but found
that the tests certifying the fix were worthless. A vacuous guard is worse than no guard,
because it will be trusted. "Verify the test fails against the unfixed code" is now the
minimum bar for any security regression test here.

SEPARATE FINDING, NOW PUBLISHED -- GHSA-hw7c-g5pw-w725 (medium, CVSS 6.5).

The adversarial pass surfaced an unrelated pre-existing issue while tracing the alert-6
taint path. It was routed privately per SECURITY.md, and this fragment deliberately said
nothing about it while it was embargoed -- a tracked file in a public repo is a disclosure
channel exactly like an issue is. The advisory is published (2026-07-31) and the fix is on
beta, so the public record can now be written; that ordering is SECURITY.md step 4.

What it was: `canonicalizeTranscriptPath` rewrote a transcript path onto the canonical
`~/.claude/projects` root with no containment check. `path.join` NORMALISES `..` rather
than rejecting it, so a crafted suffix escaped the root and resolved anywhere on the same
drive -- and the binder then opened and tailed whatever it named. The input is not
trustworthy: it arrives from an SSH host's statusline sentinel and from hook payloads.

Fix (merged from the advisory's private fork as `1c00230`): resolve both sides and require
the candidate to stay under the root, with a separator-terminated comparison so a sibling
directory whose name merely begins with the root's cannot pass. Plus shape validation on
the SSH sentinel payload, which reached `JSON.parse` behind a bare type assertion.

Deliberately NOT added: a `.jsonl` extension filter. It was in the first draft and removed --
the function is documented and unit-tested to return the bare projects root when the input
ends exactly at the segment, and the filter broke that. Containment is the control;
narrowing what a contained path may point at belongs to the caller that opens it.

Follow-up tracked publicly now that the embargo is lifted: the hooks gateway lifts
`transcript_path` from a hook POST and shares the same source class.
