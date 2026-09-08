import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EkkoDirectoryManager } from '../../packages/ekko-agent/src/directories'
import { SkillListTool, SkillViewTool } from '../../packages/ekko-agent/src/tools/skills'

const tempDirectories: string[] = []
const execFile = promisify(execFileCallback)

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), content, 'utf8')
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('Ekko built-in skills', () => {
  it('installs missing skills without overwriting a user-owned name conflict', async () => {
    const root = await temporaryDirectory('ekko-builtin-install-')
    const source = join(root, 'source')
    const ekkoHome = join(root, 'home')
    const target = join(ekkoHome, '.ekko', 'skills', 'default')
    await writeSkill(source, 'github', '# Bundled GitHub\n')
    await writeSkill(source, 'weather', '# Bundled Weather\n')
    await writeSkill(target, 'github', '# User GitHub\n')
    vi.stubEnv('EKKO_BUILTIN_SKILLS_DIR', source)

    const directories = new EkkoDirectoryManager(ekkoHome)
    directories.initialize()
    directories.profileSkillsDirectory('default')

    await expect(readFile(join(target, 'github', 'SKILL.md'), 'utf8')).resolves.toBe('# User GitHub\n')
    await expect(readFile(join(target, 'weather', 'SKILL.md'), 'utf8')).resolves.toBe('# Bundled Weather\n')
  })

  it('updates unchanged managed copies while preserving locally modified copies', async () => {
    const root = await temporaryDirectory('ekko-builtin-update-')
    const source = join(root, 'source')
    const ekkoHome = join(root, 'home')
    await writeSkill(source, 'spike', '# Spike v1\n')
    vi.stubEnv('EKKO_BUILTIN_SKILLS_DIR', source)

    const directories = new EkkoDirectoryManager(ekkoHome)
    directories.initialize()
    const cleanTarget = directories.profileSkillsDirectory('default')
    const modifiedTarget = directories.profileSkillsDirectory('work')
    await writeFile(join(modifiedTarget, 'spike', 'SKILL.md'), '# User-adjusted Spike\n', 'utf8')
    await writeFile(join(source, 'spike', 'SKILL.md'), '# Spike v2\n', 'utf8')

    directories.initialize()
    directories.profileSkillsDirectory('default')
    directories.profileSkillsDirectory('work')

    await expect(readFile(join(cleanTarget, 'spike', 'SKILL.md'), 'utf8')).resolves.toBe('# Spike v2\n')
    await expect(readFile(join(modifiedTarget, 'spike', 'SKILL.md'), 'utf8')).resolves.toBe('# User-adjusted Spike\n')
  })

  it('ships only the selected built-in skill set and installs it into every profile', async () => {
    const bundledDirectory = resolve(process.cwd(), 'packages/ekko-agent/skills')
    const names = (await readdir(bundledDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(names).toEqual([
      '1password',
      'apple-notes',
      'apple-reminders',
      'document-to-action-items',
      'docx',
      'gh-issues',
      'github',
      'grok-image-to-video',
      'hermes-studio-installation',
      'image-gen',
      'node-inspect-debugger',
      'obsidian',
      'ocr-and-documents',
      'pdf',
      'powerpoint',
      'python-debugpy',
      'skill-creator',
      'spike',
      'tmux',
      'video-frames',
      'weather',
      'xlsx',
    ])

    for (const name of names) {
      const content = await readFile(join(bundledDirectory, name, 'SKILL.md'), 'utf8')
      expect(content.toLowerCase()).not.toContain('openclaw')
      expect(content).toMatch(/^---[\s\S]*?^metadata:\s*\n\s+keywords:\s*\n(?:\s+-\s+.+\n)+---/m)
      const keywordBlock = content.match(/^\s+keywords:\s*\n((?:\s+-\s+.+\n)+)/m)?.[1] || ''
      const keywords = keywordBlock.match(/^\s+-\s+(.+)$/gm)?.map(line => line.replace(/^\s+-\s+/, '')) || []
      expect(keywords.length).toBeGreaterThanOrEqual(1)
      expect(keywords.length).toBeLessThanOrEqual(8)
      expect(keywords.every(keyword => /^[\x20-\x7e]+$/.test(keyword))).toBe(true)
    }

    const ekkoHome = await temporaryDirectory('ekko-builtin-profile-')
    const directories = new EkkoDirectoryManager(ekkoHome)
    directories.initialize()
    const defaultSkills = directories.profileSkillsDirectory('default')
    const workSkills = directories.profileSkillsDirectory('work')

    for (const name of names) {
      expect(existsSync(join(defaultSkills, name, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(workSkills, name, 'SKILL.md'))).toBe(true)
    }

    const creatorList = await new SkillListTool(defaultSkills).execute({ query: 'skill-creator' })
    expect(JSON.parse(creatorList.content).skills).toEqual([
      expect.objectContaining({ name: 'skill-creator' }),
    ])
    await expect(new SkillViewTool(defaultSkills).execute({ name: 'skill-creator' }))
      .resolves.toMatchObject({
        ok: true,
        data: {
          name: 'skill-creator',
          baseDirectory: await realpath(join(defaultSkills, 'skill-creator')),
        },
      })

    const installationList = await new SkillListTool(defaultSkills).execute({ query: 'Claude Code' })
    expect(JSON.parse(installationList.content).skills).toEqual([
      expect.objectContaining({ name: 'hermes-studio-installation' }),
    ])
    await expect(new SkillViewTool(defaultSkills).execute({ name: 'hermes-studio-installation' }))
      .resolves.toMatchObject({
        ok: true,
        data: {
          name: 'hermes-studio-installation',
          baseDirectory: await realpath(join(defaultSkills, 'hermes-studio-installation')),
        },
      })
  })

  it('runs the bundled Studio media helpers without exposing the server token', async () => {
    const root = await temporaryDirectory('ekko-builtin-media-')
    const inputImage = join(root, 'source.png')
    const outputImage = join(root, 'generated.png')
    const outputVideo = join(root, 'generated.mp4')
    await writeFile(inputImage, 'source-image', 'utf8')
    const requests: Array<{
      path: string
      authorization: string
      profile: string
      body: Record<string, unknown>
    }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        void (async () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          requests.push({
            path: request.url || '',
            authorization: String(request.headers.authorization || ''),
            profile: String(request.headers['x-hermes-profile'] || ''),
            body,
          })
          response.setHeader('Content-Type', 'application/json')
          if (request.url === '/api/studio/media/apikey-image-generate') {
            await writeFile(String(body.output_path), 'generated-image', 'utf8')
            response.end(JSON.stringify({ ok: true, output_paths: [body.output_path] }))
            return
          }
          if (request.url === '/api/studio/media/grok-image-to-video') {
            await writeFile(String(body.output_path), 'generated-video', 'utf8')
            response.end(JSON.stringify({ status: 'done', output_path: body.output_path }))
            return
          }
          response.statusCode = 404
          response.end(JSON.stringify({ error: 'not found' }))
        })().catch((error) => {
          response.statusCode = 500
          response.end(JSON.stringify({ error: String(error) }))
        })
      })
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => resolveListen())
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address.')
      const env = {
        ...process.env,
        AUTH_TOKEN: 'private-test-token',
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
      }
      const skills = resolve(process.cwd(), 'packages/ekko-agent/skills')
      const imageResult = await execFile(process.execPath, [
        join(skills, 'image-gen', 'scripts', 'studio-image-gen.mjs'),
        '--mode', 'edit',
        '--profile', 'work',
        '--image-path', inputImage,
        '--prompt', 'Keep the subject and change the background.',
        '--output-path', outputImage,
      ], { env, encoding: 'utf8' })
      const videoResult = await execFile(process.execPath, [
        join(skills, 'grok-image-to-video', 'scripts', 'grok-image-to-video.mjs'),
        '--profile', 'work',
        '--image-path', inputImage,
        '--prompt', 'Use a slow push-in.',
        '--duration', '6',
        '--output-path', outputVideo,
      ], { env, encoding: 'utf8' })

      expect(JSON.parse(imageResult.stdout)).toMatchObject({
        output_paths: [outputImage],
        output_verified: true,
      })
      expect(JSON.parse(videoResult.stdout)).toMatchObject({
        output_path: outputVideo,
        output_verified: true,
      })
      expect(`${imageResult.stdout}${videoResult.stdout}`).not.toContain('private-test-token')
      expect(requests).toEqual([
        expect.objectContaining({
          path: '/api/studio/media/apikey-image-generate',
          authorization: 'Bearer private-test-token',
          profile: 'work',
          body: expect.objectContaining({ mode: 'edit', image_path: inputImage, output_path: outputImage }),
        }),
        expect.objectContaining({
          path: '/api/studio/media/grok-image-to-video',
          authorization: 'Bearer private-test-token',
          profile: 'work',
          body: expect.objectContaining({ duration: 6, image_path: inputImage, output_path: outputVideo }),
        }),
      ])
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose())
      })
    }
  })
})
