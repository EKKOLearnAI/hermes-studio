import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

async function dockerConfiguration() {
  const dockerfile = await readFile('Dockerfile', 'utf8')
  const compose = parse(await readFile('docker-compose.yml', 'utf8'))
  const service = compose.services['hermes-webui']
  const env = Object.fromEntries(service.environment.map((entry: string) => {
    const separator = entry.indexOf('=')
    return [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  return { dockerfile, service, env }
}

describe('Docker coding agent persistence', () => {
  it('keeps global npm packages and executable discovery inside the Studio data mount', async () => {
    const { dockerfile, service, env } = await dockerConfiguration()
    const imagePrefix = dockerfile.match(/^ENV NPM_CONFIG_PREFIX=(.+)$/m)?.[1]
    const imagePath = dockerfile.match(/^ENV PATH=(.+)$/m)?.[1]
    expect(imagePrefix).toBe(env.NPM_CONFIG_PREFIX)
    const mount = service.volumes.find((volume: string) => volume.endsWith(':/home/agent/.hermes-web-ui'))
    expect(mount).toBeTruthy()
    const relativePrefix = posix.relative('/home/agent/.hermes-web-ui', env.NPM_CONFIG_PREFIX)
    expect(relativePrefix).not.toMatch(/^\.\.(\/|$)/)
    expect(posix.isAbsolute(relativePrefix)).toBe(false)
    const bin = `${env.NPM_CONFIG_PREFIX}/bin`
    expect(imagePath?.split(':')[0]).toBe(bin)
    expect(env.PATH.split(':')[0]).toBe(bin)
    expect(env.PATH.split(':')).toContain('/usr/local/bin')
  })

  it.skipIf(process.platform === 'win32')('can run and uninstall a global CLI from a fresh process after its original container files are removed', async () => {
    const { env: dockerEnv } = await dockerConfiguration()
    const root = await mkdtemp(join(tmpdir(), 'studio-docker-npm-'))
    try {
      const volume = join(root, 'volume')
      const oldContainer = join(root, 'old-container')
      const newContainer = join(root, 'new-container')
      const prefix = join(volume, posix.relative('/home/agent/.hermes-web-ui', dockerEnv.NPM_CONFIG_PREFIX))
      await mkdir(oldContainer)
      await mkdir(newContainer)
      await writeFile(join(oldContainer, 'package.json'), JSON.stringify({
        name: 'studio-persistence-fixture', version: '1.0.0', bin: { 'studio-persistence-fixture': 'cli.js' },
      }))
      await writeFile(join(oldContainer, 'cli.js'), '#!/usr/bin/env node\nconsole.log("persistent-cli-1.0.0")\n', { mode: 0o755 })
      await writeFile(join(root, 'npmrc'), '')
      await writeFile(join(root, 'global-npmrc'), '')
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
      )
      Object.assign(env, {
        NPM_CONFIG_PREFIX: prefix,
        NPM_CONFIG_CACHE: join(root, 'npm-cache'),
        NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
        NPM_CONFIG_GLOBALCONFIG: join(root, 'global-npmrc'),
        NPM_CONFIG_OFFLINE: 'true',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        PATH: `${prefix}/bin:${process.env.PATH}`,
      })
      const options = { env, cwd: oldContainer, timeout: 20_000 }
      await execFileAsync('npm', ['pack', '--ignore-scripts'], options)
      await execFileAsync('npm', ['install', '-g', join(oldContainer, 'studio-persistence-fixture-1.0.0.tgz'), '--ignore-scripts'], options)
      await rm(oldContainer, { recursive: true })
      const freshProcess = { env, cwd: newContainer, timeout: 20_000 }
      const result = await execFileAsync('studio-persistence-fixture', [], freshProcess)
      expect(result.stdout.trim()).toBe('persistent-cli-1.0.0')
      const npmPrefix = await execFileAsync('npm', ['prefix', '-g'], freshProcess)
      expect(npmPrefix.stdout.trim()).toBe(prefix)
      await execFileAsync('npm', ['uninstall', '-g', 'studio-persistence-fixture'], freshProcess)
      await expect(execFileAsync('studio-persistence-fixture', [], freshProcess)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
