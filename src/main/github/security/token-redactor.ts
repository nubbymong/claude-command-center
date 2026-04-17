import { TOKEN_REDACTION_PATTERNS } from '../../../shared/github-constants'

/**
 * Redacts GitHub-token-shaped strings from a line of text.
 * Does NOT redact the public OAuth Client ID (`Ov23li...`) — that's a public
 * identifier and redacting it harms debuggability.
 */
export function redactTokens(line: string): string {
  let out = line
  for (const pattern of TOKEN_REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  return out
}

/**
 * Wraps a logging function so every string argument is passed through
 * `redactTokens`. Non-string arguments are passed through unchanged.
 */
export function wrapLogger<T extends (...args: unknown[]) => void>(logFn: T): T {
  return ((...args: unknown[]) => {
    const redacted = args.map((a) => (typeof a === 'string' ? redactTokens(a) : a))
    logFn(...redacted)
  }) as T
}
