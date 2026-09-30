import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { TranscriptToolCall } from './tool-call-inspector'
import type { TranscriptMessage } from './transcript-scanner'
import { loadTranscriptEvents, TRANSCRIPT_TAIL, type TranscriptEvents } from './transcript-loader'
import { readCodexRolloutLine, type CodexFileTouch } from '../../logging/codex-rollout-normalizer'

/**
 * P3.12 (row 65): the GitHub Session Context of a Codex session reads the
 * rollout its own watcher holds, in its own realm, as Claude's
 * (transcript-loader.ts) reads the newest transcript of its project folder.
 *
 * The rollout comes from the session's watcher (pty-manager), which checked it
 * is a plain rollout file inside the realm; it is checked again here before it
 * is read: inside that realm's sessions folder, in a YYYY/MM/DD day folder with
 * every folder from the sessions folder down a real folder (not a link or
 * junction to one), a plain `rollout-*.jsonl`, opened without following a link
 * and the same file lstat saw.
 *
 * Read with Claude's bounds (the last 1 MB, whole lines, the last 500 lines),
 * through the Codex normalizer's own line reader, into the same shape
 * Claude's loader gives: the user's and the assistant's words (the opt-in
 * issue-reference scan takes only numbers from them) and tool calls in the
 * terms the file-signal inspector knows (a shell command as `Bash`, a file an
 * edit names as `Edit`, or `Write` when it adds it). The inspector's own
 * allowlists decide what leaves. Injected context, tool output and diffs are
 * never read into it.
 *
 * Any failure reads nothing (an empty result), as Claude's loader does.
 */

const ROLLOUT_NAME_RE = /^rollout-[^\\/]+\.jsonl$/
/** Open without following a link where the platform can say so; elsewhere
 *  the opened file is compared with what lstat saw. */
const READ_NO_FOLLOW = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)

const empty = (): TranscriptEvents => ({ messages: [], toolCalls: [] })

async function isRealFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** `file` when it is a rollout of `sessionsDir`'s own real day folders.
 *  The day-folder rule is the containment too: a folder outside the sessions
 *  folder is reached through `..` (or, on Windows, is on another drive),
 *  never through three names of four, two and two digits. */
async function checkedRollout(target: { path: string; sessionsDir: string }): Promise<string | null> {
  if (typeof target.path !== 'string' || typeof target.sessionsDir !== 'string') return null
  const sessionsDir = path.resolve(target.sessionsDir)
  const file = path.resolve(target.path)
  if (!ROLLOUT_NAME_RE.test(path.basename(file))) return null
  const parts = path.relative(sessionsDir, path.dirname(file)).split(path.sep)
  if (parts.length !== 3 || !/^\d{4}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1]) || !/^\d{2}$/.test(parts[2])) return null
  let at = sessionsDir
  if (!(await isRealFolder(at))) return null
  for (const part of parts) {
    at = path.join(at, part)
    if (!(await isRealFolder(at))) return null
  }
  return file
}

/** The last `maxBytes` of a plain file, whole lines only; null on any doubt. */
async function readTail(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    const seen = await fs.lstat(file, { bigint: true })
    if (!seen.isFile()) return null
    fh = await fs.open(file, READ_NO_FOLLOW)
    const st = await fh.stat({ bigint: true })
    if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino) return null
    const size = Number(st.size)
    const len = Math.min(size, TRANSCRIPT_TAIL.maxBytes)
    const start = size - len
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    if (start === 0) return text
    // Tail-read: whatever precedes the first newline is a partial line.
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(nl + 1) : ''
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => { /* already closed */ })
  }
}

function fileCall(f: CodexFileTouch, ts: number): TranscriptToolCall {
  return { type: 'tool_call', tool: f.op === 'add' ? 'Write' : 'Edit', args: { file_path: f.path }, timestamp: ts }
}

/** The GitHub Session Context events of a Codex session's rollout. */
export async function loadCodexRolloutEvents(target: { path: string; sessionsDir: string } | null): Promise<TranscriptEvents> {
  if (!target) return empty()
  const file = await checkedRollout(target)
  if (!file) return empty()
  const raw = await readTail(file)
  if (raw === null) return empty()
  const lines = raw.split('\n').filter((l) => l.trim()).slice(-TRANSCRIPT_TAIL.maxLines)
  const messages: TranscriptMessage[] = []
  const toolCalls: TranscriptToolCall[] = []
  for (const line of lines) {
    const read = readCodexRolloutLine(line)
    if (!read) continue
    const ts = read.ts ?? 0
    for (const e of read.entries) {
      if (e.kind === 'message') {
        messages.push({ role: e.role, text: e.text, ts })
      } else if (e.kind === 'tool') {
        if (e.command !== undefined) toolCalls.push({ type: 'tool_call', tool: 'Bash', args: { command: e.command }, timestamp: ts })
        for (const f of e.edits ?? []) toolCalls.push(fileCall(f, ts))
      } else if (e.kind === 'files') {
        for (const f of e.files) toolCalls.push(fileCall(f, ts))
      }
    }
  }
  return { messages, toolCalls }
}

/**
 * The transcript a session's GitHub Session Context reads: a Codex session's
 * rollout (the one its watcher holds, or nothing), else Claude's project
 * folder, as before.
 */
export async function loadSessionTranscriptEvents(
  session: { id: string; provider?: string; workingDirectory?: string } | undefined,
  codexRolloutFor: (sessionId: string) => { path: string; sessionsDir: string } | null,
  loadClaude: (cwd: string | undefined) => Promise<TranscriptEvents> = loadTranscriptEvents,
): Promise<TranscriptEvents> {
  if (session?.provider === 'codex') return loadCodexRolloutEvents(codexRolloutFor(session.id))
  return loadClaude(session?.workingDirectory)
}
