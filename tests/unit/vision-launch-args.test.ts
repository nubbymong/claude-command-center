import { describe, it, expect } from 'vitest'
import { buildBrowserLaunchArgs } from '../../src/main/vision-manager'

describe('buildBrowserLaunchArgs (P2.7 CDP loopback bind)', () => {
  it('binds the CDP debug port to loopback only', () => {
    const args = buildBrowserLaunchArgs(9222, '/tmp/p', true)
    expect(args).toContain('--remote-debugging-port=9222')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('keeps user-data-dir + headless flags', () => {
    const args = buildBrowserLaunchArgs(9322, '/tmp/p', true)
    expect(args).toContain('--user-data-dir=/tmp/p')
    expect(args).toContain('--headless=new')
    expect(args).toContain('--disable-gpu')
  })

  it('omits headless flags and appends the url when not headless', () => {
    const args = buildBrowserLaunchArgs(9222, '/tmp/p', false, 'https://example.com')
    expect(args).not.toContain('--headless=new')
    expect(args[args.length - 1]).toBe('https://example.com')
  })
})
