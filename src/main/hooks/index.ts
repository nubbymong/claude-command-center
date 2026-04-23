import type { HooksGateway } from './hooks-gateway'

let singleton: HooksGateway | null = null

export function setGateway(gw: HooksGateway): void {
  singleton = gw
}

export function getGateway(): HooksGateway | null {
  return singleton
}

export { HooksGateway } from './hooks-gateway'
