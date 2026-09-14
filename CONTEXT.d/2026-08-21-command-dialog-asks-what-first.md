# 2026-08-21 — The command dialog asks what the button does first

Backlog items 17 and 18, against canvas `Commands uplift and partner browser` v3.
Follows #345, which made the row the truth; this makes the dialog say which row
you are about to fill, before it asks you anything else.

## What was wrong

One "Prompt" field, one placeholder. For the partner terminal that field is a
shell line; for Claude it is an English sentence. Nothing in the dialog adapted,
so the placeholder fitted one of them and misled the other — and you could not
see the button you were making or the text it would type until you had saved it
and pressed it.

## Kind is not a stored field

The design speaks of a command's *kind* — "run a command in a shell" or "send a
prompt to Claude". It is tempting to add `kind` to `CustomCommand`. It would be
wrong: a prompt can only go to Claude, and a shell line can only go to a shell,
so kind and `target` are the **same axis**. Storing both is two fields that must
never disagree. `kindOf(cmd, mainPaneIsShell)` reads the kind off the target,
and `targetFor(kind, …)` writes it back on save. Nothing migrates.

The one place the axis bends is a **terminal-only session**, whose main pane is
itself a shell. There "send a prompt to Claude" is a button that cannot work, so
the card is not offered; and a shell command may run in *either* pane, so the
dialog asks which. "This shell" resolves to `target: 'claude'` — because that is
the row the main pane *is* — and the bar now names that row "Shell" on such a
session, and the partner row "Partner", so two rows both called Shell never
appear. `App.tsx` passes `mainPaneIsShell={!!activeSession.shellOnly}`.

## The preview is built by the bar's own rule

`previewLine(prompt, args)` is `prompt + ' ' + args.join(' ')` — the exact
concatenation `CommandBar.buildFullCommand` performs — and it is exported so the
preview cannot drift from what the button types. A preview that showed one
thing while the bar typed another would be worse than no preview. The chip
shows the label and colour; the line ends in ⏎; "then watches <url>" appears
once the page watch is on.

## Verification

`command-dialog-type-first.test.tsx` drives the real component in jsdom:
fields hidden and submit disabled until a kind is chosen; shell → `partner`,
prompt → `claude`; terminal-only hides the prompt card and asks which shell;
edit preselects the kind; the preview tracks label/text/args and the watch URL.
Full suite green, typecheck clean.

| mutation | result |
| --- | --- |
| `targetFor` sends a shell command to `claude` | red |
| `previewLine` drops the arguments | red |
| prompt card offered on a terminal-only session | red |

## Still to come

**21** (secret arguments through the OS keychain — the value must reach the
*partner shell's environment at spawn*, which is a main-process change) and
**26** (the browser as its own pane; ADR-009 applies) are the last two P3 items.
A third kind, "open a page", belongs with 26 — it is the one kind that types
nothing, and it needs the pane to exist.
