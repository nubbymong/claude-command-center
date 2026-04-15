import type { ComponentType } from 'react'
import type { PaneType } from '../../../shared/types'

export interface PaneComponentProps {
  paneId: string
  sessionId: string
  isActive: boolean
  props: Record<string, unknown>
}

const registry = new Map<PaneType, ComponentType<PaneComponentProps>>()

export function registerPaneComponent(type: PaneType, component: ComponentType<PaneComponentProps>): void {
  registry.set(type, component)
}

export function getPaneComponent(type: PaneType): ComponentType<PaneComponentProps> | undefined {
  return registry.get(type)
}

export function getRegisteredPaneTypes(): PaneType[] {
  return Array.from(registry.keys())
}
