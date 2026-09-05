// browser-paths.ts — where Chrome and Edge live, per platform.
//
// PURE, AND DELIBERATELY DEPENDENCY-FREE. This used to live in
// `vision-manager.ts`, which meant anything wanting one list of file paths
// imported the whole vision stack behind it — and that stack reaches
// `conductor-mcp-server` -> `update-watcher` -> `app.isPackaged`, so merely
// asking "where is Edge?" pulled a live Electron `app` into the module graph.
//
// It surfaced as a test in an unrelated area failing to load once the
// account-profiles IPC handlers gained an account-web import (#216): the failure
// was three hops away from anything either change was about. A security-sensitive
// module should not drag a server and an updater in behind it.
//
// `vision-manager` re-exports this so existing importers are unaffected.
//
// No default export (project convention).

/** Browsers this app can drive over CDP. Same engine, same protocol. */
export type CdpBrowser = 'chrome' | 'edge'

/**
 * Candidate executable paths for a browser, best first.
 *
 * `platform` is a parameter rather than read from `process` so the per-OS answers
 * are testable on any host; `env` likewise, because the Windows per-user
 * location hangs off `%LOCALAPPDATA%`.
 */
export function getBrowserPaths(
  browser: CdpBrowser,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    if (browser === 'edge') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  if (platform === 'linux') {
    if (browser === 'edge') return [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/microsoft/msedge/msedge',
    ]
    // Chromium counts as "chrome" here — same engine, same CDP protocol.
    // Snap chromium (/snap/bin/chromium) is deliberately absent: snap
    // confinement blocks the --user-data-dir under /tmp, so it spawns but the
    // debug port never comes up and vision hangs on "launching" instead of
    // cleanly disabling. deb/rpm builds only.
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]
  }
  // Windows: the system-wide installs first, then the PER-USER install under
  // %LOCALAPPDATA% (aicc_planning#43). On a managed machine where the user has no
  // admin rights, Chrome -- and sometimes Edge -- installs there and nowhere under
  // Program Files. Without this entry a per-user Chrome was invisible:
  // `resolveBrowserBinary('chrome')` fell back to Edge, `detectAuthBrowsers()`
  // reported one browser, and the SSO "Sign-in browser" picker hid itself by
  // design -- "we lost the Edge choice". The same list feeds the vision browser,
  // so a per-user Chrome now drives vision too.
  const local = env.LOCALAPPDATA
  if (browser === 'edge') return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ...(local ? [`${local}\\Microsoft\\Edge\\Application\\msedge.exe`] : []),
  ]
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
  ]
}
