import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalHermesBin = process.env.HERMES_BIN
const temporaryDirectories: string[] = []

function versionCli(root: string, name: string, version: string): string {
  const command = join(root, name)
  writeFileSync(command, `#!/bin/sh\nprintf 'Hermes Agent ${version}\\n'\n`)
  chmodSync(command, 0o755)
  return command
}

afterEach(() => {
  if (originalHermesBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = originalHermesBin
  vi.resetModules()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('live Hermes CLI selection', () => {
  it('reads HERMES_BIN for every operation instead of freezing it at module load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-cli-live-selection-'))
    temporaryDirectories.push(root)
    const first = versionCli(root, 'hermes-first', '0.20.4')
    const second = versionCli(root, 'hermes-second', '0.21.0')
    process.env.HERMES_BIN = first

    const hermesCli = await import('../../packages/server/src/modules/hermes/services/runtime/cli')
    await expect(hermesCli.getVersion()).resolves.toContain('0.20.4')

    process.env.HERMES_BIN = second
    await expect(hermesCli.getVersion()).resolves.toContain('0.21.0')
  })
})
