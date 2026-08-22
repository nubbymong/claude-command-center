/**
 * desktop-import-schemas.ts — Zod schemas for the desktop-import IPC boundary,
 * split out of desktop-import-handlers.ts so they can be unit-tested WITHOUT
 * pulling in the handler module's electron/subprocess import graph (#209
 * adversarial review: the seam was the one untested boundary, precisely because
 * importing the handlers dragged in the whole main-process world).
 *
 * Dependency-light on purpose: zod + node:path + the shared size constant only.
 *
 * No default export (project convention).
 */

import { isAbsolute } from 'path'
import { z } from 'zod'
import { MAX_TRANSCRIPT_CHARS } from '../../shared/desktop-import'

// A pasted transcript is bounded at the IPC seam as well as in the parser — the
// parser truncates, but we never want a 100 MB string crossing the bridge first.
export const pasteSchema = z.string().min(1).max(MAX_TRANSCRIPT_CHARS + 1024)
export const urlSchema = z.string().min(1).max(2048)

/**
 * The transcript the renderer hands back for brief generation. It came FROM us,
 * but it round-tripped through the renderer, so it is re-validated as untrusted.
 *
 * SIZE BOUND (adversarial review, #209): the paste path is capped by pasteSchema
 * before it is ever parsed, but buildBrief takes a structured OBJECT straight
 * from the renderer, so it needs its own ceiling — otherwise a shape-valid
 * transcript (up to 20000 messages, each `text` unbounded) is a single-IPC-call
 * main-process OOM that takes down every session. Per-field `.max()` bounds any
 * one string, and the object-level `superRefine` bounds the CUMULATIVE size to
 * the same ceiling the paste path uses, evaluated before generateBrief allocates
 * anything.
 */
export const transcriptSchema = z.object({
  source: z.enum(['paste', 'share']),
  title: z.string().max(500).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['human', 'assistant', 'unknown']),
        text: z.string().max(MAX_TRANSCRIPT_CHARS),
        codeBlocks: z
          .array(z.object({ lang: z.string().max(50), code: z.string().max(MAX_TRANSCRIPT_CHARS) }))
          .max(2000),
      }),
    )
    .max(20000),
  messageCount: z.number().int().nonnegative(),
  codeBlockCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  roleMarkersDetected: z.boolean(),
  truncated: z.boolean(),
}).superRefine((t, ctx) => {
  let total = 0
  for (const m of t.messages) {
    total += m.text.length
    for (const c of m.codeBlocks) total += c.code.length
    if (total > MAX_TRANSCRIPT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `transcript exceeds the ${MAX_TRANSCRIPT_CHARS}-char ceiling`,
      })
      return
    }
  }
})

/**
 * writeBrief args. workingDirectory must be ABSOLUTE (or ~-anchored, which
 * resolveCwd expands to home). A bare relative string like `..` or `src` would
 * otherwise resolve against the MAIN PROCESS cwd (resolveCwd -> path.resolve),
 * writing the brief into an unintended directory rather than the session's — the
 * containment guard in writeBriefFile only pins the path under
 * `<root>/.claude/imports`, it cannot catch a wrong root (adversarial review,
 * #209). session.workingDirectory is absolute by construction everywhere it is
 * set, so this rejects only malformed input.
 */
export const writeBriefArgsSchema = z.object({
  workingDirectory: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => isAbsolute(p) || p === '~' || p.startsWith('~/') || p.startsWith('~\\'), {
      message: 'working directory must be an absolute path',
    }),
  markdown: z.string().min(1).max(4_000_000),
})
