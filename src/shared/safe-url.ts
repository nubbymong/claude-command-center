/**
 * Normalize an external URL for shell.openExternal — https only.
 *
 * SECURITY CONTROL. shell.openExternal hands the string to the OS URL handler;
 * non-https schemes (file:, javascript:, data:, ms-msdt:, shell:, ...) can
 * launch local handlers or execute code. A raw `startsWith('https://')` prefix
 * check neither rejects those reliably nor normalizes the value. Parse with the
 * WHATWG URL parser, require the https scheme, and return the canonical href so
 * only a clean, fully-parsed URL is ever handed to the OS.
 */
export function safeExternalHttpsHref(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return parsed.href
}
