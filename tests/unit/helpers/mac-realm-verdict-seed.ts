// Test helper: record a POSITIVE macOS realm verdict (decision
// aicc_planning#172 item 4) for profile homes, against a fake CLI file, so a
// test about the realm ENVIRONMENT is not refused by the guard. Tests of the
// guard itself do not use this.
import fs from 'node:fs'
import path from 'node:path'
import { cliStampSync, recordMacRealmVerdict, setCurrentInstalledCli } from '../../../src/main/mac-realm-verdict'

export function seedMacRealmVerdict(tmpDir: string, ...homes: string[]): void {
  const cli = path.join(tmpDir, 'fake-claude-cli')
  if (!fs.existsSync(cli)) fs.writeFileSync(cli, '#!/bin/sh\n')
  const stamp = cliStampSync(cli)
  if (!stamp) throw new Error('fake CLI not statable')
  setCurrentInstalledCli({ path: cli, stamp })
  for (const h of homes) recordMacRealmVerdict(path.resolve(h, '.claude').normalize('NFC'), { path: cli, stamp })
}
