// The two in-page scripts ccc-ux:// serves are esbuild bundles produced at
// build time by scripts/vite-plugin-canvas-bridge.mjs, which is registered in
// electron.vite.config.ts and vitest.config.ts. Each virtual module resolves to
// the bundled source as a string. The main-process tsconfig types only ["node"],
// so the declarations live here rather than coming from vite/client.

declare module 'virtual:canvas-bridge' {
  /** The lean always-injected bridge (IIFE). */
  const source: string
  export default source
}

declare module 'virtual:canvas-analysis' {
  /** The axe-core analysis chunk (ESM), imported by the bridge on demand. */
  const source: string
  export default source
}
