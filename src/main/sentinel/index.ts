// Sentinel service singleton (spec §5). Phase 2 scope: state + Trigger A.
import { SentinelState } from './sentinel-state'
import { makeObserver, type Observation } from './sentinel-observe'
import { getRegistry } from '../model-registry-service'

let state: SentinelState | null = null
let observer: ((obs: Observation) => void) | null = null

export function initSentinel(resourcesDir: string): SentinelState {
  state = new SentinelState(resourcesDir)
  observer = makeObserver(state, getRegistry)
  return state
}
export function getSentinelState(): SentinelState | null { return state }
export function sentinelObserve(obs: Observation): void { observer?.(obs) }
