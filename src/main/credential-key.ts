/**
 * The only keys the renderer may name in the credential store.
 *
 * The store holds four kinds of entry, all keyed by one of the app's own ids
 * (plain [A-Za-z0-9]) plus an optional suffix: a config's SSH password (bare
 * id), its sudo password (`_sudo`), its terminal secret argument
 * (`_argsecret`) and a command button's secret (`_cmdsecret`). The
 * credentials IPC accepts nothing outside that shape, so a renderer can only
 * ever address those namespaces -- never an arbitrary key. Main-process
 * callers that read the store directly are not affected.
 */
export const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9]{1,64}(_sudo|_argsecret|_cmdsecret)?$/

export function isAllowedCredentialKey(key: unknown): key is string {
  return typeof key === 'string' && CREDENTIAL_KEY_PATTERN.test(key)
}
