## 2026-08-21 -- ADR-009 adversarial pass on #308, and what it cost

One round, five lenses, bounded up front to the fourteen ADR-009 files across the
PR's sixteen commits (spawn/argv, canvas/MCP, and the one destructive path). The
two lenses the owner named were: can a model-authored string reach an
operator-voice line outside the untrusted envelope, and does the review-count
read ever write. Both of those held. The blocker came from somewhere else.

### The blocker: an env variable is not an argument on Windows

The Ask Conductor question travels in the spawn env and the launch line carries
only `$env:CCC_ASK_PROMPT`. That was taken to mean the value was out of every
parse. It removes the SHELL's parse, and nothing else: PowerShell does not hand a
native command an argument array. It re-serialises every argument into one
command line -- quoting an argument that contains whitespace, never escaping an
embedded quote -- and CommandLineToArgvW in the child re-splits it. Measured
against the real 5.1 binder with the exact line the code builds, a question
containing a quote became several arguments, and one of them could be a flag.

The half that needs remembering: the app's own "Discuss this tip" wording wraps
the tip title in quotes, and 36 of 38 titles are multi-word, so the same defect
was silently truncating the question for almost every tip with no attacker
involved. A security pass found a plain product bug because it was the only pass
that ran the real binder instead of reasoning about it.

The rule now is stated where the reference lives: on Windows the value carries no
straight quote and always ends in a space. No quote means parity cannot flip;
the trailing space means the binder always quotes, which also keeps the value
from ending in a backslash that would escape the closing quote, and makes cmd's
`&`, `|` and `^` inert on the `claude.cmd` path an npm install leaves behind. The
launch line also gained `--`, because a question that IS a flag is otherwise a
flag.

### The two things a bounded scope still caught

The "re-opening your own canvas is not an adoption" fast path ran before the
account comparison as well as before the index guard, so a fence a previous
adversarial review installed was bypassable by the ordinary switch-account flow.
And the one-shot guard on the destructive config migration was written against a
save contract that does not exist -- `config.save` resolves false on a failed
write rather than rejecting -- so it could record itself as done having deleted
nothing.

### The re-attack was worth more than the first round

Two of the fixes were wrong and two of the new tests could not fail. Treating
`appMeta: null` as corrupt was the worst of it: that is what a missing config
file reads as, so the fix made the guard unwritable for exactly the installs it
was meant to serve. The account floor, added without giving the library the same
key, made the list offer rows the action refuses. And both new tests watched the
wrong thing -- one never tried the direction a user actually takes, the other
reset the store between reads, which is precisely what hides a cache warm.

Every guard in both rounds was mutation-tested: fifteen mutations, each one
watched go red and then restored byte-for-byte. Two went green first time and
were rewritten -- an oversized-file test that a JSON parse failure would have
passed anyway, and the null-appMeta case above.

### Follow-up, not fixed here

The session-to-canvas binding survives an in-tile account switch on its own,
without any click, because the index is keyed on session id alone and is rebuilt
from disk the same way. That is pre-existing and not introduced by this branch;
the floor added here closes the path the branch opened. Closing the other one
means invalidating the binding when the account changes, which touches the spawn
path and the restart flow, so it belongs in its own change. Related: a record
born under the default account is branded by the first render that carries a
profile, so the stamp is neither write-once nor authoritative.
