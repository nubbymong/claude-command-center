/**
 * P3.12: a Codex conversation's key, from its rollout's file name: the
 * rollout id in lower case (so its copy in another account, the same name,
 * is the same conversation), else the file name. Used by main's record of
 * the conversations written while not indexed, by the transcripts worker
 * and by search. P3.16 (M1): a Claude transcript's key too: its file name is
 * the conversation's id (`<id>.jsonl`).
 *
 * Pure; no default export (project convention).
 */

const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const KEY_MAX = 200

export function codexConversationKey(rolloutPath: string): string {
  const text = String(rolloutPath)
  const name = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  const m = ROLLOUT_ID_RE.exec(name)
  return (m ? m[1].toLowerCase() : name).slice(0, KEY_MAX)
}
