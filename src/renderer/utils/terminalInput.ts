// Detects xterm onData payloads that are terminal CONTROL REPORTS only (focus
// in/out, cursor-position report, mouse report) -- NOT genuine user input.
// Fixes #406: the attention-ack must not reset when the user merely focuses or
// blurs a session (xterm emits focus reports through onData), only when they
// actually type. If anything other than control reports remains, it's input.
const CONTROL_REPORT = /\x1b\[(?:I|O|\d*(?:;\d*)*R|M[\s\S]{0,3}|<\d+;\d+;\d+[Mm])/g

export function isControlReportOnly(data: string): boolean {
  if (!data) return true
  const stripped = data.replace(CONTROL_REPORT, '')
  return stripped.length === 0
}

// Decides what a right-click contextmenu event should do in a terminal.
//
// With CC's copy-on-select enabled, text selection is already copied the
// moment the user releases the mouse. Right-click must therefore ALWAYS
// paste — re-copying the selection on right-click would overwrite whatever
// the user actually wanted to paste with text they already have. The
// _hasSelection parameter is intentionally ignored; it is kept in the
// signature to make the locked intent explicit and unit-testable.
export function decideContextMenuAction(_hasSelection: boolean): 'paste' {
  return 'paste'
}
