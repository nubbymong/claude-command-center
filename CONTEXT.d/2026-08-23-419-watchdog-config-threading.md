## 2026-08-23 -- #419 (partial): the watchdog config knobs become reachable; the pattern lists deliberately do not

F13 from the #266 review: WatchdogManager threaded only `retryMessage` +
`maxRetries` into a SessionWatchdog, so `overload.*`, `safeguard.*`,
`marginSeconds`, and `fallbackWaitHours` were unreachable even by hand-editing
settings.json. Now `threadedWatchdogConfig` passes them through, with
`resolveWatchdogConfig` staying the single validator (every field fail-safes
to the default).

**The one thing NOT threaded, on purpose: the `patterns` lists.** settings.json
is renderer-writable, and the overload/safeguard patterns decide WHEN the
watchdog types into the user's PTY -- a hostile but regex-valid list could
turn ordinary session output into a retry storm. The #266 review counted their
unreachability as a security property; `threadedWatchdogConfig` strips
`patterns` from both blocks before handing over, and a test pins that.

Left open on #419 (noted on the issue): F11's live-apply half (enabling the
feature mid-session still waits for the next spawn; `applySettings` handles
the disable direction only), F12 (Settings page writes on every keystroke),
N2 (screen-reader-mode gate blind spot), N3 (volumetric clamped-REP residual).
