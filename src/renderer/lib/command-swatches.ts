/**
 * The colours a command button (and a user section) can be: the eleven Mocha
 * pastels the sections already use, so the bar stays one family. A command
 * created before this list existed keeps whatever hex it stored -- the picker
 * shows it as an extra swatch -- and nothing changes colour under anyone.
 *
 * Deliberately NOT `COLOR_SWATCHES` from SessionDialog: that legacy neon list
 * is shared with the screenshot button, notes and the project browser, and
 * re-pointing it would silently change all of them.
 */
export const COMMAND_SWATCHES: readonly string[] = [
  '#89B4FA', '#A6E3A1', '#F9E2AF', '#F38BA8',
  '#CBA6F7', '#94E2D5', '#FAB387', '#74C7EC',
  '#F5C2E7', '#B4BEFE', '#A6ADC8',
]

export const DEFAULT_COMMAND_COLOR = COMMAND_SWATCHES[0]

/** The swatches to offer for a command whose stored colour may predate the list. */
export function swatchesFor(current: string | undefined): readonly string[] {
  if (!current) return COMMAND_SWATCHES
  const hex = current.toUpperCase()
  return COMMAND_SWATCHES.some((s) => s.toUpperCase() === hex) ? COMMAND_SWATCHES : [...COMMAND_SWATCHES, current]
}
