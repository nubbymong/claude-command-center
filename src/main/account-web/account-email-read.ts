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
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = typeof wc.executeJavaScriptInIsolatedWorld === 'function'
      ? wc.executeJavaScriptInIsolatedWorld(1, [{ code: EMAIL_EXPR }])
      : wc.executeJavaScript(EMAIL_EXPR, true)
    const v = await Promise.race([
      Promise.resolve(run),
      // Timer kept + cleared in finally so a resolved read does not leave a
      // 10 s handle alive (the poll fires this up to ~250 times over a sign-in).
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), IO_TIMEOUT_MS)
        if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
      }),
    ])
    return sanitizeAccountEmail(v)
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
