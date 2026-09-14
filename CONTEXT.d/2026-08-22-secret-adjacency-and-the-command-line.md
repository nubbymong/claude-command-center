# 2026-08-22 — the secret reference is bounded, and reaches the command line

Third of the #371 follow-ups. The beta.16 ADR-009 pass measured the secret-value
contract on PowerShell 5.1 and closed two gaps in the refusal set; it recorded two things
as noted-not-changed:

> values over 8191 chars fail through any .cmd shim (cmd's own limit); `--token=$env:X`
> and `{secret}x` adjacency forms are handed to the child literally by PowerShell
> (pre-existing, no value leak)

## The adjacency form was already fixed once — in the other module

`shared/command-secret`'s `commandSecretRef` (command buttons) emits the BRACED
`${env:NAME}`, with a comment recording exactly why, measured on #386: the bare form is
unbounded, so `{secret}_v2`, `{secret}.json` or `{secret}:x` read as a longer variable
name (or a member access) and the whole argument vanishes, shifting the next flag into
its slot.

`main/terminal-launch-line`'s `secretRef` (terminal configs) still emitted the bare
`$env:CCC_ARG_SECRET`. The fix was never back-ported, which is precisely the adjacency
case the pass recorded. Back-ported here.

No value ever leaked — the failure is the argument evaporating, not the secret
appearing — but "the flag after it silently takes its place" is a bad failure to leave in
a credential path.

## The other half: the token never reached the command line

Substitution ran over the ARGUMENTS only, in both paths. That was justified as "the
secret is an ARGUMENT", and a unit test pinned it.

It does not hold up. A secret can only exist on a SHELL button — the toggle is not
offered for a prompt or a page, and a stored value is dropped if one is converted — and
on a shell button the first field is not a prompt at all: it is labelled **"Command to
run"** and is typed into the terminal exactly as written. The same is true of a terminal
config's first-run command field. Both are the natural place to write a whole invocation
(`curl -H "Bearer {secret}" ...`), and both typed the literal token.

So `{secret}` is now substituted in the command line as well as the arguments, in both
builders. `secretRef` is non-null only for a shell button with a stored secret, so
nothing a Claude prompt types can be touched by this — a test pins that too.

Emptiness is decided on what the user WROTE, before substitution: a command field is
empty because nothing was typed in it, never because a token collapsed to nothing.

## And the hint

`reviewCommandsForUpgrade` scanned `defaultArgs` and `lastCustomArgs`. A shell button's
own command line — the one typed field where a whole invocation with a token in it is the
most natural thing to write — was never scanned. It is now, word by word
(`looksLikeSecretArg` judges ONE argument; its key-shape and entropy rules are anchored,
so a whole line would match nothing). A record written before `kind` existed is caught by
its partner target, the same widening `effectiveKind` does.

A PROMPT button's text is deliberately still not scanned: it is prose, and no reference
is ever typed into one.

## The 8191 limit is documented, not enforced

A note, per the pass. It is a limit of the Windows command line reached through a `.cmd`
wrapper (most npm-installed tools), not of this app, and a value that never goes through
a shim is fine — so refusing at 8191 would break working setups. It now appears in both
places a secret is explained: the command-button callout and the terminal config's secret
hint, beside the sibling Windows rules that were already there.

## A drift-detector that worked

`ask-conductor-prompt.test.ts` asserted that `askPromptRef` and `secretRef` share a
shape, *"so they cannot drift apart silently"*. Changing `secretRef` turned it red, which
is the test doing its job.

They now differ on purpose, and the test says so instead. `askPromptRef` is emitted by the
app itself, in one place, as a standalone token followed by `;` — nothing can be written
next to it, so the bare form has no way to be wrong there. Only the secret reference sits
inside text the user wrote. The shared POSIX quoting rule is still asserted.

## Verification

Mutation-tested all three guards: the braced reference reverted to bare (4 tests red),
the command-line substitution removed (1 red), the shell-line scan disabled (2 red), each
restored byte-for-byte.

Full suite on the branch: 7084 passed, 15 skipped, 2 todo (661 files, 2 skipped);
typecheck clean.
