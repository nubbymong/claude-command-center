// The Conductor MCP page's status pills (SubToolCard): 12px text in a
// semantic token over a wash of that same token, on the card's
// --surface-raised. Each token here clears 4.5:1 over its own wash in both
// themes; tests/unit/renderer/token-contrast.test.ts pins every one.

export type SubToolStatusColor = 'green' | 'yellow' | 'red' | 'overlay1'

/** The wash strength, in percent, of a pill's background. */
export const SUB_TOOL_PILL_WASH = 15

/** The semantic token (a styles.css custom property, without `--`) each
 *  status colour draws with. "overlay1" (off, stopped, checking) is the
 *  secondary text colour: the grey --color-overlay1 measured 4.09:1 there. */
export const SUB_TOOL_PILL_TOKEN: Readonly<Record<SubToolStatusColor, string>> = {
  green: 'status-success',
  yellow: 'status-warning',
  red: 'status-danger',
  overlay1: 'text-secondary',
}
