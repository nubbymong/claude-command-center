## 2026-10-04 -- WP2 PR 4: a Codex account's chatgpt.com web session (P4.6 second half, row 58)

**What.** A Codex account gets its own chatgpt.com web session, as a Claude
account has its claude.ai one: an in-app sign-in window on the account's own
partition (`persist:codex-web-<registry account id>`), the browser pane's
chatgpt.com account surface for a local Codex session, a Codex tab's own menu
item, and the Settings row's status with Sign in to chatgpt.com and Sign out of
chatgpt.com. Archive clears the session first and is refused when the clear
fails; the Codex CLI's own sign-out leaves it, as Claude's does.

**Decision: built before the owner's sign-in run.** OR2a (a real sign-in
before the build) moved into the owner's one run on the final build (OR2).
Three values only a real sign-in shows (the session cookie name, the identity
read, the sign-in methods' hosts) sit in one descriptor marked unverified, and
the design fails closed: completion needs the named cookie AND a valid email,
so a wrong value means "never completes" and a wiped partition, never a false
"signed in"; the window and a signed-out pane may go off-site only to the
listed hosts, never any https host (Claude's own policy is unchanged). A run
that does not complete logs names only: the cookie names, whether the named
one matched, how many identity reads ran, the identity answer's HTTP status
and the key path to an email-shaped value, and the off-site hosts it saw,
never values or query strings. The owner's run leaves the window open until
it closes by itself.

**Guards.** The codexWeb channels answer the app window only, take the
`account` id class only, and act only for a known, non-archived Codex account
(a Codex partition is made only after that check, and the start sweep makes
none: it touches only an account whose partition folder already exists). The
identity read returns only the email. Each run owns its window; one sign-in
at a time across both services. Each guard mutation-proven (29 mutants
killed).

**Start sweep and a newer record store.** At start, a Codex account's
chatgpt.com session with no record is wiped, but only when the record store
reads cleanly and the account's partition folder already exists. A record
store written by a newer version of the app is never rewritten: Sign in to
chatgpt.com is refused with that reason, and Sign out of chatgpt.com still
clears the session.

**Owed.** The second half's own ADR-009 round; PB7b on the VM (unauthenticated
cookie names, each sign-in method's first hop); OR2 on the final build; OR3,
the artifacts record. Completion plan P4.6 and OR2; parity checklist row 58.
