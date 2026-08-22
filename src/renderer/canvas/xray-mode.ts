// X-ray hover modes (#367) — the pure half, so the rules can be unit-tested flat.
//
// The canvas pane's hover readout ("x-ray") is the thing that made the pane
// unusable as a plain browser: every mousemove over the content painted an
// outline and a label chip over the page, which is exactly what you do NOT want
// when you are trying to look at the artifact itself. Owner (book item 52):
// "switch the canvas x-ray hover functionality off via toggle easily so I can
// view it as a normal browser."
//
// Three modes, one click apart:
//
//   off      no hover actions at all. The content frame is asked to stop
//            reporting pointer moves and clicks, the host ignores them if it
//            hears them anyway, and nothing is drawn. The page is a browser tab.
//   stealth  hovers still RESOLVE — the element is identified — but nothing is
//            drawn over the page; the identity and its box are read out in the
//            side panel instead.
//   on       what shipped: outline + label chip on the stage.
//
// `on` is the default, and absent settings resolve to it, so no existing
// install changes behaviour on upgrade.

/** The three x-ray hover modes. `on` is what shipped before #367. */
export type CanvasXrayMode = 'off' | 'stealth' | 'on'

export const CANVAS_XRAY_MODES: readonly CanvasXrayMode[] = ['off', 'stealth', 'on'] as const

export interface CanvasXrayModeOption {
  value: CanvasXrayMode
  /** Segment label — one word, this sits in a 38px pane header. */
  label: string
  /** Tooltip: what this mode actually does to the page. */
  title: string
}

export const CANVAS_XRAY_MODE_OPTIONS: readonly CanvasXrayModeOption[] = [
  {
    value: 'off',
    label: 'Off',
    title: 'X-ray off — the page behaves like a normal browser tab. Hover resolves nothing and draws nothing, and a click selects nothing.',
  },
  {
    value: 'stealth',
    label: 'Stealth',
    title: 'Stealth — hovering still identifies the element, but nothing is drawn on the page: the identity and its box are read out in the panel on the right.',
  },
  {
    value: 'on',
    label: 'On',
    title: 'X-ray on — hovering outlines the element on the page and labels it (the default).',
  },
] as const

/**
 * Absent or unknown (an older settings file, a hand edit) => `on`, the
 * behaviour that shipped. A preference that fails to parse must never silently
 * disable a feature the user can no longer find the switch for.
 */
export function resolveCanvasXrayMode(value: unknown): CanvasXrayMode {
  return value === 'off' || value === 'stealth' ? value : 'on'
}

/**
 * Does anything resolve the hovered element at all?
 *
 * This is the ONE fact the content frame is told (canvas-frame-rpc
 * `hoverReporting`): in `off` the bridge stops emitting `pointer` and
 * `contentClick`, so the page does no per-mousemove work whatsoever. The bridge
 * is page-controlled code and may ignore that, which is why the host gates on
 * the same predicate — see xrayHoverIsLive's use in AgentCanvasPane.
 */
export function xrayHoverIsLive(mode: CanvasXrayMode): boolean {
  return mode !== 'off'
}

/** Does the host paint the hover outline + label chip over the content? */
export function xrayDrawsOnPage(mode: CanvasXrayMode): boolean {
  return mode === 'on'
}

/** Is the hovered element read out in the side panel instead of on the page? */
export function xrayReadsOutInPanel(mode: CanvasXrayMode): boolean {
  return mode === 'stealth'
}

/**
 * Does a click inside the content select (lock focus on) what was clicked?
 *
 * The issue left this open for `off` — "nothing, or temporarily arms a note".
 * Nothing: `off` is asked for as "view it as a normal browser", and a browser
 * tab does not turn a click into a selection. Arming a note on click would make
 * `off` a fourth, hidden mode rather than the absence of one.
 */
export function xrayClickSelects(mode: CanvasXrayMode): boolean {
  return mode !== 'off'
}
