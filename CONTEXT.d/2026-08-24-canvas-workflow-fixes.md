## 2026-08-24 -- Canvas workflow fixes: dismiss-all, Ctrl+V paste-to-attach, canvas_pick

Three canvas-review workflow features, agreed on the "Canvas workflow fixes plan"
canvas (owner "Yes" + defaults), shipped as one branch off beta.

**Dismiss-all** -- the Canvas button's right-click clears the session's whole
canvas queue in one sweep (new IPC `canvas:reviewDismissAll`). Scope is resolved
in main (project cwd from the session's own spawn record, never a renderer path)
and filtered to canvases the session owns or is active for -- a foreign or
other-project canvas is never touched. It clears exactly what the queue number
counts (verdict-owed rounds close out per canvas; a ready render awaiting its
first review stops being owed), never deletes (notes, text, versions stay; every
cleared note keeps a one-click Reopen). A confirm card precedes the sweep, and a
"Show what's waiting" menu item opens the queue popover. The agreed scoped
per-subject variant was deferred (a follow-up note), not built.

**Ctrl+V paste-to-attach** -- a pasted screenshot rides a canvas note save. The
renderer re-encodes it through a canvas to a PNG stepped down a size ladder to
fit the 2 MiB cap, the store re-checks PNG magic + byte cap in main and writes it
to a minted path under the canvas dir, and it is delivered to the agent as an MCP
image block. Empty note text is legal only beside an image; an image and a sketch
are mutually exclusive; a visible "Ctrl+V pastes an image" hint sits in the
composer. The paste listener is scoped to the active pane.

**canvas_pick** -- a new MCP tool (the sixth canvas verb) letting the agent record
the variant the user picked *in chat* rather than by clicking Approve in the pane,
chosen over a click-only design. It can only choose among alternatives the agent
attached when it addressed the note (#373). The write is stamped
`closedBy: 'agent'` + a new `pickSource: 'chat'`, together: the validator refuses
either stamp without the other, so a chat pick can never be mistaken for -- or
forged into -- the user's own click-approval, and the pane shows it as "picked in
chat", apart from the user's own clicks, with a one-click Reopen. No seen-barrier
(the user's chat message is the engagement, unlike an agent self-addressed close).

**Review.** Ran `/adversarial-review` (ADR-009) over the security-sensitive
surface (the new IPC, the MCP tool, PNG ingestion/path minting) and an
independent spec + code-quality pass. The adversarial pass found no security
escalation; provenance-forgery, gate-bypass, paste traversal/magic/cap, and
dismiss-all scope all held. It did surface, and this branch fixed, three defects
worth recording:
- Dismiss-all read count fields off the library entry that `listAllCanvases`
  never populates (only the `listAll` join does), so its close-out branch was a
  no-op and its `unreadable` tally was inflated; a mock test had hidden it. Now
  it joins the counts itself, guarded by a real-store regression.
- A pre-existing fail-open (widened by this change): `requireHealthy` ran before
  the load that marks a store broken, so the first mutation after a cold start
  overwrote a corrupt `reviews.json` with an empty record. `recordFor` now
  re-asserts health after the load, distinguishing an absent store (heal) from a
  corrupt one (refuse).
- Spec review caught a chat pick rendering as an agent verdict close ("nobody
  else checked it" / "not approved"); the panel and the aggregate chip now
  exclude `pickSource: 'chat'`, and the paste listener was un-gated across
  hidden session panes (now `isActive`-scoped).

No embargoed finding: the corrupt-store overwrite is a local data-integrity bug
with no external vector, so it is recorded here in the open rather than routed to
a private advisory.
