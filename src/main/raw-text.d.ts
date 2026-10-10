// A file's own text, imported with Vite's `?raw` suffix (electron-vite builds
// the main process with Vite, and vitest resolves the same suffix). Used for
// the first-start worker (first-start-warmup.ts, ADR-025), which runs as an
// eval worker so nothing is loaded from the app archive at run time. The
// main-process tsconfig types only ["node"], so the declaration lives here
// rather than coming from vite/client.
declare module '*.cjs?raw' {
  const text: string
  export default text
}
