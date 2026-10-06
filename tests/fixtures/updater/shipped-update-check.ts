/**
 * The update check every shipped build from 2.1.0-rc.5 to 2.1.1-beta.1 carries
 * (src/main/github-update.ts at those tags): its tag ordering and its
 * checkGitHubRelease, copied with the comments left out and its settings,
 * network and log calls replaced by the stand-ins below; the code of each
 * function is as shipped. tests/unit/main/update-macos-floor.test.ts runs it
 * over a release feed to show what a Mac on one of those builds is offered.
 */

let feed: { releases: GitHubRelease[] | null; running: string; channel: UpdateChannel } = { releases: null, running: '0.0.0', channel: 'stable' }
let INSTALLER_EXT = '.exe'
function getRunningVersion(): string { return feed.running }
function getUpdateChannel(): UpdateChannel { return feed.channel }
async function fetchReleases(): Promise<GitHubRelease[] | null> { return feed.releases }
function logInfo(_line: string): void { /* the shipped build writes this to its log */ }

/** What a shipped build on `running`, on `platform` and `channel`, is offered from `releases`. */
export async function shippedUpdateCheck(input: { releases: GitHubRelease[]; running: string; channel: UpdateChannel; platform: NodeJS.Platform }): Promise<ReleaseInfo | null> {
  feed = { releases: input.releases, running: input.running, channel: input.channel }
  INSTALLER_EXT = input.platform === 'darwin' ? '.dmg' : input.platform === 'linux' ? '.AppImage' : '.exe'
  return checkGitHubRelease()
}

export type UpdateChannel = 'stable' | 'beta'

interface GitHubAsset {
  name: string
  browser_download_url?: string
  url?: string
  size?: number
}

interface GitHubRelease {
  tag_name: string
  tagName?: string
  prerelease?: boolean
  draft?: boolean
  assets: GitHubAsset[]
}

interface ReleaseInfo {
  version: string
  tagName: string
  channel: UpdateChannel
  installerUrl: string | null
  installerName: string | null
}

function classifyTag(tag: string): UpdateChannel | null {
  const stripped = tag.replace(/^v/, '')
  if (/^\d+\.\d+\.\d+$/.test(stripped)) return 'stable'
  if (/^\d+\.\d+\.\d+-(?:beta|rc)(\.\d+)?$/.test(stripped)) return 'beta'
  return null
}

function tagMatchesChannel(tag: string, channel: UpdateChannel): boolean {
  const tagChannel = classifyTag(tag)
  if (!tagChannel) return false
  if (channel === 'beta') return tagChannel === 'stable' || tagChannel === 'beta'
  return tagChannel === 'stable'
}

function parseVersion(tag: string): string {
  return tag.replace(/^v/, '').replace(/-(?:beta|dev|rc)(?:\.\d+)?$/, '')
}

interface TagComponents {
  major: number
  minor: number
  patch: number
  prereleaseRank: number
  prereleaseNum: number
}

function parseTag(tag: string): TagComponents | null {
  const stripped = tag.replace(/^v/, '')
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)(?:\.(\d+))?)?$/)
  if (!m) return null
  const [, maj, min, pat, pre, preN] = m
  let prereleaseRank = Number.POSITIVE_INFINITY
  let prereleaseNum = 0
  if (pre === 'beta') { prereleaseRank = 2; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
  if (pre === 'rc') { prereleaseRank = 3; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
  return {
    major: parseInt(maj, 10),
    minor: parseInt(min, 10),
    patch: parseInt(pat, 10),
    prereleaseRank,
    prereleaseNum,
  }
}

function compareTags(aTag: string, bTag: string): number {
  const a = parseTag(aTag)
  const b = parseTag(bTag)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prereleaseRank !== b.prereleaseRank) return a.prereleaseRank - b.prereleaseRank
  return a.prereleaseNum - b.prereleaseNum
}

function compareTagToCurrentVersion(tag: string, currentVersion: string): number {
  return compareTags(tag, `v${currentVersion}`)
}

async function checkGitHubRelease(): Promise<ReleaseInfo | null> {
  const currentVersion = getRunningVersion()
  const channel = getUpdateChannel()
  logInfo(`[github-update] Checking for updates (current: v${currentVersion}, channel: ${channel})`)

  const releases = await fetchReleases()
  if (!releases || releases.length === 0) {
    logInfo('[github-update] No releases fetched')
    return null
  }

  let best: { release: GitHubRelease; tag: string; version: string; channel: UpdateChannel } | null = null

  for (const rel of releases) {
    if (rel.draft) continue
    const tag = rel.tag_name || rel.tagName
    if (!tag) continue
    if (!tagMatchesChannel(tag, channel)) continue

    if (!parseTag(tag)) continue

    if (compareTagToCurrentVersion(tag, currentVersion) <= 0) continue

    if (!best || compareTags(tag, best.tag) > 0) {
      best = { release: rel, tag, version: parseVersion(tag), channel: classifyTag(tag)! }
    }
  }

  if (!best) {
    logInfo(`[github-update] Up to date (channel: ${channel})`)
    return null
  }

  const INSTALLER_PREFIXES = ['ClaudeCommandCenter-', 'AI-Code-Conductor-']
  const installer = best.release.assets.find((a) =>
    a.name.endsWith(INSTALLER_EXT) && INSTALLER_PREFIXES.some((p) => a.name.startsWith(p))
  )

  if (!installer) {
    logInfo(`[github-update] Skipping v${best.version} (tag: ${best.tag}) - no ${INSTALLER_EXT} asset for current platform`)
    return null
  }

  logInfo(`[github-update] Update available: v${best.version} (tag: ${best.tag}, channel: ${best.channel}, installer: ${installer.name})`)

  return {
    version: best.version,
    tagName: best.tag,
    channel: best.channel,
    installerUrl: installer.browser_download_url || installer.url || null,
    installerName: installer.name,
  }
}
