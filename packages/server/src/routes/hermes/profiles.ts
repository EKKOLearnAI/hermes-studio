import Router from '@koa/router'
import { createReadStream, existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir, homedir } from 'os'
import YAML from 'js-yaml'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { getGatewayManager } from './gateways'
import { logger } from '../../services/logger'

export const profileRoutes = new Router()

// GET /api/profiles - List all profiles
profileRoutes.get('/api/hermes/profiles', async (ctx) => {
  try {
    const profiles = await hermesCli.listProfiles()
    ctx.body = { profiles }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/profiles - Create a new profile
profileRoutes.post('/api/hermes/profiles', async (ctx) => {
  const { name, clone } = ctx.request.body as { name?: string; clone?: boolean }

  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }

  try {
    const output = await hermesCli.createProfile(name, clone)

    // 创建完成后启动该 profile 的网关
    const mgr = getGatewayManager()
    if (mgr) {
      try { await mgr.start(name) } catch (err: any) {
        logger.error(err, 'Failed to start gateway for profile "%s"', name)
      }
    }

    ctx.body = { success: true, message: output.trim() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// GET /api/profiles/:name - Get profile details
profileRoutes.get('/api/hermes/profiles/:name', async (ctx) => {
  const { name } = ctx.params

  try {
    const profile = await hermesCli.getProfile(name)
    ctx.body = { profile }
  } catch (err: any) {
    ctx.status = err.message.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
})

// DELETE /api/profiles/:name - Delete a profile
profileRoutes.delete('/api/hermes/profiles/:name', async (ctx) => {
  const { name } = ctx.params

  if (name === 'default') {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete the default profile' }
    return
  }

  try {
    // Stop gateway for this profile before deleting
    const mgr = getGatewayManager()
    if (mgr) {
      try { await mgr.stop(name) } catch { }
    }

    const ok = await hermesCli.deleteProfile(name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/profiles/:name/rename - Rename a profile
profileRoutes.post('/api/hermes/profiles/:name/rename', async (ctx) => {
  const { name } = ctx.params
  const { new_name } = ctx.request.body as { new_name?: string }

  if (!new_name) {
    ctx.status = 400
    ctx.body = { error: 'Missing new_name' }
    return
  }

  try {
    const ok = await hermesCli.renameProfile(name, new_name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// PUT /api/profiles/active - Switch active profile
profileRoutes.put('/api/hermes/profiles/active', async (ctx) => {
  const { name } = ctx.request.body as { name?: string }

  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }

  try {
    // 1. Switch profile only (no gateway stop/restart)
    const output = await hermesCli.useProfile(name)
    await new Promise(r => setTimeout(r, 1000))

    // 2. Update GatewayManager active profile
    const mgr = getGatewayManager()
    if (mgr) {
      mgr.setActiveProfile(name)
    }

    // 3. Ensure api_server config for new profile
    try {
      const detail = await hermesCli.getProfile(name)
      logger.debug('Profile detail.path = %s', detail.path)
      if (!existsSync(join(detail.path, 'config.yaml'))) {
        // No config.yaml — run setup --reset to create full default config
        try { await hermesCli.setupReset() } catch { }
      }
      // Create .env if target has none
      const profileEnv = join(detail.path, '.env')
      if (!existsSync(profileEnv)) {
        writeFileSync(profileEnv, '# Hermes Agent Environment Configuration\n', 'utf-8')
        logger.info('Created .env for: %s', detail.path)
      }
    } catch (err: any) {
      logger.error(err, 'Ensure config failed')
    }

    ctx.body = { success: true, message: output.trim() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/profiles/:name/export - Export profile to archive and download
profileRoutes.post('/api/hermes/profiles/:name/export', async (ctx) => {
  const { name } = ctx.params
  const outputPath = join(tmpdir(), `hermes-profile-${name}.tar.gz`)

  try {
    await hermesCli.exportProfile(name, outputPath)

    if (!existsSync(outputPath)) {
      ctx.status = 500
      ctx.body = { error: 'Export file not found' }
      return
    }

    const filename = basename(outputPath)
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Type', 'application/gzip')
    ctx.body = createReadStream(outputPath)

    // Clean up temp file after response ends
    ctx.res.on('finish', () => {
      try { unlinkSync(outputPath) } catch { }
    })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// POST /api/profiles/import - Import profile from uploaded archive
profileRoutes.post('/api/hermes/profiles/import', async (ctx) => {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }

  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }

  const tmpDir = join(tmpdir(), 'hermes-import')
  await mkdir(tmpDir, { recursive: true })

  // Read raw body and parse multipart
  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('latin1')
  const parts = body.split(boundary).slice(1, -1)

  let archivePath = ''

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const header = part.substring(0, headerEnd)
    const data = part.substring(headerEnd + 4, part.length - 2)

    const filenameMatch = header.match(/filename="([^"]+)"/)
    if (!filenameMatch) continue

    const filename = filenameMatch[1]
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    if (!['.gz', '.tar.gz', '.zip', '.tgz'].includes(ext)) continue

    archivePath = join(tmpDir, filename)
    await writeFile(archivePath, Buffer.from(data, 'binary'))
    break
  }

  if (!archivePath) {
    ctx.status = 400
    ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)' }
    return
  }

  try {
    const result = await hermesCli.importProfile(archivePath)

    // Clean up temp file
    try { unlinkSync(archivePath) } catch { }

    ctx.body = { success: true, message: result.trim() }
  } catch (err: any) {
    try { unlinkSync(archivePath) } catch { }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
