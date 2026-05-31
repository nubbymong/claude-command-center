// src/main/account-profiles.ts
// Per-session multi-account via per-process CLAUDE_CONFIG_DIR. Identity files
// are private per profile; projects/memory/etc are junctioned back to the shared
// ~/.claude. SAFETY: this module only ever copies into / links from the shared
// root; it never moves or recursive-deletes through a junction. All path roots
// are injectable so tests never touch the live ~/.claude. Profile metadata is
// persisted as an atomic profiles.json under the profiles root (NOT via
// config-manager) so _setRootsForTest is a total seam.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getResourcesDirectory } from './ipc/setup-handlers'
import type { AccountProfile, AccountProfilesConfig } from '../shared/account-types'

// Shared-directory names junctioned from a profile back to the shared root.
// Identity files (.credentials.json, .claude.json, statsig, telemetry, caches)
// are deliberately NOT here -- they stay private per profile.
export const SHARED_DIR_NAMES = ['projects', 'memory', 'agents', 'skills', 'commands', 'plugins'] as const

let rootsOverride: { resourcesDir: string; sharedRoot: string } | null = null
/** Test seam: inject temp roots so we never touch ~/.claude. */
export function _setRootsForTest(roots: { resourcesDir: string; sharedRoot: string } | null): void { rootsOverride = roots }

function resourcesDir(): string { return rootsOverride?.resourcesDir ?? getResourcesDirectory() }
/** The shared real config root (default account). Overridable in tests ONLY. */
export function sharedRoot(): string { return rootsOverride?.sharedRoot ?? path.join(os.homedir(), '.claude') }

export function getProfilesRoot(): string { return path.join(resourcesDir(), 'account-profiles') }
export function getProfileConfigDir(id: string): string { return path.join(getProfilesRoot(), id) }

function profilesMetaFile(): string { return path.join(getProfilesRoot(), 'profiles.json') }

export function listProfiles(): AccountProfile[] {
  try {
    const raw = fs.readFileSync(profilesMetaFile(), 'utf8')
    return (JSON.parse(raw) as AccountProfilesConfig)?.profiles ?? []
  } catch { return [] }
}

function saveProfiles(profiles: AccountProfile[]): void {
  const file = profilesMetaFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ profiles } satisfies AccountProfilesConfig, null, 2))
  fs.renameSync(tmp, file) // atomic; Node renameSync overwrites existing on win + posix
}
export function upsertProfile(p: AccountProfile): void {
  const all = listProfiles().filter((x) => x.id !== p.id)
  all.push(p)
  saveProfiles(all)
}
export function deleteProfileMeta(id: string): void {
  saveProfiles(listProfiles().filter((x) => x.id !== id))
}
