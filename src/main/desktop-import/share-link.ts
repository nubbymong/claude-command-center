/**
 * share-link.ts — import a conversation from a claude.ai share link (#209).
 *
 * `https://claude.ai/share/<uuid>` renders a shared conversation. The page's
 * payload shape is NOT a documented API and it WILL change. Rather than pin a
 * path into it, the extractor here does two things:
 *
 *   1. harvests every JSON blob embedded in the HTML (`__NEXT_DATA__`, the
 *      streamed `self.__next_f.push([...])` chunks, and any inline
 *      `application/json` script), then
 *   2. deep-walks each blob for the LONGEST array that looks like a message list —
 *      objects carrying a sender/role of human|assistant plus text content.
 *
 * That survives a re-shuffle of the payload and, when it does not, fails LOUDLY
 * with an error that points at the paste path instead of importing nonsense.
 *
 * The extraction functions are pure and exported so the shape-tolerance is
 * unit-tested without the network.
 *
 * No default export (project convention).
 */

import { net } from 'electron'
import { CLAUDE_WEB_PARTITION, SHARE_URL_RE, type ImportRole, type ParsedTranscript } from '../../shared/desktop-import'
import { parseStructuredTranscript } from './parse-transcript'

/** Max bytes we will pull from a share page. */
const MAX_PAGE_BYTES = 12 * 1024 * 1024

export interface RawMessage {
  role: ImportRole
  text: string
}

export function isShareUrl(url: string): boolean {
  return SHARE_URL_RE.test(url.trim())
}

export function shareUuid(url: string): string | null {
  const m = SHARE_URL_RE.exec(url.trim())
  return m ? m[1].toLowerCase() : null
}

// ---------------------------------------------------------------------------
// Shape-tolerant extraction (pure)
// ---------------------------------------------------------------------------

function roleOf(node: Record<string, unknown>): ImportRole | null {
  const raw = node.sender ?? node.role ?? node.author ?? node.speaker
  if (typeof raw !== 'string') return null
  const v = raw.toLowerCase()
  if (v === 'human' || v === 'user') return 'human'
  if (v === 'assistant' || v === 'claude' || v === 'ai') return 'assistant'
  return null
}

/**
 * Pull display text out of a message node. Handles a plain string field and the
 * `content: [{type:'text', text:'…'}]` block array, ignoring non-text blocks
 * (tool calls, thinking, attachments) rather than stringifying them.
 */
export function textOf(node: Record<string, unknown>): string {
  const direct = node.text ?? node.message
  if (typeof direct === 'string' && direct.trim()) return direct

  const content = node.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if ((b.type === undefined || b.type === 'text') && typeof b.text === 'string') parts.push(b.text)
      }
    }
    if (parts.length) return parts.join('\n\n')
  }
  return ''
}

function looksLikeMessageList(arr: unknown[]): RawMessage[] | null {
  const out: RawMessage[] = []
  let recognised = 0
  for (const el of arr) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return null
    const node = el as Record<string, unknown>
    const role = roleOf(node)
    if (!role) return null
    recognised++
    const text = textOf(node)
    if (text.trim()) out.push({ role, text })
  }
  // Require at least one recognised entry AND at least one with real text; a
  // list of empty stubs is not a conversation.
  return recognised > 0 && out.length > 0 ? out : null
}

/**
 * Deep-walk any parsed JSON for the longest message-shaped array. Depth-capped so
 * a pathological payload cannot blow the stack.
 */
export function findMessageList(root: unknown, maxDepth = 30): RawMessage[] | null {
  let best: RawMessage[] | null = null

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      const hit = looksLikeMessageList(node)
      if (hit && (!best || hit.length > best.length)) best = hit
      for (const el of node) walk(el, depth + 1)
      return
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1)
  }

  walk(root, 0)
  return best
}

/** Best-effort conversation title from a share payload. */
export function findTitle(root: unknown, maxDepth = 12): string | undefined {
  let found: string | undefined
  const walk = (node: unknown, depth: number): void => {
    if (found || depth > maxDepth || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const el of node) walk(el, depth + 1); return }
    const obj = node as Record<string, unknown>
    for (const key of ['name', 'title']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() && v.length < 200 && Array.isArray(obj.chat_messages)) {
        found = v.trim()
        return
      }
    }
    for (const v of Object.values(obj)) walk(v, depth + 1)
  }
  walk(root, 0)
  return found
}

/**
 * Harvest every JSON blob embedded in a share page: `__NEXT_DATA__`, inline
 * `application/json` scripts, and the streamed `self.__next_f.push([1,"…"])`
 * chunks (whose payload is a JS string literal containing more JSON).
 */
