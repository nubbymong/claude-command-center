## 2026-08-03 -- Audit the second transcript_path source into the binder (#180)

GHSA-hw7c-g5pw-w725 fixed `canonicalizeTranscriptPath` and traced ONE source path into it:
the SSH statusline sentinel, which also got a shape filter. The hooks gateway lifts the same
field out of a hook POST body, reaches the same binder, and is read BEFORE redaction -- and
it never got the same look. That is #180, and this is the audit.

### What the audit found

The containment fix holds from this entry point. That is not luck: it was put at the choke
point rather than the call site precisely so it would cover callers nobody had enumerated,
and this is the caller nobody had enumerated. Nothing was reachable past it.

What was missing is the SHAPE half. The value reached the binder through a bare
`typeof x === 'string'`, unbounded and unfiltered, on a route whose body is remote-influenced.
So: `sanitiseTranscriptPath` bounds it at 4096 and rejects an embedded NUL or any C0/DEL
control character. Containment is deliberately NOT re-implemented there -- two copies of a
containment rule is how the two copies drift, and the choke point is the right place for it.
A dropped path is logged (length and type only, never the value: this runs before redaction)
because a silently dropped path looks identical to "Claude did not send one", and the two have
very different diagnoses.

Also noted in the issue and fixed here: the per-session token was compared with `!==` while
the MCP server on the same machine uses `timingSafeEqual` for its equivalent check. Low
impact -- a loopback token with 122 bits of CSPRNG entropy is not realistically recoverable by
timing -- but "low" argues for consistency, not against it. `tokensMatch` is now the same
shape as `conductor-mcp-server.ts`, length-guarded first because `timingSafeEqual` throws on
unequal-length buffers, and refusing an empty expected secret because
`timingSafeEqual('','')` is TRUE.

### The test is the point of the issue

The issue asks for "a test that drives the gateway path specifically, not just the helper. A
unit test on the helper cannot see which callers exist, which is exactly how the sentinel path
went unexamined for so long." So every case in
`tests/unit/hooks/hooks-gateway-transcript-path.test.ts` goes in as an HTTP-shaped POST
through `_handleRequestForTest` and is checked at the far end -- what the discovery sink
received, and what the REAL `canonicalizeTranscriptPath` then does with it. The helper's own
unit tests sit alongside those, not instead of them.

One case needed a different tool. Constant-time comparison cannot be observed from a unit
test: `!==` returns the same verdict, just not in constant time, so every behavioural test
passes against it -- confirmed, the mutation survived the first battery. It is pinned with a
source-level assertion instead, scoped to code lines so the rationale comment (which contains
the words `token !== expected` while explaining why not to) does not trip it. Same tool the
resume-picker tests use for `shell: false`, and for the same reason.

Every guard was verified by reverting it on an isolated copy and watching its named test fail:
8 of 8 mutations killed, including the two that survived the first pass.

3461 tests; typecheck clean.
