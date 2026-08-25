import { describe, it, expect } from 'vitest'
import { getAgentStatusColor } from '../../../src/renderer/components/CloudAgentsPage'

describe('Cloud Agents status colours via tokens (U6.1)', () => {
  it('completed -> --status-success', () => { expect(getAgentStatusColor('completed')).toBe('var(--status-success)') })
  it('failed -> --status-danger', () => { expect(getAgentStatusColor('failed')).toBe('var(--status-danger)') })
  it('running -> --status-info', () => { expect(getAgentStatusColor('running')).toBe('var(--status-info)') })
  it('pending -> --status-warning', () => { expect(getAgentStatusColor('pending')).toBe('var(--status-warning)') })
  it('cancelled -> --status-danger', () => { expect(getAgentStatusColor('cancelled')).toBe('var(--status-danger)') })
})
