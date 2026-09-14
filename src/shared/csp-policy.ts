// Single source of truth for the app renderer's Content-Security-Policy.
//
// It is applied TWO ways, and must be:
//   1. sent as a response header via session.defaultSession.webRequest
//      .onHeadersReceived in src/main/index.ts — this reaches the renderer
//      ONLY in dev (loadURL → http://localhost); a header cannot reach a
//      file:// document, so in a packaged build it does nothing.
//   2. embedded as a <meta http-equiv="Content-Security-Policy"> in
//      src/renderer/index.html — the parser enforces this regardless of
//      scheme, so it is what actually protects the PACKAGED (file://) renderer.
//
// Keep the <meta> in src/renderer/index.html byte-identical to this string;
// tests/unit/renderer/csp-policy-sync.test.ts fails if they drift.
//
// Directive notes:
//   script-src 'self' 'wasm-unsafe-eval' — the app's own hashed chunks are
//     same-origin ('self' matches them on file:// too); 'wasm-unsafe-eval'
//     (NOT the far broader 'unsafe-eval') lets Excalidraw's image pipeline
//     (pica / image-blob-reduce / font subsetting) compile WebAssembly. It
//     does not permit JS eval, so injected script is still blocked.
//   worker-src 'self' blob: data: — pica spins up its resize workers from
//     blob:/data: URLs; without this they fall back to a slow main-thread path.
//   style-src 'unsafe-inline' — React style={{…}} and injected <style> tags.
//   font-src 'self' — app fonts and Excalidraw's fonts are bundled locally
//     (public/excalidraw-assets, via EXCALIDRAW_ASSET_PATH in main.tsx); no
//     remote font origin is relied upon. Excalidraw would otherwise fetch ~15
//     font families from esm.sh on every canvas open — this policy blocks that,
//     and the local bundle makes it unnecessary. (data:/gstatic are unused
//     headroom kept only so this string matches the dev header verbatim.)
//   connect-src is IPC-routed in this app (the renderer makes no direct remote
//     request), so 'self' + localhost is ample; no remote origin is allowed.
//   frame-src ccc-ux: — the Agent Canvas content iframe. ccc-ux:// is the
//     app's own privileged scheme, served by the main process from the canvas
//     store (no localhost server, no open port); nothing else may be framed
//     (there is deliberately no 'self' / http entry here, so the renderer can
//     never frame itself or a remote page).
//   object-src 'none' / base-uri 'self' / form-action 'self' — defense-in-depth
//     backstops (no <object>/<embed>, no <base> hijack, no cross-origin form
//     post) for if the one DOMPurify-gated HTML sink is ever bypassed; the
//     renderer uses none of these today, so they cost nothing.
export const CSP_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "worker-src 'self' blob: data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: file:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' ws://localhost:* http://localhost:*; " +
  "frame-src ccc-ux:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"
