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

// The account whose authenticated claude.ai partition a share fetch runs on
// (#216). Must match webPartitionForProfile's own guard exactly — the value is
// interpolated into the partition name `persist:claude-web-<profileId>`, so a
// loose id would be a partition-name injection. Optional: the default account
// has no per-profile web session and fetches public shares only.
export const profileIdSchema = z.string().regex(/^profile-[a-z0-9-]{1,64}$/)

/** Args for the share-import IPC channel: the link, plus the optional account. */
export const fromShareArgsSchema = z.object({
  url: urlSchema,
  profileId: profileIdSchema.optional(),
})

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
// Per-object cost added to the cumulative sum so the ceiling bounds the OBJECT
// GRAPH, not just its characters (adversarial review re-attack, #209): a
// transcript of 20000 messages x 2000 empty code-blocks passes a char-only cap
// while carrying tens of millions of objects. Counting a fixed cost per message
// and per code-block (plus title/lang lengths) makes such a payload trip the same
// ceiling. The array `.max()`es are also tightened from the original 20000/2000
// to bound the count directly. NOTE: this is defence-in-depth only — Electron
// structured-clone deserializes the object graph in the main process BEFORE zod
// runs, so a truly enormous payload strains transport first; the real reach here
// is a compromised renderer, and this keeps the guard's promise honest for the
// payloads that do survive deserialize.
const OBJECT_COST = 256
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
          .max(500),
      }),
    )
    .max(5000),
  messageCount: z.number().int().nonnegative(),
  codeBlockCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  roleMarkersDetected: z.boolean(),
  truncated: z.boolean(),
}).superRefine((t, ctx) => {
  const bail = (): void => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `transcript exceeds the ${MAX_TRANSCRIPT_CHARS}-char ceiling`,
    })
  }
  let total = (t.title?.length ?? 0)
  for (const m of t.messages) {
    total += m.text.length + OBJECT_COST
    for (const c of m.codeBlocks) total += c.code.length + c.lang.length + OBJECT_COST
    if (total > MAX_TRANSCRIPT_CHARS) { bail(); return }
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
