import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it } from 'vitest'

import { extractTarGzipArchive } from '../../packages/server/src/modules/hermes/services/runtime/runtime-archive'

describe('server runtime archive extraction', () => {
  let tempRoot: string | null = null

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  })

  it('extracts gzip tar archives without mutating the archive', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hermes-server-runtime-extract-'))
    const source = join(tempRoot, 'source')
    const target = join(tempRoot, 'target')
    const archive = join(tempRoot, 'runtime.tar.gz')
    mkdirSync(join(source, 'python', 'Scripts'), { recursive: true })
    writeFileSync(join(source, 'python', 'Scripts', 'hermes.exe'), 'launcher', 'utf8')

    await tar.c({ file: archive, cwd: source, gzip: true }, ['python'])
    mkdirSync(target)

    await extractTarGzipArchive(archive, target)

    expect(readFileSync(join(target, 'python', 'Scripts', 'hermes.exe'), 'utf8')).toBe('launcher')
    expect(readFileSync(archive).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  })
})