export function extractJsonCandidates(html: string): unknown[] {
  const out: unknown[] = []

  const scriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(scriptRe)) {
    try { out.push(JSON.parse(m[1])) } catch { /* not JSON — skip */ }
  }

  const pushRe = /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g
  for (const m of html.matchAll(pushRe)) {
    let chunk: string
    try { chunk = JSON.parse(m[1]) as string } catch { continue }
    // A chunk is `<id>:<json>` fragments; grab each balanced-looking JSON tail.
    for (const frag of chunk.split(/\n/)) {
      const idx = frag.search(/[[{]/)
      if (idx < 0) continue
      try { out.push(JSON.parse(frag.slice(idx))) } catch { /* partial chunk — skip */ }
    }
  }

  return out
}

/** Parse a fetched share page into a transcript, or throw with a usable message. */
export function parseSharePage(html: string): ParsedTranscript {
  for (const candidate of extractJsonCandidates(html)) {
    const messages = findMessageList(candidate)
    if (messages && messages.length > 0) {
      return parseStructuredTranscript(messages, 'share', findTitle(candidate))
    }
  }
  throw new Error(
    'Could not read the conversation out of that share page. claude.ai may have ' +
    'changed its page format, or the link may not be a shared conversation. ' +
    'Use the Paste tab instead.',
  )
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * GET a URL through Electron's net stack, ON THE claude.ai IMPORT PARTITION.
 *
 * This is the whole reason an organisation-scoped share works. The first cut
 * issued a bare `net.request({method,url})`, which runs on the DEFAULT session —
 * one that has never signed in to claude.ai. That can only ever fetch a
 * world-readable link; a conversation shared inside an org came back as an auth
 * failure or a login shell, and the error blamed the link.
 *
 * `useSessionCookies` is required as well: Electron does not attach the
 * partition's cookies to a `net.request` without it, so naming the partition
 * alone would have changed nothing.
 */
export function fetchText(url: string, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => { if (!settled) { settled = true; fn() } }

    const req = net.request({
      method: 'GET',
      url,
      partition: CLAUDE_WEB_PARTITION,
      useSessionCookies: true,
      // Fail closed on a redirect rather than following it (adversarial review,
      // #209, defence-in-depth). The URL is already reconstructed from a strict
      // uuid so the initial target is always claude.ai, but this request carries
      // the member's claude.ai cookies — if claude.ai ever served an open
      // redirect on the share path, `follow` (Electron's default) would carry
      // those cookies to the redirect target. A share page has no legitimate
      // reason to 3xx, so a redirect becomes an error, not a hop.
      redirect: 'error',
    })
    const timer = setTimeout(() => {
      done(() => reject(new Error('timed out fetching the share link')))
      try { req.abort() } catch { /* already gone */ }
    }, timeoutMs)

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_PAGE_BYTES) {
          clearTimeout(timer)
          done(() => reject(new Error('share page is unexpectedly large; aborted')))
          try { req.abort() } catch { /* already gone */ }
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      done(() => reject(err))
    })
    req.end()
  })
}

/**
 * Fetch + parse a claude.ai share link. The URL is validated against the exact
 * share-link pattern FIRST, so only `https://claude.ai/share/<uuid>` is ever
 * requested — this is not a general-purpose fetcher the renderer can point
 * anywhere.
 */
/** Told to the user whenever the likeliest cause is "not signed in on this partition". */
const SIGN_IN_HINT =
  'Only PUBLICLY shared conversations can be imported this way today. A conversation shared ' +
  'inside an organisation needs CCC to hold a claude.ai session, which it cannot yet acquire ' +
  '(tracked in #216). Use the Paste tab: copy the conversation out of the Claude desktop app ' +
  'and paste it here — that path needs no sign-in at all.'

/**
 * True when a 2xx body looks like the signed-out shell rather than a conversation.
 *
 * claude.ai answers an org-scoped share for a signed-out client with a 200 login
 * page, not a 401 — so status alone cannot tell "you may not see this" from
 * "claude.ai changed its markup", and those two need very different advice.
 *
 * HEURISTIC, deliberately narrow: it only fires when the page ALSO yielded no
 * message list, so a real conversation that happens to contain the word "log in"
 * is unaffected.
 */
export function looksSignedOut(html: string): boolean {
  return /\/(login|sign-in)\b/i.test(html) || /\bsign in to (claude|continue)\b/i.test(html)
}

export async function importFromShareLink(url: string): Promise<ParsedTranscript> {
  const uuid = shareUuid(url)
  if (!uuid) throw new Error('Not a claude.ai share link. Expected https://claude.ai/share/<uuid>')

  const { status, body } = await fetchText(`https://claude.ai/share/${uuid}`)

  // 404 is what claude.ai returns for "exists but you may not see it" as well as
  // for "gone" -- it does not distinguish, so neither may the message.
  if (status === 404) {
    throw new Error(
      'claude.ai returned 404 for that link. That means either the conversation was unshared, ' +
      `or it is shared somewhere this app cannot see. ${SIGN_IN_HINT}`,
    )
  }
  if (status === 401 || status === 403) {
    throw new Error(`claude.ai refused that link (${status}) — it is not publicly shared. ${SIGN_IN_HINT}`)
  }
  if (status < 200 || status >= 300) throw new Error(`claude.ai returned HTTP ${status} for that share link.`)

  try {
    return parseSharePage(body)
  } catch (err) {
    // A 200 that parsed to nothing is usually the login shell, not a format change.
    if (looksSignedOut(body)) {
      throw new Error(`claude.ai served a sign-in page for that link rather than the conversation. ${SIGN_IN_HINT}`)
    }
    throw err
  }
}
