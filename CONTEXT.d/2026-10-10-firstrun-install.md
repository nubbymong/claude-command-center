## 2026-10-10 -- Install Claude Code and Codex from setup, the vendor installer first

Owner decisions D1 to D5 of 2026-10-10, recorded in ADR-024. The vendors' own
installers may run (D1), only in a visible terminal and only after a
confirmation that names the host the script comes from; the HTTPS address is
fixed in code beside the documented command, and main types the command only
when it names that address alone. Every install or update command shows Run it
for me and Copy (D2) on the Set up Codex page, the first-run screen, Settings,
Accounts and the footer's CLI help. The vendor installer comes first and npm
second; an npm command says when Node.js is not found and is then copy only
(D3). Claude Code now has recipes through the same provider mechanism
(Anthropic's setup page: native installer, then npm), so its first-run screen
can install it in a terminal on that screen.

Every run line ends its shell when its command ends, and the surface that
opened the terminal checks again then. On Windows, before a check the user
asked for, main appends the registry's PATH folders it lacks to its own PATH,
never dropping one (D4), so a new install is found without a restart; the
restart advice appears only when a check still finds nothing.

Testing per D5: unit tests red first for each new guarantee, typecheck,
changelog sync and the WP1 gate; no VM rows or e2e (the owner checks the
installer on a fresh laptop). The ADR-009 adversarial pass is owed before
merge.
