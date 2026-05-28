// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { AgentCard } from '../../../src/renderer/components/CloudAgentsPage'

const a: any = { id: '1', name: 'A', description: 'D', projectPath: '/p',
  status: 'completed', createdAt: Date.now(), output: '', cost: null }

describe('AgentCard uses StatusDot (U6.2)', () => {
  it('uses --status-success for completed agent dot', () => {
    const html = renderToStaticMarkup(<AgentCard agent={a} selected={false} onClick={() => {}} onContextMenu={() => {}} />)
    expect(html).toContain('--status-success')
  })
})
