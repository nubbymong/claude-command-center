## 2026-08-28 -- #21: terminal link-selection flicker + clickable/copyable links

Selecting a link (or link text) flickered the UI at high speed. Root cause: under
the WebGL renderer the link hover underline is a separate overlay
(LinkRenderLayer). `new WebLinksAddon()` (TerminalView.tsx) registered links with
the underline ON, so during a selection drag over a link xterm's linkifier fired
hide/show-underline every mousemove and the overlay tore down + redrew each frame,
fighting the selection-highlight repaint on the same pixels -> flicker. Links were
also effectively dead: the addon's default `window.open` handler is denied by the
main window, and there was no "copy link address".

Fix (renderer-only): `src/renderer/components/terminal/terminalLinks.ts`
(`decorateTerminalLinks`) + a transient wrap of `term.registerLinkProvider` around
`loadAddon` so each link WebLinksAddon produces is augmented with
`decorations:{underline:false, pointerCursor:true}` (kills the flicker, keeps the
hand cursor), `activate` routed to `window.electronAPI.shell.openExternal`, and
hover/leave recording the URI under the cursor. Right-click over a link (no
selection) opens the context menu with a new "Copy link address" item
(TerminalContextMenu.tsx). Reuses the addon's proven wrapped-line/wide-char URL
matching (its computeLink is not exported).

Scope: opening goes through the existing https-only `safeExternalHttpsHref` gate
in main (shared with account-web/artifacts -- NOT widened), so https links open;
http links are detected + copyable but not opened (copy has no scheme gate).
Works for local + tmux/SSH (linkification is renderer-side text matching).

Not security-sensitive per ADR-009: no IPC/preload/argv/keychain/webPreferences
change; calls the existing guarded openExternal sink; untrusted URL text is
double-gated (addon `https?://` regex + main's https-only WHATWG parse).

Tests: tests/unit/renderer/terminal-links.test.ts (decorator) +
terminal-context-menu.test.tsx (Copy-link item). NOTE: jsdom (.tsx) tests need
`--pool=threads` locally -- the forks pool fails to spawn workers when the repo
path contains spaces ("Claude Command Center"); CI paths have none.
