# 2026-08-21 — Commands: the row is the truth

Backlog items 19, 20, 22, 23, 24, 25 and 27, against the approved design on
canvas `Commands uplift and partner browser` v3 (both review notes on it were
already addressed, so this implements a design that had been through a round
rather than a fresh guess).

## "Any" is gone (23, 27)

A command's target could be Claude, Partner, or **Any** — and Any was the
dialog's default. An Any button was filed in the Claude row but ran in whichever
pane happened to be open when you clicked it. So a button sitting under the
Claude mark could execute a shell line, and which pane it went to depended on
state nothing on screen showed.

Owner's call (asked explicitly, 2026-08-21): **drop it**. A button lives in the
row it runs in. `migrateCommandTargets` rewrites every stored `'any'` to
`'claude'` once — the row those buttons were already filed in, and where they
landed most of the time, since the partner pane is opened deliberately and rarely
left open. Anything that belongs in the shell is one drag away, and the row will
then be telling the truth about it.

An **absent** target is deliberately left absent rather than normalised to
`'claude'`. Absent has always meant Claude, so rewriting it would churn
commands.json for every user on the first launch after the update in exchange for
no change in behaviour. The migration returns its input reference when there is
nothing to do, so a healthy launch writes nothing.

## Both rows, always, and named (24)

The partner row rendered only when at least one command targeted it, so creating
the first partner command made a row materialise and deleting the last took it
away — the bar's height changing under the pointer. An empty row is also the only
affordance that says "you can put buttons here", which is exactly what someone
with no partner commands needs to see.

Both rows now render whenever the session has a partner terminal, and each is
named ("Claude" / "Shell") rather than marked with an icon alone. The icon never
said *where* a button runs, which is the entire reason the rows are split.

## Scope, made visible (25)

A global command and a this-config command looked identical, while editing or
deleting the global reached every config the user owns. Global buttons now carry
a small dashed `global` chip — dashed rather than filled because it is a property
of the button, not a state, and must not read as another status dot. The tooltip
spells out the consequence.

## Two things the dialog never explained (19, 20)

- **Arguments are raw concatenation.** `prompt + ' ' + args.join(' ')`, with no
  quoting at all, so an argument containing a space arrives as two. The chip UI
  implies structure that does not exist, and now the dialog says so.
- **Ctrl+click edits arguments for one run.** A real feature whose only teacher
  was a tip that may never have fired. (#339 made that tip retire itself once the
  feature is used; this is the other half — saying it where the feature is.)

## "Launch webview on completion" (22)

Renamed to "Watch for a page and open the browser when it responds", and the
helper text now leads with the fact that the poll starts when the command is
SENT. That is not a detail — it is the point. It is waiting for a server that is
still starting up, and the old name promised the opposite.

## Verification

Full suite **6307 passed / 15 skipped**, typecheck clean.

| mutation | result |
| --- | --- |
| partner row rendered only when it has commands (the old behaviour) | 1 red |
| global chip removed | 1 red |
| `migrateCommandTargets` made a no-op | 2 red |

The empty-row test needed the fixture to be mutable — the first cut asserted
"Shell appears" against a fixture that always contained a partner command, so it
passed for the wrong reason and would have survived the mutation. It now removes
the partner commands first and additionally asserts the row is genuinely empty.

## Still to come in this area

Items **17** (type-first dialog) and **18** (live preview of the button and the
exact text it types) are the next PR; **21** (secret arguments through the OS
keychain) and **26** (the browser as its own pane, which ADR-009 covers) follow.
The design for all four is on the same canvas version.
