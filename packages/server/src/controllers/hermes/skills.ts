import { readdir } from 'fs/promises'
import { join, resolve } from 'path'
import {
  readConfigYaml, writeConfigYaml,
  safeReadFile, extractDescription, listFilesRecursive, getHermesDir,
} from '../../services/config-helpers'

export async function list(ctx: any) {
  const skillsDir = join(getHermesDir(), 'skills')
  try {
    const config = await readConfigYaml()
    const disabledList: string[] = config.skills?.disabled || []
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const categories: any[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const catDir = join(skillsDir, entry.name)
      const catDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
      const catDescription = catDesc ? catDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''
      const skillEntries = await readdir(catDir, { withFileTypes: true })
      const skills: any[] = []
      for (const se of skillEntries) {
        if (!se.isDirectory()) continue
        const skillMd = await safeReadFile(join(catDir, se.name, 'SKILL.md'))
        if (skillMd) {
          skills.push({ name: se.name, description: extractDescription(skillMd), enabled: !disabledList.includes(se.name) })
        }
      }
      if (skills.length > 0) {
        categories.push({ name: entry.name, description: catDescription, skills })
      }
    }
    categories.sort((a, b) => a.name.localeCompare(b.name))
    for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }
    ctx.body = { categories }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
}

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    const config = await readConfigYaml()
    if (!config.skills) config.skills = {}
    if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
    const disabled = config.skills.disabled as string[]
    const idx = disabled.indexOf(name)
    if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
    else { if (idx === -1) disabled.push(name) }
    await writeConfigYaml(config)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  const skillDir = join(getHermesDir(), 'skills', category, skill)
  try {
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter(f => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = (ctx.params as any).path
  const hd = getHermesDir()
  const fullPath = resolve(join(hd, 'skills', filePath))
  if (!fullPath.startsWith(join(hd, 'skills'))) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const content = await safeReadFile(fullPath)
  if (content === null) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}
