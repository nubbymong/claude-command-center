/**
 * Deploy `scripts/codex-resume-picker.js` plus its helper lib into
 * `<resourcesDir>/scripts/`. Mirrors `deployClaudeResumePickerScript`.
 *
 * electron-vite bundles all `src/main/**\/*.ts` into a single `out/main/index.js`,
 * so `__dirname` at runtime is always `out/main/` regardless of original source
 * location. The default `path.join(__dirname, '../../scripts/...')` hops two
 * directories up from `out/main/` to the build root (sibling of `out/`), then
 * into `scripts/` -- where electron-builder copies the picker scripts via
 * `package.json` `build.files`. In dev (vitest) `__dirname` resolves to the
 * source file's directory, so the same join lands at
 * `<repo>/src/main/scripts/` -- which is empty in the source tree (the
 * pickers actually live at `<repo>/scripts/`), so an unredirected dev call
 * silently no-ops via the `existsSync` guard. Tests inject `sourceRoot` to
 * point at a per-test temp dir instead.
 */
import * as fs from 'fs'
import * as path from 'path'

/**
 * @param resourcesDir Destination resources directory.
 * @param sourceRoot   Optional override for the source-script lookup root. The
 *   default uses the `__dirname`-relative path described in the file header.
 *   Tests inject a per-test temp dir to avoid races on the shared
 *   `<repo>/src/main/scripts/` path under vitest's parallel file runner.
 */
export async function deployCodexResumePickerScript(resourcesDir: string, sourceRoot?: string): Promise<void> {
  const resourcesScriptsDir = path.join(resourcesDir, 'scripts')
  if (!fs.existsSync(resourcesScriptsDir)) {
    fs.mkdirSync(resourcesScriptsDir, { recursive: true })
  }
  const resourcesLibDir = path.join(resourcesScriptsDir, 'lib')
  if (!fs.existsSync(resourcesLibDir)) {
    fs.mkdirSync(resourcesLibDir, { recursive: true })
  }

  const pickerSrc = sourceRoot
    ? path.join(sourceRoot, 'scripts/codex-resume-picker.js')
    : path.join(__dirname, '../../scripts/codex-resume-picker.js')
  const libSrc = sourceRoot
    ? path.join(sourceRoot, 'scripts/lib/codex-resume-picker-lib.js')
    : path.join(__dirname, '../../scripts/lib/codex-resume-picker-lib.js')

  if (fs.existsSync(pickerSrc)) {
    fs.copyFileSync(pickerSrc, path.join(resourcesScriptsDir, 'codex-resume-picker.js'))
  }
  if (fs.existsSync(libSrc)) {
    fs.copyFileSync(libSrc, path.join(resourcesLibDir, 'codex-resume-picker-lib.js'))
  }
}
