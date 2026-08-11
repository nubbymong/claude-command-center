// The main-process tsconfig types only ["node"] — it has no vite/client, so
// Vite's `?raw` asset imports (used to bundle the canvas bridge script as a
// string) need this local declaration. electron-vite and vitest both resolve
// `?raw` natively at build/test time.
declare module '*?raw' {
  const content: string
  export default content
}
