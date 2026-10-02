// P3.15 (row 71), PR-level ADR-009 round 1 (D5): a Windows package must ship the
// ConPTY a PTY runs under when it asks for node-pty's bundled one: node-pty's
// conpty.dll and the OpenConsole.exe beside it, in the `conpty` folder next to
// the conpty.node node-pty loads. src/main/bundled-conpty.ts looks for them
// there, in node-pty's loader order (build/Release, build/Debug, then the
// prebuild for the platform and arch; each beside node-pty's lib folder, then
// inside it), and falls back to the system ConPTY when either is missing, which
// keeps no scrollback for a full-screen program. verify-native-unpack.mjs fails
// the package on any problem this returns. Off Windows there is nothing to check.
//
// Pure: `isFile` is the only file system access (injectable for the unit test).
import { statSync } from 'node:fs'
import { join } from 'node:path'

function isFileOnDisk(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** The folders node-pty's loader tries for a native module, in its order. */
export function nodePtyNativeDirs(nodePtyDir, platform, arch) {
  const out = []
  for (const d of [join('build', 'Release'), join('build', 'Debug'), join('prebuilds', `${platform}-${arch}`)]) {
    for (const r of ['.', 'lib']) out.push(join(nodePtyDir, r, d))
  }
  return out
}

/** What is wrong with the bundled ConPTY under one unpacked node_modules
 *  folder: an empty list when it is whole (or off Windows). */
export function bundledConptyProblems(nodeModulesDir, platform = process.platform, arch = process.arch, isFile = isFileOnDisk) {
  if (platform !== 'win32') return []
  const dir = nodePtyNativeDirs(join(nodeModulesDir, 'node-pty'), platform, arch).find((d) => isFile(join(d, 'conpty.node')))
  if (!dir) return [`node-pty's conpty.node was not found for win32-${arch}`]
  return ['conpty.dll', 'OpenConsole.exe']
    .map((f) => join(dir, 'conpty', f))
    .filter((p) => !isFile(p))
    .map((p) => `${p} is missing`)
}
