// Verifies native modules are unpacked from the asar after packaging.
//
// The logging worker (better-sqlite3) and the PTY layer (node-pty) load .node
// binaries at runtime via require(). If electron-builder's asar packing does NOT
// unpack them (the auto-detection has historically missed transitive .node's),
// the packaged app fails ONLY at runtime with ERR_DLOPEN_FAILED / module-not-found
// — invisible to the build. This asserts the binaries are present under
// app.asar.unpacked so a broken package is caught in CI, not by a user.
//
// Run AFTER a package build (e.g. `npm run package` or `npm run package:win`,
// which emit dist/win-unpacked/...). Cross-platform: searches dist/ for the
// app.asar.unpacked tree so it also works for the macOS layout.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distDir = resolve(process.cwd(), 'dist')

// Native binaries that MUST be unpacked. better-sqlite3 is the new logging dep;
// node-pty has shipped for ages but we assert it too so a regression is caught.
//
// Each module has TWO layouts that satisfy it, matching its own loader's search
// order: an electron-rebuild output (`build/Release`, what CI produces) OR the
// N-API prebuild the package itself ships (what a no-toolchain local build
// packages — both loaders prefer/fall back across these at runtime). Either
// present-and-holding-a-.node is a loadable package; neither is a broken one.
const REQUIRED = [
  [
    'better-sqlite3',
    [
      join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      join('better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`),
    ],
  ],
  [
    'node-pty',
    [
      join('node-pty', 'build', 'Release'), // dir; pty.node/conpty.node name varies by platform
      join('node-pty', 'prebuilds', `${process.platform}-${process.arch}`),
    ],
  ],
]

/** Find every `app.asar.unpacked/node_modules` dir under dist/ (win + mac layouts). */
function findUnpackedNodeModules(root) {
  const found = []
  function walk(dir, depth) {
    if (depth > 8 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (e.name === 'app.asar.unpacked') {
        const nm = join(full, 'node_modules')
        if (existsSync(nm)) found.push(nm)
        continue // don't descend into the unpacked tree
      }
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

if (!existsSync(distDir)) {
  console.error('[verify-native-unpack] dist/ not found — run `npm run package` first.')
  process.exit(1)
}

const nmDirs = findUnpackedNodeModules(distDir)
if (nmDirs.length === 0) {
  console.error('[verify-native-unpack] No app.asar.unpacked/node_modules found under dist/. Is asar enabled and a package built?')
  process.exit(1)
}

/** A candidate satisfies its module if it exists and (for a dir) holds a .node
 *  somewhere below it — node-pty nests its per-arch prebuilds one level down. */
function holdsNativeBinary(target) {
  if (!existsSync(target)) return false
  if (!statSync(target).isDirectory()) return true
  let entries
  try { entries = readdirSync(target, { withFileTypes: true }) } catch { return false }
  return entries.some((e) => (e.isDirectory() ? holdsNativeBinary(join(target, e.name)) : e.name.endsWith('.node')))
}

let ok = true
for (const nm of nmDirs) {
  for (const [label, candidates] of REQUIRED) {
    const satisfied = candidates.find((rel) => holdsNativeBinary(join(nm, rel)))
    if (satisfied) {
      console.log(`[verify-native-unpack] ${label}: OK  (${join(nm, satisfied)})`)
    } else {
      ok = false
      console.log(`[verify-native-unpack] ${label}: MISSING  (looked at: ${candidates.map((rel) => join(nm, rel)).join(' | ')})`)
    }
  }
}

if (!ok) {
  console.error('[verify-native-unpack] FAIL — a required native binary is not unpacked. Check "asarUnpack" in package.json build config.')
  process.exit(1)
}
console.log('[verify-native-unpack] PASS — native binaries unpacked.')
