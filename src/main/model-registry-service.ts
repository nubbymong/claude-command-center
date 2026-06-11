// Loads baseline (static import — packaged-build-safe, the codex-pricing.json
// pattern) + overlay from <resourcesDir>/sentinel/registry-overlay.json, merges
// (overlay wins per id), pushes hot reloads to renderer + subscribers.
import * as fs from 'fs'
import * as path from 'path'
import baselineJson from '../../resources/model-registry.json'
import {
  mergeRegistry, type ModelRegistry, type RegistryOverlay, type OverlayModelEntry,
} from '../shared/model-registry'
import { logInfo } from './debug-logger'

const baseline = baselineJson as unknown as ModelRegistry

let overlayDir: string | null = null         // <resourcesDir> root; sentinel/ created lazily
let merged: ModelRegistry = mergeRegistry(baseline, null)
const reloadSubs = new Set<(reg: ModelRegistry) => void>()

function overlayPath(): string | null {
  return overlayDir ? path.join(overlayDir, 'sentinel', 'registry-overlay.json') : null
}

export function loadOverlay(): RegistryOverlay | null {
  const p = overlayPath()
  if (!p) return null
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RegistryOverlay
  } catch (err) {
    logInfo(`[registry] corrupt overlay ignored: ${(err as Error).message}`)
    return null                              // fail-open: baseline still loads (spec §7)
  }
}

function writeOverlay(overlay: RegistryOverlay): void {
  const p = overlayPath()
  if (!p) return
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2))
  fs.renameSync(tmp, p)                      // atomic (spec §5)
}

export function reloadRegistry(): void {
  merged = mergeRegistry(baseline, loadOverlay())
  for (const fn of reloadSubs) { try { fn(merged) } catch { /* subscriber error must not break reload */ } }
}

export function getRegistry(): ModelRegistry { return merged }
export function getBaseline(): ModelRegistry { return baseline }
export function onRegistryReload(fn: (reg: ModelRegistry) => void): () => void {
  reloadSubs.add(fn); return () => reloadSubs.delete(fn)
}

export function applyOverlayEntry(entry: OverlayModelEntry): void {
  const overlay = loadOverlay() ?? {}
  const models = (overlay.models ?? []).filter((m) => m.id !== entry.id)
  models.push(entry)
  writeOverlay({ ...overlay, models })
  reloadRegistry()
}

export function removeOverlayEntry(id: string): void {
  const overlay = loadOverlay() ?? {}
  writeOverlay({ ...overlay, models: (overlay.models ?? []).filter((m) => m.id !== id) })
  reloadRegistry()
}

export function setOverlay(overlay: RegistryOverlay): void { writeOverlay(overlay); reloadRegistry() }

/** Production init: call once at bootstrap with the resources directory. */
export function initModelRegistry(resourcesDir: string): void {
  overlayDir = resourcesDir
  reloadRegistry()
}

/** Test seam. */
export function _initRegistryForTest(dir: string): void { initModelRegistry(dir) }
