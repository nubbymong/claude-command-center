// Where electron-builder caches the NSIS compiler, for installer-nsis-behaviour.test.ts.
// Read only: nothing here writes, and nothing here runs what it finds.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A version folder (nsis-3.0.4.1, nsis-3.0.4.1-1mx3n), not nsis-resources-<v>.
const NSIS_VERSION_DIR = /^nsis-\d/

/** Folder names of `dir` (none when it is missing or unreadable). */
function names(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * electron-builder's NSIS folders under its cache folder (`<LOCALAPPDATA>\electron-builder\Cache`),
 * newest name first, in both layouts it has used:
 *   - `Cache\nsis\nsis-<version>\` (before electron-builder 26);
 *   - `Cache\nsis-<version>\nsis-<version>-<random>\` (electron-builder 26).
 */
export function nsisCacheFolders(cacheDir: string): string[] {
  const out: string[] = []
  const byNewest = (list: string[]) => list.filter((n) => NSIS_VERSION_DIR.test(n)).sort().reverse()
  for (const v of byNewest(names(join(cacheDir, 'nsis')))) out.push(join(cacheDir, 'nsis', v))
  for (const v of byNewest(names(cacheDir))) {
    for (const inner of byNewest(names(join(cacheDir, v)))) out.push(join(cacheDir, v, inner))
  }
  return out
}

/** The first makensis.exe in `folders` (at the folder's top, else in its Bin folder). */
export function makensisIn(folders: string[]): string | null {
  for (const f of folders) {
    for (const exe of [join(f, 'makensis.exe'), join(f, 'Bin', 'makensis.exe')]) {
      if (existsSync(exe)) return exe
    }
  }
  return null
}

/**
 * Whether electron-builder has cached NSIS at all under `cacheDir`, in any layout: a
 * `nsis` folder, or a `nsis-<version>` one. The availability check fails when this is
 * true and no compiler was found, so a layout the locator does not know cannot turn the
 * behavioural cases into silent skips.
 */
export function nsisCachePresent(cacheDir: string): boolean {
  return existsSync(join(cacheDir, 'nsis')) || names(cacheDir).some((n) => NSIS_VERSION_DIR.test(n))
}
