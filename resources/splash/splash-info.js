// Build identity on the boot splash (#384).
//
// The main process passes the one-line build identity
// ("v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22", formatted by
// src/shared/build-identity.ts and handed over via splashBuildQuery) as the
// `build` query parameter of the file:// URL it loads. This classic script
// reads it back and prints it. It is deliberately separate from splash.js:
// that one is a module that imports three.js, and if WebGL or the import
// fails the build line must still show — identifying the build is the point.
//
// textContent only — the value is never interpreted as markup. No network,
// no inline script (the page's own CSP forbids both).
(function () {
  var el = document.getElementById('buildinfo');
  if (!el) return;
  var line = '';
  try {
    line = new URLSearchParams(location.search).get('build') || '';
  } catch (e) {
    line = '';
  }
  el.textContent = line;
  if (line) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
})();
