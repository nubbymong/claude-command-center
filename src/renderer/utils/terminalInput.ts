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
