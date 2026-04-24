// Redacts secrets from Claude Code hook payloads before the payload is
// stored in the ring buffer or emitted over IPC.
//
// Raw hook payloads can contain file contents, env values, diffs, API
// keys, and private keys. DevTools on the renderer can inspect IPC
// messages, so this redaction is non-negotiable per the design spec
// (§Schemas, §Security).
//
// All quantifiers are bounded ({n,M}) to defeat ReDoS on adversarial
// inputs. 512 chars is well over any legitimate token length.

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_\-]{32,512}/g, '[REDACTED]'],
  [/xox[bpsar]-[A-Za-z0-9-]{10,256}/g, '[REDACTED]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{30,256}/g, '[REDACTED]'],
  [
    /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/g,
    '[REDACTED]',
  ],
  [
    /((?:password|secret|token|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"'&]{3,512}\2/gi,
    '$1[REDACTED]',
  ],
]

function redactString(s: string): string {
  let out = s
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

export function redactHookPayload<T>(payload: T): T {
  const seen = new WeakSet<object>()

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value as object)) return value
    seen.add(value as object)
    if (Array.isArray(value)) return value.map(walk)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v)
    }
    return out
  }

  return walk(payload) as T
}
