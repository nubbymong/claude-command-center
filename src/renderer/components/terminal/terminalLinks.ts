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
    // BOTH decorations off (2026-09-02 hover-flicker fix). underline:false was
    // #562's selection-drag fix; pointerCursor is now false too because xterm's
    // Linkifier clears + re-asks the hovered link on EVERY rendered-viewport
    // change that touches its rows (leave -> class off -> async re-provide ->
    // class on). A Claude session re-renders continuously (spinner, input box,
    // statusline), so the hand cursor strobed at render cadence. The pointer
    // cursor is managed by createLinkHoverControl instead, which rides the same
    // hover/leave callbacks but debounces the leave, so the churn is invisible.
    decorations: { underline: false, pointerCursor: false },
    activate: (_e: MouseEvent, uri: string) => actions.open(uri),
    hover: (_e: MouseEvent, uri: string) => actions.onHover(uri),
    leave: () => actions.onLeave(),
  }))
}

/**
 * The class the hover control toggles for the hand cursor. APP-OWNED, and its
 * name is load-bearing: it must NEVER contain the substring "xterm-cursor".
 * Claude sessions carry a full-nuke stylesheet
 * (`.claude-session [class*="xterm-cursor"]` -> display:none !important,
 * terminalTheme.ts) that hides Claude's redundant terminal caret — and it
 * catches xterm's own `xterm-cursor-pointer` link class too. That collision is
 * what made the pre-fix hover flicker so VISIBLE: xterm strobed its pointer
 * class on the screen element at render cadence, and each strobe display:noned
 * the whole screen. terminalTheme.ts pairs this class with the cursor rule.
 */
export const LINK_HOVER_CLASS = 'ccc-link-hover'

/**
 * Owns the link-hover UI state OUTSIDE xterm's churn (2026-09-02 flicker fix):
 * the hand cursor (LINK_HOVER_CLASS on the terminal root — deliberately NOT
 * xterm's `xterm-cursor-pointer`, see above) and the URI the context menu's
 * "Copy link address" reads. `hover` applies both instantly; `leave` only
 * after `delayMs`, so the leave->re-hover cycle xterm fires on every viewport
 * re-render (spinner/statusline frames) never reaches the screen — a real
 * departure from the link is a single leave with nothing to cancel it, and the
 * cursor reverts after the short delay. The debounced URI also closes a latent
 * race: a right-click landing inside one of those churn gaps read null and
 * silently dropped the Copy-link menu item.
 */
export interface LinkHoverControl {
  hover: (uri: string) => void
  leave: () => void
  /** The URI under the cursor, stable through xterm's re-render churn. */
  current: () => string | null
  dispose: () => void
}

export function createLinkHoverControl(
  getElement: () => HTMLElement | null,
  delayMs = 150,
): LinkHoverControl {
  let uri: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  const clear = () => {
    uri = null
    getElement()?.classList.remove(LINK_HOVER_CLASS)
  }
  return {
    hover: (u) => {
      cancel()
      uri = u
      getElement()?.classList.add(LINK_HOVER_CLASS)
    },
    leave: () => {
      cancel()
      timer = setTimeout(() => { timer = null; clear() }, delayMs)
    },
    current: () => uri,
    dispose: () => { cancel(); clear() },
  }
}
