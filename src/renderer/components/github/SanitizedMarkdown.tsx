import { renderCommentMarkdown } from '../../utils/markdownSanitizer'

/**
 * Single audited render site for sanitized markdown — shared by the GitHub
 * sidebar and the Logs v2 transcript viewer.
 *
 * Per spec §9: `dangerouslySetInnerHTML` is forbidden everywhere except in
 * this component. Callers pass raw markdown via `source`; this component runs
 * it through a sanitize function (default `renderCommentMarkdown`, which
 * restricts URL schemes to `https:` only and strips `<img>` / inline event
 * handlers) before rendering. Transcript callers pass `render={renderTranscriptMarkdown}`,
 * which uses the IDENTICAL allowlist — the carve-out is the same regardless of
 * source so the audit surface stays a single component.
 *
 * Anchor click routing: the renderer blocks `will-navigate` and `window.open`
 * is denied via `setWindowOpenHandler`, so raw `<a href>` links would be
 * inert. The delegated `onClick` here intercepts anchor clicks, validates
 * `https:`, and routes through `window.electronAPI.shell.openExternal`.
 * Non-https anchors are inert by design (the sanitizer already strips them).
 */
export function SanitizedMarkdown({
  source,
  render = renderCommentMarkdown,
  className = 'prose prose-invert text-sm max-w-none',
}: {
  source: string
  render?: (md: string) => string
  className?: string
}) {
  const html = render(source)
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
        if (!anchor) return
        e.preventDefault()
        const href = anchor.getAttribute('href') ?? ''
        if (/^https:/i.test(href)) {
          // `void` + `.catch` so an IPC rejection during app teardown doesn't
          // surface as an unhandled promise rejection on a plain click.
          void window.electronAPI.shell.openExternal(href).catch(() => {})
        }
      }}
    />
  )
}
