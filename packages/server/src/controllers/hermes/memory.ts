import { writeFile } from 'fs/promises'
import { join } from 'path'
import { safeReadFile, safeStat, getHermesDir } from '../../services/config-helpers'

export async function get(ctx: any) {
  const hd = getHermesDir()
  const memoryPath = join(hd, 'memories', 'MEMORY.md')
  const userPath = join(hd, 'memories', 'USER.md')
  const soulPath = join(hd, 'SOUL.md')
  const [memory, user, soul, memoryStat, userStat, soulStat] = await Promise.all([
    safeReadFile(memoryPath), safeReadFile(userPath), safeReadFile(soulPath),
    safeStat(memoryPath), safeStat(userPath), safeStat(soulPath),
  ])
  ctx.body = {
    memory: memory || '', user: user || '', soul: soul || '',
    memory_mtime: memoryStat?.mtime || null, user_mtime: userStat?.mtime || null, soul_mtime: soulStat?.mtime || null,
  }
}

export async function save(ctx: any) {
  const { section, content } = ctx.request.body as { section: string; content: string }
  if (!section || !content) {
    ctx.status = 400
    ctx.body = { error: 'Missing section or content' }
    return
  }
  if (section !== 'memory' && section !== 'user' && section !== 'soul') {
    ctx.status = 400
    ctx.body = { error: 'Section must be "memory", "user", or "soul"' }
    return
  }
  let filePath: string
  if (section === 'soul') {
    filePath = join(getHermesDir(), 'SOUL.md')
  } else {
    const fileName = section === 'memory' ? 'MEMORY.md' : 'USER.md'
    filePath = join(getHermesDir(), 'memories', fileName)
  }
  try {
    await writeFile(filePath, content, 'utf-8')
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
