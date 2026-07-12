import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as filesApi from '@/api/hermes/files'
import {
  copySessionWorkspaceFile,
  deleteSessionWorkspaceFile,
  listSessionWorkspaceFiles,
  mkdirSessionWorkspaceFile,
  readSessionWorkspaceFile,
  renameSessionWorkspaceFile,
  writeSessionWorkspaceFile,
} from '@/api/hermes/sessions'
import type { FileEntry } from '@/api/hermes/files'

const EXT_LANG_MAP: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.jsonc': 'json',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.sql': 'sql',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.vue': 'html',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
}

const SPECIAL_FILE_LANG_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
}

const TEXT_BASENAMES = new Set([
  ...Object.keys(SPECIAL_FILE_LANG_MAP),
  'README',
  'LICENSE',
  'NOTICE',
  'CHANGELOG',
  'CONTRIBUTING',
])

const TEXT_EXTS = new Set([
  '.txt', '.text', '.log', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.json', '.jsonc',
  '.html', '.htm', '.css', '.scss', '.less',
  '.md', '.markdown',
  '.py', '.pyw',
  '.yaml', '.yml', '.xml',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx',
  '.toml', '.ini', '.env', '.conf', '.cfg', '.properties',
  '.vue', '.svelte', '.astro',
  '.dockerfile', '.graphql', '.gql',
  '.lua', '.r', '.rb', '.php', '.swift', '.kt', '.kts',
  '.diff', '.patch', '.lock',
])

export function getLanguageFromPath(filePath: string): string {
  const name = filePath.split('/').pop() || ''
  const specialLanguage = SPECIAL_FILE_LANG_MAP[name]
  if (specialLanguage) return specialLanguage
  const ext = getFileExt(name)
  return EXT_LANG_MAP[ext] || 'plaintext'
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])

function getFileExt(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(getFileExt(name))
}

export function isMarkdownFile(name: string): boolean {
  const ext = getFileExt(name)
  return ext === '.md' || ext === '.markdown'
}

export function isTextFile(name: string): boolean {
  const basename = name.split('/').pop() || ''
  if (TEXT_BASENAMES.has(basename) || basename.startsWith('.env.')) return true
  return TEXT_EXTS.has(getFileExt(basename))
}

export function isPreviewableFile(name: string): boolean {
  return isImageFile(name) || isMarkdownFile(name) || isTextFile(name)
}

// Returns true if `targetPath` is the same as `changedPath` or lives inside it
// when `changedIsDir` is true. Used to invalidate preview/editor state when
// the underlying file is deleted or renamed.
function isAffected(targetPath: string, changedPath: string, changedIsDir: boolean): boolean {
  if (targetPath === changedPath) return true
  if (changedIsDir && targetPath.startsWith(changedPath + '/')) return true
  return false
}

function normalizeProfile(profile?: string | null): string | null {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || null
}

