import { renderCommentMarkdown } from '../../utils/markdownSanitizer'

/**
 * Single audited render site for sanitized GitHub markdown.
 *
 * Per spec §9: `dangerouslySetInnerHTML` is forbidden everywhere in the GitHub
 * sidebar feature except in this component. Callers pass raw markdown via
 * `source`; this component runs it through `renderCommentMarkdown` (which
 * restricts URL schemes to `https:` only and strips `<img>` / inline event
 * handlers) before rendering.
 *
 * Anchor click routing: the renderer blocks `will-navigate` and `window.open`
 * is denied via `setWindowOpenHandler`, so raw `<a href>` links would be
 * inert. The delegated `onClick` here intercepts anchor clicks, validates
 * `https:`, and routes through `window.electronAPI.shell.openExternal`.
 * Non-https anchors are inert by design (the sanitizer already strips them).
 */
export function SanitizedMarkdown({ source }: { source: string }) {
  const html = renderCommentMarkdown(source)
  return (
    <div
      className="prose prose-invert text-sm max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
        if (!anchor) return
        e.preventDefault()
        const href = anchor.getAttribute('href') ?? ''
        if (/^https:/i.test(href)) {
          window.electronAPI.shell.openExternal(href)
        }
      }}
    />
  )
}
