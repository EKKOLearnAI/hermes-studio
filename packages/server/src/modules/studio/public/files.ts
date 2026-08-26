import { readFile, stat } from 'fs/promises'

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const result = await stat(filePath)
    return { mtime: Math.round(result.mtimeMs) }
  } catch {
    return null
  }
}
