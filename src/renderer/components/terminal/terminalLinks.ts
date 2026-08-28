import type { ILink } from '@xterm/xterm'

/**
 * #21: decorate the links produced by WebLinksAddon so they DO NOT draw a hover
 * underline, then re-route their activation and record the hovered URI.
 *
 * Why the underline must go: under the WebGL renderer the link underline is a
 * separate overlay (LinkRenderLayer). While a selection drag crosses a link
 * cell, xterm's linkifier fires hide/show-underline on every mousemove and the
 * overlay tears down + redraws each frame, fighting the selection-highlight
 * repaint on the same pixels — the high-speed flicker users reported. A link
 * with `decorations.underline:false` fires no underline event (xterm gates the
 * event on that flag), so the overlay never churns. `pointerCursor:true` keeps
 * the hand cursor so links still read as clickable.
 *
 * Why wrap rather than reimplement: WebLinksAddon exposes no option for
 * decorations, and its `computeLink` (wrapped-line + wide-char aware URL
 * matching) is not exported. So the caller wraps `registerLinkProvider` for the
 * duration of `loadAddon` and passes each produced link set through here — we
 * reuse the addon's proven matching and only augment the ILink objects.
 *
 * `activate` is replaced so clicking opens via the OS browser (the addon's
 * default `window.open` is denied by the main window). `hover`/`leave` record
 * the URI under the cursor so the right-click menu can offer "Copy link
 * address" for the exact link the linkifier matched (any http/https URI —
 * copy has no scheme gate; opening is https-gated in main).
 */
export interface TerminalLinkActions {
  /** Open the URI (renderer → shell.openExternal; main re-validates https-only). */
  open: (uri: string) => void
  /** Record the URI under the cursor (for the context menu's Copy link item). */
  onHover: (uri: string) => void
  /** Clear the recorded hovered URI. */
  onLeave: () => void
}

export function decorateTerminalLinks(
  links: ILink[] | undefined,
  actions: TerminalLinkActions,
): ILink[] | undefined {
  if (!links) return undefined
  return links.map((link) => ({
    ...link,
    decorations: { underline: false, pointerCursor: true },
    activate: (_e: MouseEvent, uri: string) => actions.open(uri),
    hover: (_e: MouseEvent, uri: string) => actions.onHover(uri),
    leave: () => actions.onLeave(),
  }))
}
