## 2026-08-23 -- #430 Sentinel: a rate-limited analysis account showed the vague "could not complete"

First bug found installing beta.17. The Sentinel panel said "AI analysis could
not complete this run. The deterministic checks still ran. Use Re-run to try
again." Re-run did nothing.

**Root cause (from the live install log + a direct repro).** `claude --version`
succeeded, but `claude -p --model sonnet --output-format json` exited **1**
fast (~2s, not a timeout). The `-p` envelope on stdout carried the real reason:
`is_error: true`, `api_error_status: 429`, `result: "You've hit your weekly
limit · resets 4am (Europe/London)"`. `analysisFailureMessage` only ever
special-cased the word "timed out" in **stderr** — it never looked at the
stdout envelope — so every non-timeout failure, a 429 included, collapsed to
the generic line. Re-run is futile against a weekly limit, and nothing said so.

Two install-side facts made it bite: the configured `sentinelAccountProfileId`
no longer existed on disk, so `resolveHeadlessProfileHome` fell back to the
first signed-in profile — which happened to be the weekly-limited one — and
nothing named which account was in use.

**Fix (this PR).**
- `envelopeError(stdout)` reads the RAW top-level `-p` envelope (NOT
  `unwrapPayload`, which peels `.result` — on an error that field is the human
  string, not nested JSON; routing through it was the first-cut bug, now a
  regression test). It returns `{ rateLimited, reason }` from
  `api_error_status` / `is_error` / `terminal_reason`, with `result` cleaned
  (control chars stripped) and capped at 160 chars.
- `analysisFailureMessage(stderr, envErr?, accountLabel?)` now says the real
  reason and NAMES the account: a rate limit reads "The Sentinel analysis
  account (email) has hit its usage limit — <reason>. Pick a different account
  in Settings → Sentinel, or Re-run once it resets."
- `runAnalysis` captures the envelope from a non-zero attempt and **stops after
  one attempt on a rate limit** (a weekly wall will not clear on an immediate
  retry); a transient non-429 API error still gets the second attempt.
- `analysisHome()` now also returns the account label (email), and flags the
  fallback case ("auto-picked — your chosen analysis account is no longer
  available") so a limit on an account the user never chose is explained.

The account email appears only in a local panel message; it is the user's own
account, never sent anywhere. The deterministic backstop is unchanged and still
runs regardless.
