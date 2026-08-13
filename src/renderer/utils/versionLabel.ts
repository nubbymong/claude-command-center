import type { UpdateChannel } from '../stores/settingsStore'

// "current installed version + channel" label for the update UI -- the Settings
// Check-for-Updates field and the BottomBar update-pill tooltip (#250). Pure so
// it can be unit-tested without a renderer; callers pass the build-time
// __APP_VERSION__ (full tag, incl. any prerelease suffix) and the reactive
// settings.updateChannel.
export function formatInstalledVersion(version: string, channel: UpdateChannel): string {
  return `v${version} (${channel})`
}
