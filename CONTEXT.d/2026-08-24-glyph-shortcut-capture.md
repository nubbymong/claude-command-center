# 2026-08-24 — Ctrl+Alt+G fired nowhere it mattered (beta.17 FYI item)

The glyph-corruption diagnostic chord (#374) was bound in the window's
BUBBLE-phase keydown listener. xterm's key handling stops propagation at its
textarea, so with the terminal focused — exactly where you are when glyphs go
missing — the chord never reached the handler. Everywhere else it worked,
which made "Ctrl+Alt+G does nothing" look untraceable.

Fix: the chord moved to its own CAPTURE-phase window listener (same
arbitration the tip card's Escape uses), keeping the AltGr guard (#399) and
the onboarding-overlay suppression. Success remains visible via main's
shell.showItemInFolder reveal.

One arbitration rule came with the move: the Settings shortcut recorder and
its Test box must WIN over the capture listener (or the chord could never be
re-recorded or tested — pressing it in the Test box fired a REAL capture,
disk write + Explorer reveal). Both boxes carry `data-shortcut-capture` and
the handler yields to any target inside one; that attribute is the contract
for any future capture-phase chord.

Test `keyboard-glyph-capture.test.tsx` simulates xterm faithfully (capture-
phase interceptor on the textarea cancelling the chord): fails on a
bubble-only listener (verified by mutation), passes on capture. The AltGr
chord is pinned to pass through unprevented (load-bearing before xterm), the
recorder yield is pinned from both halves (handler honours the attribute;
SettingsPage emits it), and the plain-window test is a regression guard.
