// src/renderer/utils/launchNote.ts
//
// P3.6 (row 22): the line a terminal says when a session respawned on
// another account (a Switch account) started without its conversation
// carried whole. Main carries the conversation in the respawn itself
// (pty:spawn: kill, carry, spawn) and answers what happened: why it did not
// come along, and whether the launch resumed the conversation anyway, from a
// copy already in that account, or started a new one (completion plan
// section 5's fallback: the switch goes ahead with an honest notice). The
// view that started the session writes the line once, dimmed, before the
// session's own output (TerminalView). Nothing when it came along.
import { stripSpoofableText } from '../../shared/safe-text'
import type { ConversationCarryNotice } from '../../shared/providers'

/** The note for a respawn whose conversation did not come along whole,
 *  in words that are true for what the launch actually did. */
export function carryNote(notice: Pick<ConversationCarryNotice, 'code' | 'message' | 'resumed'>, accountName: string): string {
  const lead = `Switched to ${accountName}.`
  if (notice.resumed && notice.code === 'conversation-differs') {
    return `${lead} That account already holds a copy of this conversation that went on differently there, which the app left as it is, so the session carries on from that copy.`
  }
  const why = typeof notice.message === 'string' && notice.message.trim() ? notice.message.trim() : 'The conversation could not be carried over.'
  return notice.resumed
    ? `${lead} ${why} The session carries on from the copy of this conversation already in that account, which may not have what was said since.`
    : `${lead} ${why} This is a new conversation.`
}

/** A note as the terminal may show it: every control and spoofing character
 *  (C0 and C1 controls, the bidi overrides, isolates and marks, zero-width
 *  and other invisible formatters, line and paragraph separators) replaced,
 *  as the app treats every prose line it writes to a terminal
 *  (shared/safe-text), and bounded. An account's name is the user's own
 *  text. */
export function terminalNoteLine(line: string): string {
  return stripSpoofableText(String(line ?? ''), 1000).trim()
}
