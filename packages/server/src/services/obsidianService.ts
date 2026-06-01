import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname, join, relative } from 'path'

interface ParsedMarkdownNote {
  title: string
  path: string
  frontmatter: Record<string, string | string[]>
  body: string
}

interface SearchResult {
  note: ParsedMarkdownNote
  score: number
  excerpt: string
}

const DEFAULT_OBSIDIAN_VAULT_PATH = '/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge'
const MAX_NOTE_BYTES = 512_000
const MAX_SEARCH_FILES = 1200
const DEFAULT_CONTEXT_CHARS = 3600
const DAILY_BRIEFINGS_DIR = 'Daily Briefings'
const SKIPPED_DIRS = new Set([
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
  '.openclaw-wiki',
])

export function getObsidianVaultPath(): string {
  return (
    process.env.NEXUS_OBSIDIAN_VAULT_PATH ||
    process.env.OBSIDIAN_VAULT_PATH ||
    DEFAULT_OBSIDIAN_VAULT_PATH
  ).trim()
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseFrontmatterValue(raw: string): string | string[] {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  if (value.includes('#')) {
    const tags = value.match(/#[\p{L}\p{N}_\/-]+/gu)
    if (tags?.length) return tags.map((tag) => tag.slice(1))
  }
  return value.replace(/^['"]|['"]$/g, '')
}

export function parseMarkdownNote(filePath: string, raw: string): ParsedMarkdownNote {
  const frontmatter: Record<string, string | string[]> = {}
  let body = raw
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)

  if (match) {
    body = raw.slice(match[0].length)
    for (const line of match[1].split('\n')) {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex <= 0) continue
      const key = line.slice(0, separatorIndex).trim()
      const value = line.slice(separatorIndex + 1)
      if (key) frontmatter[key] = parseFrontmatterValue(value)
    }
  }

  return {
    title: basename(filePath, extname(filePath)),
    path: filePath,
    frontmatter,
    body: normalizeText(body),
  }
}

async function walkMarkdownFiles(dirPath: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_SEARCH_FILES) return files

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    if (files.length >= MAX_SEARCH_FILES) break
    if (entry.name.startsWith('.') && entry.name !== '.md') continue
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walkMarkdownFiles(fullPath, files)
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath)
  }

  return files
}

function scoreNote(note: ParsedMarkdownNote, keywords: string[]): number {
  const title = note.title.toLowerCase()
  const body = note.body.toLowerCase()
  const metadata = JSON.stringify(note.frontmatter).toLowerCase()
  let score = 0

  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase()
    if (!normalized) continue
    if (title.includes(normalized)) score += 5
    if (metadata.includes(normalized)) score += 3
    if (body.includes(normalized)) score += 1
  }

  return score
}

function makeExcerpt(note: ParsedMarkdownNote, keywords: string[], maxChars = 620): string {
  const body = normalizeText(note.body)
  const lowerBody = body.toLowerCase()
  const keyword = keywords.find((item) => lowerBody.includes(item.toLowerCase()))
  const hitIndex = keyword ? lowerBody.indexOf(keyword.toLowerCase()) : 0
  const start = Math.max(0, hitIndex - 180)
  const excerpt = body.slice(start, start + maxChars)
  return normalizeText(`${start > 0 ? '...' : ''}${excerpt}${start + maxChars < body.length ? '...' : ''}`)
}

function formatSearchContext(results: SearchResult[], vaultPath: string, maxChars: number): string {
  if (results.length === 0) return ''

  const chunks: string[] = ['[Obsidian WIKI 檢索結果]']
  for (const result of results) {
    const tags = result.note.frontmatter.tags || result.note.frontmatter.tag || ''
    const tagText = Array.isArray(tags) ? tags.join(', ') : tags
    const header = `- ${result.note.title} (${relative(vaultPath, result.note.path)})${tagText ? ` tags=${tagText}` : ''}`
    chunks.push(`${header}\n  ${result.excerpt}`)
  }

  const context = chunks.join('\n')
  return context.length > maxChars ? `${context.slice(0, maxChars - 1)}…` : context
}

export async function searchNotes(keywords: string[], maxChars = DEFAULT_CONTEXT_CHARS): Promise<string> {
  const normalizedKeywords = Array.from(new Set(
    keywords.map((keyword) => keyword.trim()).filter(Boolean),
  ))
  if (normalizedKeywords.length === 0) return ''

  const vaultPath = getObsidianVaultPath()
  if (!vaultPath || !existsSync(vaultPath)) return ''

  const files = await walkMarkdownFiles(vaultPath)
  const results: SearchResult[] = []

  for (const filePath of files) {
    try {
      const raw = await readFile(filePath, { encoding: 'utf-8', flag: 'r' })
      if (Buffer.byteLength(raw, 'utf-8') > MAX_NOTE_BYTES) continue
      const note = parseMarkdownNote(filePath, raw)
      const score = scoreNote(note, normalizedKeywords)
      if (score <= 0) continue
      results.push({
        note,
        score,
        excerpt: makeExcerpt(note, normalizedKeywords),
      })
    } catch {
      continue
    }
  }

  results.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title))
  return formatSearchContext(results.slice(0, 6), vaultPath, maxChars)
}

function sanitizeDateSlug(dateStr: string): string {
  const trimmed = dateStr.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return new Date().toISOString().slice(0, 10)
}

function ensureDailyBriefingFrontmatter(dateStr: string, content: string): string {
  const normalized = content.replace(/\r/g, '').trim()
  if (normalized.startsWith('---\n')) return `${normalized}\n`

  return [
    '---',
    'type: daily_briefing',
    `date: ${dateStr}`,
    'status: unread',
    '---',
    '',
    normalized,
    '',
  ].join('\n')
}

export async function writeDailyBriefing(dateStr: string, content: string): Promise<boolean> {
  const vaultPath = getObsidianVaultPath()
  const safeDate = sanitizeDateSlug(dateStr)
  if (!vaultPath || !content.trim()) return false

  try {
    const targetDir = join(vaultPath, DAILY_BRIEFINGS_DIR)
    await mkdir(targetDir, { recursive: true })
    const targetPath = join(targetDir, `${safeDate}-${Date.now()}-戰術晨報.md`)
    await writeFile(targetPath, ensureDailyBriefingFrontmatter(safeDate, content), 'utf-8')
    return true
  } catch (error) {
    console.warn('[Obsidian] Daily briefing write skipped:', error instanceof Error ? error.message : error)
    return false
  }
}

export const searchWIKI = searchNotes
