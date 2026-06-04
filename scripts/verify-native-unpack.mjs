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
const REQUIRED = [
  ['better-sqlite3', join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node')],
  ['node-pty', join('node-pty', 'build', 'Release')], // dir; pty.node/conpty.node name varies by platform
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

let ok = true
for (const nm of nmDirs) {
  for (const [label, rel] of REQUIRED) {
    const target = join(nm, rel)
    const present = existsSync(target)
    // For the node-pty dir entry, also require at least one .node inside it.
    let detail = present ? 'OK' : 'MISSING'
    if (present && statSync(target).isDirectory()) {
      const hasNode = readdirSync(target).some((f) => f.endsWith('.node'))
      if (!hasNode) { detail = 'MISSING (.node)'; ok = false }
    } else if (!present) {
      ok = false
    }
    console.log(`[verify-native-unpack] ${label}: ${detail}  (${target})`)
  }
}

if (!ok) {
  console.error('[verify-native-unpack] FAIL — a required native binary is not unpacked. Check "asarUnpack" in package.json build config.')
  process.exit(1)
}
console.log('[verify-native-unpack] PASS — native binaries unpacked.')
