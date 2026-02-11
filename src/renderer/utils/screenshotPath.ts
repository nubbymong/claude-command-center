/**
 * Given a local screenshot path, return the appropriate path for the session type.
 * Local sessions use the full local path.
 * SSH sessions use the mounted resource path.
 */
export function getScreenshotPathForSession(localPath: string, sessionType: 'local' | 'ssh'): string {
  if (sessionType === 'local') return localPath
  // Extract filename from Windows path
  const normalized = localPath.replace(/\\/g, '/')
  const filename = normalized.split('/').pop() || localPath
  return `/mnt/resources/SCREENSHOTS/${filename}`
}

/**
 * Format a timestamp as relative time string.
 */
export function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
