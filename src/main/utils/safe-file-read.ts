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
//     A file legitimately written inside a project has exactly one name, so a
//     link count above 1 is refused — and a link count that the filesystem
//     does not report is refused too, because a guard that silently skips on
//     an unusual volume is not a guard.
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

/**
 * Open once, check the fd, read the fd. Throws on anything that is not a
 * single-named regular file within `maxBytes`; the throw carries no path.
 */
export function readCheckedFile(filePath: string, maxBytes: number): Buffer {
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
    if (typeof st.nlink !== 'number' || !Number.isFinite(st.nlink) || st.nlink !== 1) {
      throw new Error(NOT_REGULAR)
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
