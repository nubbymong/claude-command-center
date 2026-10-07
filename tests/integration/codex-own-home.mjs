// P4.8 (rows 59, 60; WP1.71): the codex-conformance job's own-home check
// (codex-conformance-ci.mjs own-home record|check), apart from that script,
// which acts on its arguments as soon as it is loaded, so the picture and the
// verdict are tested on every run of the suite (codex-own-home.test.ts). Plain
// JavaScript: the CI step runs it under Node without a TypeScript loader.
import { join } from 'node:path'

/** @typedef {{ isDirectory(): boolean, isSymbolicLink(): boolean, size: number, mtimeMs: number }} EntryStat */
/** @typedef {{ existsSync(p: string): boolean, readdirSync(p: string): string[], lstatSync(p: string): EntryStat }} PictureFs */

/** A read-only picture of `dir`: 'absent', 'empty', or one line per entry,
 *  by name at each level: a folder as `rel/`, anything else (a link
 *  included, never followed) as `rel size mtime`, the modified time in whole
 *  milliseconds.
 *  @param {string} dir @param {PictureFs} fs @returns {string} */
export function picture(dir, fs) {
  if (!fs.existsSync(dir)) return 'absent'
  /** @type {string[]} */
  const out = []
  /** @param {string} d @param {string} rel */
  const walk = (d, rel) => {
    for (const n of [...fs.readdirSync(d)].sort()) {
      const p = join(d, n)
      const r = rel ? `${rel}/${n}` : n
      const st = fs.lstatSync(p)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        out.push(`${r}/`)
        walk(p, r)
      } else out.push(`${r} ${st.size} ${Math.floor(st.mtimeMs)}`)
    }
  }
  walk(dir, '')
  return out.join('\n') || 'empty'
}

/** The check after the CLI's last run: `before` is the recorded picture, or
 *  null when no record was made (the record step did not run).
 *  @param {string | null} before @param {string} after @param {string} dir
 *  @returns {{ ok: boolean, message: string }} */
export function ownHomeVerdict(before, after, dir) {
  if (before === null || before === '') {
    return { ok: false, message: `no record of the runner's own ${dir} was made before the CLI was installed (the record step did not run), so it cannot be checked` }
  }
  if (after !== before) return { ok: false, message: `a run of the CLI used the runner's own ${dir}; before:\n${before}\nafter:\n${after}` }
  return { ok: true, message: `the runner's own ${dir} is as it was before the CLI was installed (${before === 'absent' ? 'absent' : 'unchanged'})` }
}
