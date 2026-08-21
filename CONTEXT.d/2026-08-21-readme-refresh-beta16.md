# 2026-08-21 — README refresh for what beta.16 ships (item 41)

Targeted edits, not a rewrite. README.md now describes:

- **Command buttons** (type-first dialog, three kinds incl. "open a page", named
  rows, the `global` mark, secret arguments via the OS keychain) — #345/#346/#347/#348.
- **Help where you are** — tip of the day + Ask Conductor in the sidebar dock,
  Discuss hands a tip's question to it, right-click hides either — #336/#339/#308.
- **Agent Canvas** — subject picker, rounds with "approve the remaining N", the
  count across canvases, plan mode — #308/#338/#349.
- **Browser pane** (own bullet) — address bar, history, home per config,
  favourites, open externally, sandboxed; "watch for a page" / "open a page" — #348.
- **Multi-account usage strip** minimal mode with the traffic-light thresholds — #337.
- **Under the hood** — GPU rendering opt-in + why (one glyph cache per process),
  "over six thousand" tests.

It describes #348–#350 as shipped; those are green and awaiting the owner's
merge, so this merges after them. The screenshots are untouched (the README
image pipeline is `scripts/readme-shots/` and every image is owner-reviewed
before upload).
