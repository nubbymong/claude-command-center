/**
 * Secret arguments for command buttons: the shared contract.
 *
 * The value goes to the keychain and the shell's env; the button types only a
 * reference. Both processes build the variable NAME from this one module, so
 * these tests are what keeps them agreeing.
 */
import { describe, it, expect } from 'vitest'
import {
  COMMAND_SECRET_TOKEN, commandSecretEnvName, commandSecretKey, commandSecretRef, buildCommandLine,
} from '../../../src/shared/command-secret'

describe('the env variable name', () => {
  it('is built from the command id', () => {
    expect(commandSecretEnvName('a1b2c3')).toBe('CCC_CMD_SECRET_a1b2c3')
  })

  it('refuses anything that could not be a variable name', () => {
    // An id is the app's own 24-hex, but the name is built from it, so the
    // shape is checked rather than trusted.
    expect(commandSecretEnvName('')).toBeNull()
    expect(commandSecretEnvName('a-b')).toBeNull()
    expect(commandSecretEnvName('a b')).toBeNull()
    expect(commandSecretEnvName('$(id)')).toBeNull()
    expect(commandSecretEnvName('a=b')).toBeNull()
    expect(commandSecretEnvName('x'.repeat(65))).toBeNull()
    expect(commandSecretEnvName(undefined as unknown as string)).toBeNull()
  })
})

describe('the reference the button types', () => {
  it('is $env:NAME on Windows and a quoted "$NAME" on POSIX', () => {
    expect(commandSecretRef('abc', true)).toBe('${env:CCC_CMD_SECRET_abc}')
    expect(commandSecretRef('abc', false)).toBe('"$CCC_CMD_SECRET_abc"')
  })

  it('is null for an id that has no valid name', () => {
    expect(commandSecretRef('a b', true)).toBeNull()
  })

  it('the keychain key has its own suffix, so it cannot collide with a config secret', () => {
    expect(commandSecretKey('abc')).toBe('abc_cmdsecret')
    expect(commandSecretKey('abc')).not.toBe('abc_argsecret')
  })
})

describe('buildCommandLine — the ONE rule for what gets typed', () => {
  it('is prompt + space + args joined by spaces, nothing quoted', () => {
    expect(buildCommandLine('npm test', [])).toBe('npm test')
    expect(buildCommandLine('npm test', ['--watch', '-t foo'])).toBe('npm test --watch -t foo')
    expect(buildCommandLine('  x  ', ['a'])).toBe('x a')
    expect(buildCommandLine('   ', ['a'])).toBe('')
    expect(buildCommandLine('x', undefined)).toBe('x')
  })

  it('replaces {secret} in the arguments with the reference, every occurrence', () => {
    const ref = commandSecretRef('abc', true)!
    expect(buildCommandLine('curl', ['-H', `Authorization: ${COMMAND_SECRET_TOKEN}`], ref))
      .toBe('curl -H Authorization: ${env:CCC_CMD_SECRET_abc}')
    expect(buildCommandLine('x', ['{secret}{secret}'], ref))
      .toBe('x ${env:CCC_CMD_SECRET_abc}${env:CCC_CMD_SECRET_abc}')
  })

  /**
   * #371 — this used to assert the opposite ("never touches the prompt itself
   * -- the secret is an ARGUMENT"). A secret can only exist on a SHELL button:
   * the toggle is not offered for a prompt or a page, and a stored value is
   * dropped when one is converted. On a shell button that first field is not a
   * prompt — it is labelled "Command to run" and typed into the terminal
   * exactly as written — so `curl -H "Bearer {secret}"`, the natural way to
   * write a whole invocation, put the literal token into the user's shell.
   */
  it('substitutes {secret} in the command line as well as the arguments', () => {
    const ref = commandSecretRef('abc', true)!
    expect(buildCommandLine('echo {secret}', ['x'], ref)).toBe('echo ${env:CCC_CMD_SECRET_abc} x')
    expect(buildCommandLine('curl -H "Bearer {secret}"', [], ref))
      .toBe('curl -H "Bearer ${env:CCC_CMD_SECRET_abc}"')
  })

  it('cannot reach a Claude prompt: with no reference the token stays literal', () => {
    // `commandSecretRef` is null for anything that is not a shell button with a
    // stored secret, so a prompt is untouchable through this path.
    expect(buildCommandLine('echo {secret}', ['x'])).toBe('echo {secret} x')
    expect(buildCommandLine('echo {secret}', ['x'], null)).toBe('echo {secret} x')
  })

  it('a command is empty only because nothing was typed, never because a token collapsed', () => {
    const ref = commandSecretRef('abc', true)!
    expect(buildCommandLine('', ['x'], ref)).toBe('')
    expect(buildCommandLine('   ', ['x'], ref)).toBe('')
  })

  it('leaves the token alone when there is no reference to substitute', () => {
    // A command with no stored secret types "{secret}" literally -- visible and
    // harmless -- rather than silently typing nothing where a value was meant.
    expect(buildCommandLine('x', ['-t {secret}'])).toBe('x -t {secret}')
    expect(buildCommandLine('x', ['-t {secret}'], null)).toBe('x -t {secret}')
  })
})