export const useFilesStore = defineStore('files', () => {
  const currentPath = ref('')
  const currentProfile = ref<string | null>(null)
  const currentWorkspaceSessionId = ref<string | null>(null)
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  const sortBy = ref<'name' | 'size' | 'modTime'>('name')
  const sortOrder = ref<'asc' | 'desc'>('asc')
  let fetchRequestSeq = 0

  const editingFile = ref<{
    path: string
    content: string
    originalContent: string
    language: string
    workspaceSessionId?: string
    workspaceRelativePath?: string
  } | null>(null)

  const previewFile = ref<{
    path: string
    profile?: string | null
    type: 'image' | 'markdown' | 'text'
    content?: string
    language?: string
  } | null>(null)

  const pathSegments = computed(() => {
    if (!currentPath.value) return []
    return currentPath.value.split('/').filter(Boolean)
  })

  const sortedEntries = computed(() => {
    const copy = [...entries.value]
    copy.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let cmp = 0
      switch (sortBy.value) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'size': cmp = a.size - b.size; break
        case 'modTime': cmp = a.modTime.localeCompare(b.modTime); break
      }
      return sortOrder.value === 'asc' ? cmp : -cmp
    })
    return copy
  })

  function resolveProfile(profile?: string | null): string | null {
    return currentWorkspaceSessionId.value ? null : profile === undefined ? currentProfile.value : normalizeProfile(profile)
  }

  function resolveWorkspaceSessionId(sessionId?: string | null): string | null {
    return sessionId === undefined ? currentWorkspaceSessionId.value : normalizeProfile(sessionId)
  }

  async function listEntries(path = currentPath.value): Promise<{ entries: FileEntry[]; path: string; absolutePath?: string }> {
    const workspaceSessionId = currentWorkspaceSessionId.value
    return workspaceSessionId
      ? listSessionWorkspaceFiles(workspaceSessionId, path)
      : filesApi.listFiles(path, currentProfile.value)
  }

  async function fetchDirectory(path: string, options: { profile?: string | null } = {}) {
    const profile = resolveProfile(options.profile)
    return filesApi.listFiles(path, profile)
  }

  async function fetchEntries(path?: string, options: { profile?: string | null; workspaceSessionId?: string | null } = {}) {
    const requestSeq = ++fetchRequestSeq
    if (path !== undefined && path !== currentPath.value) {
      // Switching directory invalidates the current preview; close it so the
      // file list becomes visible again. The editor has its own dirty-check
      // (see hasUnsavedChanges), so we leave editingFile alone here.
      previewFile.value = null
    }
    const previousWorkspaceSessionId = currentWorkspaceSessionId.value
    const previousProfile = currentProfile.value
    const previousPath = currentPath.value
    const nextWorkspaceSessionId = resolveWorkspaceSessionId(options.workspaceSessionId)
    currentWorkspaceSessionId.value = nextWorkspaceSessionId
    const nextProfile = nextWorkspaceSessionId ? null : resolveProfile(options.profile)
    currentProfile.value = nextProfile
    if (path !== undefined) currentPath.value = path
    if (
      previousWorkspaceSessionId !== nextWorkspaceSessionId ||
      previousProfile !== nextProfile ||
      previousPath !== currentPath.value
    ) {
      entries.value = []
    }
    loading.value = true
    try {
      const result = await listEntries(currentPath.value)
      if (requestSeq !== fetchRequestSeq) return
      entries.value = result.entries
    } catch (err) {
      if (requestSeq !== fetchRequestSeq) return
      console.error('Failed to fetch files:', err)
      if (nextWorkspaceSessionId) entries.value = []
      throw err
    } finally {
      if (requestSeq === fetchRequestSeq) loading.value = false
    }
  }

  function navigateTo(path: string, options: { profile?: string | null; workspaceSessionId?: string | null } = {}) { return fetchEntries(path, options) }
  function navigateUp(options: { profile?: string | null; workspaceSessionId?: string | null } = {}) {
    const parts = currentPath.value.split('/').filter(Boolean)
    parts.pop()
    return fetchEntries(parts.join('/'), options)
  }

  async function openEditor(filePath: string, options: { profile?: string | null } = {}) {
    if (currentWorkspaceSessionId.value) {
      await openSessionWorkspaceEditor(currentWorkspaceSessionId.value, filePath)
      return
    }
    const profile = resolveProfile(options.profile)
    currentProfile.value = profile
    const result = await filesApi.readFile(filePath, profile)
    editingFile.value = {
      path: filePath,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(filePath),
    }
  }

  async function openSessionWorkspaceEditor(sessionId: string, filePath: string) {
    const result = await readSessionWorkspaceFile(sessionId, filePath)
    editingFile.value = {
      path: result.path,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(result.path),
      workspaceSessionId: sessionId,
      workspaceRelativePath: result.path,
    }
  }

  async function saveEditor() {
    if (!editingFile.value) return
    if (editingFile.value.workspaceSessionId && editingFile.value.workspaceRelativePath) {
      await writeSessionWorkspaceFile(
        editingFile.value.workspaceSessionId,
        editingFile.value.workspaceRelativePath,
        editingFile.value.content,
      )
    } else {
      await filesApi.writeFile(editingFile.value.path, editingFile.value.content, currentProfile.value)
    }
    editingFile.value.originalContent = editingFile.value.content
  }

  function closeEditor() { editingFile.value = null }

  async function openPreview(entry: FileEntry, options: { profile?: string | null } = {}) {
    const profile = resolveProfile(options.profile)
    currentProfile.value = profile
    if (isImageFile(entry.name)) {
      previewFile.value = { path: entry.path, profile, type: 'image' }
    } else if (isMarkdownFile(entry.name)) {
      const result = currentWorkspaceSessionId.value
        ? await readSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path)
        : await filesApi.readFile(entry.path, profile)
      previewFile.value = { path: entry.path, profile, type: 'markdown', content: result.content }
    } else if (isTextFile(entry.name)) {
      const result = currentWorkspaceSessionId.value
        ? await readSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path)
        : await filesApi.readFile(entry.path, profile)
      previewFile.value = {
        path: entry.path,
        profile,
        type: 'text',
        content: result.content,
        language: getLanguageFromPath(entry.path),
      }
    }
  }

  function closePreview() { previewFile.value = null }

  async function createDir(name: string, targetPath = currentPath.value) {
    const path = targetPath ? `${targetPath}/${name}` : name
    if (currentWorkspaceSessionId.value) await mkdirSessionWorkspaceFile(currentWorkspaceSessionId.value, path)
    else await filesApi.mkDir(path, currentProfile.value)
    await fetchEntries(undefined)
  }

  async function createFile(name: string) {
    const path = currentPath.value ? `${currentPath.value}/${name}` : name
    if (currentWorkspaceSessionId.value) await writeSessionWorkspaceFile(currentWorkspaceSessionId.value, path, '')
    else await filesApi.writeFile(path, '', currentProfile.value)
    await fetchEntries(undefined)
  }

  async function deleteEntry(entry: FileEntry) {
    if (currentWorkspaceSessionId.value) await deleteSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, entry.isDir)
    else await filesApi.deleteFile(entry.path, entry.isDir, currentProfile.value)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries(undefined)
  }

  async function renameEntry(entry: FileEntry, newName: string) {
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    if (currentWorkspaceSessionId.value) await renameSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, newPath)
    else await filesApi.renameFile(entry.path, newPath, currentProfile.value)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries(undefined)
  }

  async function copyEntry(entry: FileEntry, destPath: string) {
    if (currentWorkspaceSessionId.value) await copySessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, destPath)
    else await filesApi.copyFile(entry.path, destPath, currentProfile.value)
    await fetchEntries(undefined)
  }

  async function uploadFiles(files: File[]) {
    if (!currentWorkspaceSessionId.value) {
      await filesApi.uploadFiles(currentPath.value, files, currentProfile.value)
      await fetchEntries(undefined)
      return
    }
    for (const file of files) {
      const path = currentPath.value ? `${currentPath.value}/${file.name}` : file.name
      const content = await file.text()
      await writeSessionWorkspaceFile(currentWorkspaceSessionId.value, path, content)
    }
    await fetchEntries(undefined)
  }

  function setSort(by: 'name' | 'size' | 'modTime') {
    if (sortBy.value === by) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = by
      sortOrder.value = 'asc'
    }
  }

  const hasUnsavedChanges = computed(() => {
    if (!editingFile.value) return false
    return editingFile.value.content !== editingFile.value.originalContent
  })

  return {
    currentPath, currentProfile, currentWorkspaceSessionId, entries, loading, sortBy, sortOrder,
    editingFile, previewFile,
    pathSegments, sortedEntries, hasUnsavedChanges,
    fetchEntries, listEntries, fetchDirectory, navigateTo, navigateUp,
    openEditor, openSessionWorkspaceEditor, saveEditor, closeEditor,
    openPreview, closePreview,
    createDir, createFile, deleteEntry, renameEntry, copyEntry,
    uploadFiles, setSort,
  }
})
