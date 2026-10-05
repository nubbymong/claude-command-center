/**
 * account-email-read.ts — read the signed-in claude.ai account email from a
 * live view/window, SAFELY, for both surfaces that do it: the in-app sign-in
 * window and the pane's account view.
 *
 * WHY SHARED (#439 adversarial): the read runs page script, so it is
 * page-influenced. Two properties make it safe, and both must be identical at
 * every call site or one drifts open:
 *   1. ISOLATED WORLD — the surrounding expression (the `Promise`, `.then`, the
 *      `location.origin` read) runs where page script cannot shadow it. In the
 *      MAIN world a hostile page can override `Promise.resolve` and make the
 *      `else` arm yield an attacker string. `location` is [LegacyUnforgeable]
 *      so the origin gate itself is sound in either world, but the wrapper is
 *      not — hence the isolated world.
 *   2. SHAPE + LENGTH VALIDATION — the result is an account label shown in the
 *      UI. A crafted-but-"valid" string could carry bidi/zero-width controls
 *      that spoof the displayed identity, so it is validated to a conservative
 *      email shape with no controls and no shell metacharacters (the same class
 *      claudeAuthCommand enforces, since an email can flow into a shown command).
 *
 * The CALLER additionally gates on the frame actually being on claude.ai before
 * trusting or recording anything — a page reached via a nav gap must not answer.
 *
 * No default export (project convention).
 */

import type { WebServiceDescriptor } from '../../shared/account-web-session'

/**
 * A conservative email shape. The load-bearing exclusions are whitespace and
 * `\p{Cc}`/`\p{Cf}` (control + format, i.e. the bidi overrides and zero-width
 * characters) — that is the DISPLAY-SPOOFING class, and the whole reason to
 * validate a label read from a page. Shell metacharacters and quotes are NOT
 * excluded here: an email legitimately contains an apostrophe (o'brien@…), and
 * the one consumer that builds a shown command (claudeAuthCommand) re-gates
 * those itself, so excluding them here only drops valid addresses.
 */
const EMAIL_RE = /^[^\s@\p{Cc}\p{Cf}]{1,128}@[^\s@\p{Cc}\p{Cf}]{1,128}\.[^\s@\p{Cc}\p{Cf}]{1,64}$/u

/** null unless `v` is a string matching the conservative email shape. */
export function sanitizeAccountEmail(v: unknown): string | null {
  return typeof v === 'string' && EMAIL_RE.test(v) ? v : null
}

/** The `/api/bootstrap` read, origin-gated inside the expression itself. */
const EMAIL_EXPR =
  `(location.origin === 'https://claude.ai' || location.origin === 'https://www.claude.ai') ` +
  `? fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json())` +
  `.then(j=>(j&&j.account&&j.account.email_address)||null).catch(()=>null) ` +
  `: Promise.resolve(null)`

const IO_TIMEOUT_MS = 10_000

interface EmailReadableWebContents {
  executeJavaScriptInIsolatedWorld?: (worldId: number, scripts: Array<{ code: string }>) => Promise<unknown>
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
}

/**
 * Read + sanitize the account email from a webContents. Runs in an isolated
 * world where available (a fallback keeps older/edge environments working; the
 * caller's origin gate is the load-bearing check either way). Never throws;
 * returns null on any failure or a value that fails validation.
 */
export async function readAccountEmail(wc: EmailReadableWebContents): Promise<string | null> {
  return readEmailWith(wc, EMAIL_EXPR)
}

/**
 * The identity read for a service a WebServiceDescriptor describes (chatgpt.com
 * for a Codex account, P4.6). The same two properties as Claude's read, plus a
 * third this service needs:
 *   1. ISOLATED WORLD, and the origin gate INSIDE the expression: only the
 *      service's own origin is asked; any other page answers null, unasked.
 *   2. SHAPE + LENGTH VALIDATION of the answer (sanitizeAccountEmail).
 *   3. EMAIL ONLY. The identity answer can carry more than the email (an access
 *      token, for one). The expression walks to the email inside the page's
 *      isolated world and returns that string or null, so nothing else in the
 *      answer ever crosses into the main process, is logged or stored, or is
 *      kept in a variable that outlives the read. It is fetched with
 *      `cache: 'no-store'`, so the read leaves no copy in the HTTP cache.
 * Every descriptor value is embedded as a JSON literal, never spliced as code.
 */
export function serviceEmailExpression(desc: WebServiceDescriptor): string {
  const origin = JSON.stringify(desc.origin)
  const path = JSON.stringify(desc.identityPath)
  const keys = JSON.stringify(desc.identityEmailPath)
  return (
    `(location.origin === ${origin}) ` +
    `? fetch(${path},{credentials:'include',cache:'no-store'}).then((r)=>r.json())` +
    `.then((j)=>{let v=j;for(const k of ${keys}){v=(v!==null&&typeof v==='object')?v[k]:undefined}return typeof v==='string'?v:null})` +
    `.catch(()=>null) ` +
    `: Promise.resolve(null)`
  )
}

/** Read + sanitize the account email for `desc`'s service. Never throws. */
export async function readServiceAccountEmail(wc: EmailReadableWebContents, desc: WebServiceDescriptor): Promise<string | null> {
  return readEmailWith(wc, serviceEmailExpression(desc))
}

