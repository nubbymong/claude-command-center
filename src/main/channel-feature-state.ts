// src/main/channel-feature-state.ts
import type { FeatureState } from '../shared/channel-types'
import { readJsonFile, writeJsonFile } from './channel-storage'

const FILE = 'feature-state.json'
function seed(): FeatureState { return { disableConductorChannels: false, introShown: false } }

export function getFeatureState(): FeatureState {
  const f = readJsonFile<FeatureState>(FILE, seed)
  return { disableConductorChannels: !!f.disableConductorChannels, introShown: !!f.introShown }
}
export function setKillSwitch(disabled: boolean): void {
  writeJsonFile(FILE, { ...getFeatureState(), disableConductorChannels: disabled })
}
export function markIntroShown(): void {
  writeJsonFile(FILE, { ...getFeatureState(), introShown: true })
}
