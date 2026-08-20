import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'

export interface AppMeta {
  setupVersion?: string
  lastSeenVersion?: string
  lastTrainingVersion?: string
  commandsSeeded?: boolean
  colorMigrated?: boolean
  /** Set once the saved config the RETIRED "Ask the Conductor" path used to
   *  create has been removed from Saved Configs. See retireAskConfig. */
  askConfigRetired?: boolean
  hasCreatedFirstConfig?: boolean
  firstRunCardDismissed?: boolean
  accountWizardDismissed?: boolean
  accountGateDecided?: boolean      // user explicitly chose Enable or No in the gate
  lastSeenGlobalAccount?: string    // global ~/.claude.json oauth email at last launch
  completedSteps?: Record<string, string>   // onboarding: stepId -> app version at completion (presence = settled)
  onboardingCompletedVersion?: string       // onboarding: set once at the finish step; compared to ONBOARDING_VERSION
  onboardingAppVersion?: string             // app version at last onboarding finish; drives the per-beta-version tour retrigger
}

interface AppMetaState {
  meta: AppMeta
  isLoaded: boolean
  hydrate: (meta: AppMeta) => void
  update: (updates: Partial<AppMeta>) => void
}

export const useAppMetaStore = create<AppMetaState>((set, get) => ({
  meta: {},
  isLoaded: false,

  hydrate: (meta) => set({ meta, isLoaded: true }),

  update: (updates) =>
    set((state) => {
      const meta = { ...state.meta, ...updates }
      saveConfigNow('appMeta', meta)
      return { meta }
    })
}))
