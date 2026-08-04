// Point Excalidraw at locally-bundled fonts instead of its esm.sh CDN default.
//
// This MUST run before @excalidraw/excalidraw evaluates. Excalidraw bakes each
// font's src URL from window.EXCALIDRAW_ASSET_PATH the first time its font
// registry initializes, which happens during module evaluation of the library —
// and App statically imports it (App.tsx → ExcalidrawPane → @excalidraw). ES
// `import` statements evaluate before the importing module's body, so an
// assignment in main.tsx's body (after `import App`) runs too late and the URLs
// get baked pointing at esm.sh. Keeping this in its own module, imported as the
// FIRST line of main.tsx, guarantees the global is set first.
//
// Resolved against document.baseURI so it is an absolute file:// (packaged) or
// http://localhost (dev) URL — not a "/"-rooted path, which Excalidraw would
// re-resolve against the origin (opaque on file://). The Latin families live in
// public/excalidraw-assets/; the ~13MB CJK Xiaolai family is intentionally not
// bundled, so CJK text falls back to a system font (no crash, and esm.sh is
// only reached if CJK glyphs are actually drawn — the renderer CSP blocks it).
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  new URL('./excalidraw-assets/', document.baseURI).href
