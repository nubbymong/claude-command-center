// README staging: the fictional Codex accounts (content.js CODEX_ACCOUNTS)
// written into the app's account registry with the app's own registry
// transitions (scripts/capture-seed.ts buildCodexRegistry), plus each
// account's folder and, for an account that keeps them, Codex's own memory
// files (content.js CODEX_MEMORIES). seed.js bundles it with the checkout's
// own esbuild (pinned by the lockfile) into the staging root's runner folder
// and runs it with node:
//
//   node <root>/runner/codex-registry.cjs <resources dir> <content.js>
//
// Writes only under <resources dir>/providers and <resources dir>/codex-realms,
// which seed.js has checked are inside the staging root (stage-root.js).
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { buildCodexRegistry, type CodexSeedAccount } from '../../capture-seed'

const [resourcesDir, contentPath] = process.argv.slice(2)
if (!resourcesDir || !contentPath || !path.isAbsolute(resourcesDir)) {
  console.error('usage: codex-registry.ts <absolute resources dir> <content.js>')
  process.exit(2)
}
const contentFile = path.resolve(contentPath)
const C = createRequire(contentFile)(contentFile) as {
  CODEX_ACCOUNTS: CodexSeedAccount[]
  CODEX_MEMORIES: Record<string, string>
}

const doc = buildCodexRegistry(C.CODEX_ACCOUNTS, Date.now())
fs.mkdirSync(path.join(resourcesDir, 'providers'), { recursive: true })
fs.writeFileSync(path.join(resourcesDir, 'providers', 'registry.json'), JSON.stringify(doc, null, 2))
for (const a of C.CODEX_ACCOUNTS) {
  const realm = path.join(resourcesDir, 'codex-realms', a.realmId)
  fs.mkdirSync(realm, { recursive: true })
  if (!a.memories) continue
  for (const [name, text] of Object.entries(C.CODEX_MEMORIES)) {
    const file = path.join(realm, 'memories', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  }
}
console.log(`codex accounts written: ${C.CODEX_ACCOUNTS.length} (registry + folders)`)
