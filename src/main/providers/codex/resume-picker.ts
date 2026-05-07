/**
 * Deploy `scripts/codex-resume-picker.js` plus its helper lib into
 * `<resourcesDir>/scripts/`. Mirrors `deployClaudeResumePickerScript`.
 *
 * electron-vite bundles all `src/main/**\/*.ts` into a single `out/main/index.js`,
 * so `__dirname` is always `out/main/` regardless of original source location.
 * The scripts live one directory up at `out/scripts/`.
 */
import * as fs from 'fs'
import * as path from 'path'

export async function deployCodexResumePickerScript(resourcesDir: string): Promise<void> {
  const resourcesScriptsDir = path.join(resourcesDir, 'scripts')
  if (!fs.existsSync(resourcesScriptsDir)) {
    fs.mkdirSync(resourcesScriptsDir, { recursive: true })
  }
  const resourcesLibDir = path.join(resourcesScriptsDir, 'lib')
  if (!fs.existsSync(resourcesLibDir)) {
    fs.mkdirSync(resourcesLibDir, { recursive: true })
  }

  const pickerSrc = path.join(__dirname, '../../scripts/codex-resume-picker.js')
  const libSrc = path.join(__dirname, '../../scripts/lib/codex-resume-picker-lib.js')

  if (fs.existsSync(pickerSrc)) {
    fs.copyFileSync(pickerSrc, path.join(resourcesScriptsDir, 'codex-resume-picker.js'))
  }
  if (fs.existsSync(libSrc)) {
    fs.copyFileSync(libSrc, path.join(resourcesLibDir, 'codex-resume-picker-lib.js'))
  }
}
