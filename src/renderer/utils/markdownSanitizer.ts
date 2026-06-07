import { marked } from 'marked'
import createDOMPurify from 'dompurify'
// Plain `dompurify` instead of `isomorphic-dompurify` because the renderer
// runs in Electron's real DOM — the isomorphic variant dragged jsdom into
// the renderer bundle. Unit tests opt into a DOM via `@vitest-environment
// jsdom` in the sanitizer test file. `dompurify` v3's default export is a
// factory — we bind it to the runtime window once at module load.
const DOMPurify = createDOMPurify(window)

marked.setOptions({ breaks: true, gfm: true })

// No <img>: app CSP is `img-src 'self' data: file:` so remote https images
// would not render; loosening CSP would expose a remote-image attack surface
// from untrusted GitHub comment content. Inline images in markdown source are
// dropped by DOMPurify since <img> isn't in the allowlist.
// No <table>: reviews/PRs rarely need tables and the simpler allowlist leaves
// less attack surface.
const ALLOWED_TAGS = [
  'a',
  'p',
  'br',
  'em',
  'strong',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'del',
  's',
]
const ALLOWED_ATTR = ['href', 'title']

/**
 * The single hardened sanitize pipeline shared by every markdown render site.
 *
 * Link scheme policy: `https:` only on `<a href>`. `http:`, `mailto:`, bare
 * fragment `#`, `javascript:`, and everything else is stripped. The renderer
 * blocks `will-navigate` and `window.open`, so the only navigation that
 * actually works is `shell.openExternal(https://...)` invoked from main.
 */
function sanitizeMarkdown(md: string): string {
  if (typeof md !== 'string') return ''
  const raw = marked.parse(md) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^https:/i,
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  })
}

/**
 * Sanitizes a GitHub markdown comment body for render.
 *
 * Callers MUST pass the output through the single audited render site
 * `SanitizedMarkdown` — see spec §9 for the `dangerouslySetInnerHTML`
 * carve-out and delegated anchor click handler.
 */
export function renderCommentMarkdown(md: string): string {
  return sanitizeMarkdown(md)
}

/**
 * Sanitizes a Claude Code transcript message body for render (Logs v2).
 *
 * Uses the EXACT same pipeline + allowlist as `renderCommentMarkdown` — the
 * allowlist is not loosened because transcript content is equally untrusted
 * (it is whatever the model and the user typed). Same single audited render
 * site `SanitizedMarkdown`.
 */
export function renderTranscriptMarkdown(md: string): string {
  return sanitizeMarkdown(md)
}
