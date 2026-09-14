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

### What the adversarial pass then found, and it was the important half

The source-level assertion was VACUOUS on its first version. It asserted
`expect(code).toContain('timingSafeEqual')` over the whole file -- and `timingSafeEqual`
appears in the IMPORT LINE, which is a code line, not a comment. So a `tokensMatch` body of
`return presented === expected` satisfied it, and the attacker demonstrated that against all
3191 tests: zero failures, including the test named "compares the token in CONSTANT TIME".
Every property the change claimed about the token -- constant time, length-guarded, does not
throw -- reverted silently. The assertion is now scoped to the function BODY, and rejects a
`presented === expected` short-circuit in either direction. That is the second time in this
series a "test that cannot fail" shipped past a self-review and was caught only by an
independent pass.

It also answered the issue's actual question -- "what else arrives unvalidated on that route"
-- with something worse than the field the issue named. `hooks-types.ts` documents a hard
per-session feed ceiling: RING_BUFFER_CAP entries times a ~8 KiB bounded payload. That was
only ever true of `payload`. `event`, `toolName` and the derived `summary` sat OUTSIDE
`boundPayloadForFeed`, and `summary` is deliberately built from the UNbounded payload, so a
1 MiB body produced a ~2 MB ring entry -- the documented ceiling was off by three orders of
magnitude, and every entry is structured-cloned across the utilityProcess transport, so it was
main-process serialisation cost per event and not only memory. Bounded now, which is what
makes that ceiling real.

Smaller things from the same pass: the length bound was in UTF-16 code units, so 4096 units of
astral characters was 16 KiB of UTF-8 -- it is measured in bytes now, and the comment claiming
4096 is "past any real path" was simply wrong (Linux PATH_MAX is 4096 BYTES, macOS 1024, and
Windows long paths allow far more). `tokensMatch` compared lossily transcoded buffers, where
every unpaired surrogate becomes EF BF BD and distinct strings can collide; unreachable given
an ASCII UUID secret, but a comparison that is only correct because of a property of its caller
is one refactor from being wrong, so it hashes both sides and compares digests. And the drop
log had no test at all -- neither that it fires, nor the "length only, never the value"
property that is its entire justification.

Every guard verified by reverting it on an isolated copy: 8 of 8 in the first battery, then
11 of 11 in the second, including the `=== `-body mutation that had passed 3191 tests.

3465 tests; typecheck clean.

### Not written here

The pass also surfaced one finding that is NOT about this change: a pre-existing weakness in
shipped code, low severity, routed privately per SECURITY.md ("Embargo"). No component,
mechanism, or repro appears in this fragment, in the commits, or in the PR -- that is the whole
point of the rule, and `CONTEXT.d/` is the file that catches people.
