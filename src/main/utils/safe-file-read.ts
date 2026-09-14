// Read a file the way an authorization boundary has to: the object that was
// CHECKED is the object that is READ.
//
// Every caller here has already decided a PATH is allowed (a canvas root, a
// project directory). That decision is about a path; the read is about an
// inode, and on Windows the two are not the same thing:
//
//   - TOCTOU. `statSync(p)` followed by `readFileSync(p)` resolves the path
//     TWICE. Between them the name can be re-pointed at something else — the
//     checks then describe a file that is not the file whose bytes come back.
//     Opening once and doing every check on that fd closes the gap by
//     construction rather than by racing it.
//   - HARD LINKS. `mklink /H` needs no privilege and no Developer Mode, and a
//     link planted inside an allowed directory resolves to ITSELF — realpath
//     sees a file that really does live under the root, so every containment
//     layer passes while the bytes belong to `~/.claude/.credentials.json`.
//     An adversarial pass (2026-08-15) walked an OAuth token out through one.
//     A file legitimately AUTHORED inside a project has exactly one name, so a
//     link count above 1 is refused — and a link count that the filesystem
//     does not report is refused too, because a guard that silently skips on
//     an unusual volume is not a guard.
//
// "Legitimately authored" is doing work in that last sentence, and the refusal
// is therefore OPT-OUTABLE (`requireSingleLink`). Build OUTPUT is routinely
// multiply linked — pnpm's content-addressed store, `cp -al`, Nx/Turbo/Bazel
// cache restores — so applying the refusal to every subordinate asset of a
// served dist turned an ordinary monorepo build into a page whose assets all
// 404'd. The opt-out is per call and per file, never a global mode, and it is
// never taken for the two objects the boundary exists for: the entry document
// and the model-named htmlPath.
//
// The residual is stated rather than hidden: an attacker who hard-links a
// secret into the root and then DELETES the original leaves a file whose only
// name is inside the root, which is indistinguishable from a file that was
// always there. Nothing in a link count can see that; what stops it is that
// the root is the session's own project directory and never the home dir.

import * as fs from 'fs'

/** Refusals share one message on purpose: the callers relay a closed operator
 *  vocabulary to the model, and which check tripped is not the model's
 *  business. `/not a regular file/` is the shape the canvas tool maps. */
const NOT_REGULAR = 'not a regular file'

export interface ReadCheckedFileOptions {
  /**
   * Refuse a file with more than one name — or one whose volume will not report
   * a link count. DEFAULT TRUE: every authorization-boundary caller wants it,
   * and a caller that opts out has to say so.
   *
   * Opting out is for content whose multiplicity is EXPECTED and benign. Build
   * output is the case: pnpm's store, `cp -al`, and Nx/Turbo/Bazel cache
   * restores all populate `dist/` with hard links, so a blanket refusal turned
   * an ordinary monorepo build into a UAT page whose every asset 404'd with no
   * diagnosis. What must never opt out is the thing the boundary is actually
   * about — the entry DOCUMENT (injected with the bridge, read back out of the
   * DOM by canvas_snapshot) and `readDesignFile`'s model-named `htmlPath`.
   */
  requireSingleLink?: boolean
  /** Called instead of throwing when `requireSingleLink` is false and the count
   *  is not 1 (null = the volume reported none). The caller logs it: a check
   *  that is deliberately not enforced still has to be visible. */
  onLinkAnomaly?: (nlink: number | null) => void
}

/**
 * Open once, check the fd, read the fd. Throws on anything that is not a
 * regular file within `maxBytes`; the throw carries no path.
 */
export function readCheckedFile(filePath: string, maxBytes: number, options?: ReadCheckedFileOptions): Buffer {
  const requireSingleLink = options?.requireSingleLink !== false
  // May throw (ENOENT / EACCES / EISDIR): the caller's catch turns it into the
  // same refusal every other miss produces.
  const fd = fs.openSync(filePath, 'r')
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new Error(NOT_REGULAR)
    // Fail CLOSED when the count is unavailable. The previous check read
    // `typeof st.nlink === 'number' && st.nlink !== 1`, which skipped itself
    // entirely on any volume that does not report link counts — the guard
    // disappeared exactly where it was hardest to notice.
    const nlink = typeof st.nlink === 'number' && Number.isFinite(st.nlink) ? st.nlink : null
    if (nlink !== 1) {
      if (requireSingleLink) throw new Error(NOT_REGULAR)
      try {
        options?.onLinkAnomaly?.(nlink)
      } catch {
        /* a reporting failure must not sink the read */
      }
    }
    if (st.size > maxBytes) throw new Error('file too large')
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < buf.length) {
      // Explicit position: a partial read never re-reads or skips, and the fd
      // is ours alone so nothing else moves the cursor.
      const n = fs.readSync(fd, buf, off, buf.length - off, off)
      if (n <= 0) break // the file shrank under us; return what was really there
      off += n
    }
    return off === buf.length ? buf : buf.subarray(0, off)
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* already gone */
    }
  }
}
