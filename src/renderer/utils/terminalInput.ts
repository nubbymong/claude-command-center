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
// classicMode (classicTerminalCopyPaste === true, the default):
//   CC's mouse tracking is disabled (CLAUDE_CODE_DISABLE_MOUSE=1), so xterm
//   owns the mouse and copy-on-select is OFF. Right-click should therefore:
//     - COPY  when text is selected (the user just selected something to copy)
//     - PASTE when nothing is selected (the user wants to paste from clipboard)
//
// non-classic mode (classicTerminalCopyPaste === false):
//   CC's copy-on-select is active — text is already copied the moment the
//   mouse button is released. Right-click must therefore ALWAYS paste;
//   re-copying on right-click would overwrite whatever the user wanted to
//   paste with text they already have.
export function decideContextMenuAction(hasSelection: boolean, classicMode: boolean): 'copy' | 'paste' {
  if (classicMode) {
    return hasSelection ? 'copy' : 'paste'
  }
  return 'paste'
}
