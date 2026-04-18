import {
  GITHUB_DEVICE_CODE_URL,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_TOKEN_URL,
} from '../../../shared/github-constants'
import type { DeviceCodeResponse, OAuthTokenResponse } from '../../../shared/github-types'

/**
 * Step 1 of RFC 8628: request a device code + user_code.
 * Public client — no client secret. Throws on HTTP error.
 */
export async function requestDeviceCode(scope: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, scope })
  const r = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`device_code HTTP ${r.status}`)
  return (await r.json()) as DeviceCodeResponse
}

export type Sleep = (ms: number) => Promise<void>
export type IsCancelled = () => boolean

/**
 * Step 2 of RFC 8628: poll the token endpoint until the user approves the
 * device, denies it, or the code expires.
 *
 * Dependency-injected sleep + cancellation for test friendliness. Production
 * callers pass the defaults (real setTimeout, never cancelled) or wire a
 * cancel callback to a UI "Cancel" button.
 *
 * Handles the three transient response states from GitHub:
 *   - authorization_pending — normal; loop on current interval
 *   - slow_down — bump interval per the response's `interval` field
 *   - any other error — throw
 */
export async function pollForAccessToken(
  deviceCode: string,
  intervalSec: number,
  sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  isCancelled: IsCancelled = () => false,
): Promise<OAuthTokenResponse> {
  let currentInterval = Math.max(intervalSec, 1)
  while (true) {
    if (isCancelled()) return { error: 'cancelled' }
    await sleep(currentInterval * 1000)
    if (isCancelled()) return { error: 'cancelled' }

    const body = new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const r = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const json = (await r.json()) as OAuthTokenResponse
    if (json.access_token) return json
    if (json.error === 'authorization_pending') continue
    if (json.error === 'slow_down') {
      currentInterval = json.interval ?? currentInterval + 5
      continue
    }
    if (json.error) throw new Error(`OAuth error: ${json.error}`)
    // No token, no known error — defensive: treat as pending to avoid busy-loop.
    continue
  }
}
