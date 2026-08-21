# 2026-08-21 — Tip content refresh, and three gates that now exist

Backlog item 12. The library was last refreshed 2026-06-12 and had nothing for
anything shipped since: the Agent Canvas, plan mode, Ask Conductor, the sidebar
dock the tips themselves now live in, pages-as-tabs, detachable SSH sessions,
Codex, multi-account, the minimal account strip, the Feature Guide, or Logs.

Eleven tips added. Written against the real surfaces, not from memory of them —
every claim in the copy was checked against the code that implements it, because
a tip that names the wrong menu is worse than no tip: it costs the reader the
trust they had in the other thirty-four.

Corrections that came out of that checking, all of which I would have got wrong
by writing from the backlog text alone:

| I was about to write | what the app does |
| --- | --- |
| Ask Conductor has a bottom-bar button | it deliberately does NOT — one entry point, the docked pill (`BottomBar.tsx:113`) |
| `Ctrl+/` opens Ask Conductor | `Ctrl+/` toggles the GitHub panel; Ask has no shortcut |
| minimal dots live in Settings → General | Settings → **Status Line**, under the bucket toggles |
| the Feature Guide view is `feature-guide` | it is `help` |

## Three new recordable gates

A gate the app cannot write is a tip nobody sees (`requires`) or a tip that never
retires (`excludes`), which is the whole of item 15. So the three tips that
needed one got a real call site:

| id | recorded when |
| --- | --- |
| `canvas.opened` | the Canvas button OPENS the pane (not on close — a toggle that recorded both would mean nothing) |
| `sessions.codex-config` | a config is SAVED with the Codex provider |
| `accounts.switch-session-account` | a session is moved to another account from its context menu |

`canvas.opened` does double duty: it retires the canvas tip and it is what
unlocks the plan-mode tip, which is meaningless to someone who has never opened
the pane.

## Two guards that did not exist

**`actionTarget` was unchecked.** `TipModal` casts it straight to `ViewType` and
hands it to `onNavigate`, so a plausible name that is not a view gives you a
button that does nothing. I wrote `'feature-guide'` and nothing complained —
the field is a string, so TypeScript cannot help. Now tested against the real
view list, and mutation-checked with the exact mistake I made.

**The trackUsage round trip was a comment, not a test.** `tipsStore` promises
that "the round-trip test below fails on any literal call site that is not
represented" — there was no such test. It matters in the direction that is easy
to get wrong: add a `trackUsage` call, forget `DIRECT_FEATURE_IDS`, and the
prune deletes that row on the next launch, so the feature records itself and
then silently un-records itself forever. The new test walks `src/renderer`,
scrapes every literal `trackUsage('…')`, and asserts each id is one the prune
knows. It asserts it found more than ten call sites first, so an empty scan
cannot pass.

Also corrected: `countUnseenTips`'s caveat still described the pre-#339
behaviour (stamped when PICKED). It is stamped when drawn now.

## Verification

Full suite green; typecheck clean. Both new guards mutation-checked — the
`actionTarget` one by restoring the bad target, the call-site one by removing an
id from `DIRECT_FEATURE_IDS` (it failed, and took the requires/excludes test with
it, which is the right blast radius).
