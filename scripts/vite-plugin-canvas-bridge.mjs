// Bundles the Agent Canvas in-page scripts into self-contained IIFE strings.
//
// The bridge stopped being hand-written page JS at P2: it now composes
// dom-accessibility-api (accessible names) and axe-core (rules) with the
// measurement pass, so it has to be BUNDLED before ccc-ux:// can serve it as
// one classic script into the content frame.
//
// Two virtual modules, each resolving to `export default "<bundled source>"`:
//   virtual:canvas-bridge    — the lean always-injected bridge
//   virtual:canvas-analysis  — the axe-core chunk, pulled in on first analysis
//
// Registered in electron.vite.config.ts (dev + build) and vitest.config.ts, so
// the string the tests drive is byte-for-byte the string the app serves.
// Nothing is generated into the tree: no committed bundle to review-by-diff.

import { build } from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ENTRIES = {
  'virtual:canvas-bridge': {
    entry: 'src/main/canvas/bridge/index.ts',
    // Left readable: it is ~50 KB, and a legible bundle is worth more in
    // devtools (and in review) than the bytes.
    minify: false,
  },
  'virtual:canvas-analysis': {
    entry: 'src/main/canvas/bridge/analysis.ts',
    // axe-core is ~500 KB unminified and is parsed inside the content frame.
    minify: true,
  },
}

async function bundleEntry({ entry, minify }) {
  const result = await build({
    entryPoints: [path.resolve(ROOT, entry)],
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    platform: 'browser',
    // The content frame is Electron's Chromium — no downlevelling needed, and
    // a modern target keeps both bundles small.
    target: ['chrome124'],
    minify,
    // MPL-2.0 (axe-core) and MIT (dom-accessibility-api) attribution rides in
    // the served artifact, not just in THIRD-PARTY-NOTICES.
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  return {
    code: result.outputFiles[0].text,
    inputs: Object.keys(result.metafile.inputs).map((p) => path.resolve(ROOT, p)),
  }
}

export function canvasBridgePlugin() {
  return {
    name: 'ccc-canvas-bridge',
    resolveId(id) {
      return Object.prototype.hasOwnProperty.call(ENTRIES, id) ? '\0' + id : null
    },
    async load(id) {
      if (!id.startsWith('\0')) return null
      const key = id.slice(1)
      const spec = ENTRIES[key]
      if (!spec) return null
      const { code, inputs } = await bundleEntry(spec)
      // esbuild owns this dependency graph, so Vite has to be told what to
      // watch or editing a bridge module would not reload the app in dev.
      for (const input of inputs) this.addWatchFile(input)
      return `export default ${JSON.stringify(code)}`
    },
  }
}
