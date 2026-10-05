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
 *  JSON object, and its key NAMES two levels deep. Never a value. */
export interface IdentityAnswerShape {
  status: number
  json: boolean
  keys: string[]
}

/**
 * For a sign-in that does not complete (the names-only diagnostic): the same
 * origin-gated request as the identity read, in an isolated world, returning
 * only the HTTP status and the answer's key NAMES (top level and one level
 * below, as `a` and `a.b`), never a value. It lets one failed run show where
 * the email actually sits, or that the endpoint is wrong, without anything the
 * answer holds (a token included) crossing into the main process.
 */
export function serviceIdentityShapeExpression(desc: WebServiceDescriptor): string {
  const origin = JSON.stringify(desc.origin)
  const path = JSON.stringify(desc.identityPath)
  return (
    `(location.origin === ${origin}) ` +
    `? fetch(${path},{credentials:'include',cache:'no-store'}).then((r)=>r.text().then((t)=>{` +
    `let j=null;try{j=JSON.parse(t)}catch(e){j=null}` +
    `const o=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v);const keys=[];` +
    `if(o(j)){for(const k of Object.keys(j).slice(0,40)){keys.push(k);const v=j[k];` +
    `if(o(v)){for(const k2 of Object.keys(v).slice(0,40)){keys.push(k+'.'+k2)}}}}` +
    `return {status:r.status,json:o(j),keys:keys}}))` +
    `.catch(()=>null) ` +
    `: Promise.resolve(null)`
  )
}

const SHAPE_KEY_RE = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64})?$/

/** Read and validate the identity answer's shape. Never throws; null when the
 *  page is elsewhere, the request failed, or the answer is not that shape.
 *  Key names off a conservative pattern are dropped, not shown. */
export async function readServiceIdentityShape(wc: EmailReadableWebContents, desc: WebServiceDescriptor): Promise<IdentityAnswerShape | null> {
  const v = await evaluateIsolated(wc, serviceIdentityShapeExpression(desc)) as Partial<IdentityAnswerShape> | null
  if (!v || typeof v !== 'object') return null
  const status = v.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return null
  const keys = Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string' && SHAPE_KEY_RE.test(k)).slice(0, 60) : []
  return { status, json: v.json === true, keys }
}
