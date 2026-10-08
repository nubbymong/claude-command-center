// Main's reader of the experimental macOS multi-account setting
// (src/shared/mac-multi-account.ts holds the rule and why).
//
// Read from the saved settings file on every call, not cached: the renderer
// saves the toggle through the same file, so the next launch after a change
// sees it without a restart. Fails CLOSED: anything but a clean read of a
// saved `true` is off, so an unreadable settings file can never put a Mac
// profile on a redirected config directory the user did not ask for.
//
// Off without reading anything on win32 and linux.
import { readConfigChecked } from './config-manager'
import { macMultiAccountEnabled } from '../shared/mac-multi-account'

export function isMacMultiAccountEnabled(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return false
  try {
    const r = readConfigChecked<Record<string, unknown>>('settings', { quarantineUnparseable: false })
    return r.outcome === 'ok' && macMultiAccountEnabled(platform, r.value)
  } catch {
    return false
  }
}