async function readEmailWith(wc: EmailReadableWebContents, expr: string): Promise<string | null> {
  return sanitizeAccountEmail(await evaluateIsolated(wc, expr))
}

/** Run an expression in an isolated world (a fallback for older environments),
 *  bounded in time. Never throws; null on any failure. */
async function evaluateIsolated(wc: EmailReadableWebContents, expr: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = typeof wc.executeJavaScriptInIsolatedWorld === 'function'
      ? wc.executeJavaScriptInIsolatedWorld(1, [{ code: expr }])
      : wc.executeJavaScript(expr, true)
    return await Promise.race([
      Promise.resolve(run),
      // Timer kept + cleared in finally so a resolved read does not leave a
      // 10 s handle alive (the poll fires this up to ~250 times over a sign-in).
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), IO_TIMEOUT_MS)
        if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The SHAPE of a service's identity answer: its HTTP status, whether it was a
 *  JSON object, its key NAMES two levels deep, and the key paths (up to three
 *  levels) whose value is shaped like an email. Never a value. */
export interface IdentityAnswerShape {
  status: number
  json: boolean
  keys: string[]
  /** Key names not shown: off the plain-name pattern, or shaped like an id or
   *  a secret (a map keyed by ids or tokens would otherwise log them). */
  keysDropped: number
  emailAt: string[]
}

/** What a shape read gives: the shape, the page was elsewhere, or nothing. */
export type IdentityShapeRead = IdentityAnswerShape | 'off-origin' | null

/**
 * For a sign-in that does not complete (the names-only diagnostic): the same
 * origin-gated request as the identity read, in an isolated world, returning
 * only the HTTP status, the answer's key NAMES (top level and one level below,
 * as `a` and `a.b`) and the key paths whose value is shaped like an email,
 * never a value. It lets one failed run show where the email actually sits, or
 * that the endpoint is wrong, without anything the answer holds (a token
 * included) crossing into the main process. A page elsewhere answers the
 * constant 'off-origin', unasked, so a caller can try again once it is back.
 */
export function serviceIdentityShapeExpression(desc: WebServiceDescriptor): string {
  const origin = JSON.stringify(desc.origin)
  const path = JSON.stringify(desc.identityPath)
  return (
    `(location.origin === ${origin}) ` +
    `? fetch(${path},{credentials:'include',cache:'no-store'}).then((r)=>r.text().then((t)=>{` +
    `let j=null;try{j=JSON.parse(t)}catch(e){j=null}` +
    `const o=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v);` +
    `const em=(v)=>typeof v==='string'&&/^[^\\s@]{1,128}@[^\\s@]{1,128}\\.[^\\s@]{1,64}$/.test(v);` +
    `const keys=[];const at=[];` +
    `if(o(j)){for(const k of Object.keys(j).slice(0,40)){keys.push(k);const v=j[k];if(em(v))at.push(k);` +
    `if(o(v)){for(const k2 of Object.keys(v).slice(0,40)){keys.push(k+'.'+k2);const w=v[k2];if(em(w))at.push(k+'.'+k2);` +
    `if(o(w)){for(const k3 of Object.keys(w).slice(0,40)){if(em(w[k3]))at.push(k+'.'+k2+'.'+k3)}}}}}}` +
    `return {status:r.status,json:o(j),keys:keys,emailAt:at.slice(0,5)}}))` +
    `.catch(()=>null) ` +
    `: Promise.resolve('off-origin')`
  )
}

/** One key name fit for a log line: a plain name (a letter, `_` or `$` first,
 *  at most 32 characters) that does not look like an id or a secret (a run of
 *  five digits, twelve hex digits, or a long name with three or more digits). */
function shapeKeyName(seg: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$-]{0,31}$/.test(seg)) return false
  if (/\d{5,}/.test(seg) || /[0-9a-f]{12,}/i.test(seg)) return false
  if (seg.length >= 16 && (seg.match(/\d/g)?.length ?? 0) >= 3) return false
  return true
}

/** A key path (`a`, `a.b`, `a.b.c`) whose every name is fit for a log line. */
function shapeKeyPath(p: unknown, depth: number): p is string {
  if (typeof p !== 'string' || p.length > 3 * 33) return false
  const segs = p.split('.')
  return segs.length >= 1 && segs.length <= depth && segs.every(shapeKeyName)
}

/** Read and validate the identity answer's shape. Never throws: the shape,
 *  'off-origin' when the page is elsewhere, or null when the request failed or
 *  the answer is not that shape. Key names off the pattern are dropped (and
 *  counted), not shown. */
export async function readServiceIdentityShape(wc: EmailReadableWebContents, desc: WebServiceDescriptor): Promise<IdentityShapeRead> {
  const v = await evaluateIsolated(wc, serviceIdentityShapeExpression(desc)) as Partial<IdentityAnswerShape> | 'off-origin' | null
  if (v === 'off-origin') return 'off-origin'
  if (!v || typeof v !== 'object') return null
  const status = v.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return null
  const raw = Array.isArray(v.keys) ? v.keys.slice(0, 1640) : []
  const keys = raw.filter((k) => shapeKeyPath(k, 2)).slice(0, 60) as string[]
  const emailAt = Array.isArray(v.emailAt) ? v.emailAt.filter((k) => shapeKeyPath(k, 3)).slice(0, 5) as string[] : []
  return { status, json: v.json === true, keys, keysDropped: raw.length - keys.length, emailAt }
}
