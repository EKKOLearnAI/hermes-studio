import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as filesApi from '@/api/hermes/files'
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

function getLanguageFromPath(filePath: string): string {
  const name = filePath.split('/').pop() || ''
  if (name === 'Dockerfile') return 'dockerfile'
  if (name === 'Makefile') return 'makefile'
  const ext = '.' + name.split('.').pop()?.toLowerCase()
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
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.zip', '.gz', '.tar', '.7z', '.rar', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp3', '.mp4', '.wav', '.webm', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite'])
  return !binaryExts.has(getFileExt(name))
}

export const useFilesStore = defineStore('files', () => {
  const currentPath = ref('')
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  const sortBy = ref<'name' | 'size' | 'modTime'>('name')
  const sortOrder = ref<'asc' | 'desc'>('asc')

  const editingFile = ref<{
    path: string
    content: string
    originalContent: string
    language: string
  } | null>(null)

  const previewFile = ref<{
    path: string
    type: 'image' | 'markdown'
    content?: string
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

  async function fetchEntries(path?: string) {
    if (path !== undefined) currentPath.value = path
    loading.value = true
    try {
      const result = await filesApi.listFiles(currentPath.value)
      entries.value = result.entries
    } catch (err) {
      console.error('Failed to fetch files:', err)
      throw err
    } finally {
      loading.value = false
    }
  }

  function navigateTo(path: string) { return fetchEntries(path) }
  function navigateUp() {
    const parts = currentPath.value.split('/').filter(Boolean)
    parts.pop()
    return fetchEntries(parts.join('/'))
  }

  async function openEditor(filePath: string) {
    const result = await filesApi.readFile(filePath)
    editingFile.value = {
      path: filePath,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(filePath),
    }
  }

  async function saveEditor() {
    if (!editingFile.value) return
    await filesApi.writeFile(editingFile.value.path, editingFile.value.content)
    editingFile.value.originalContent = editingFile.value.content
  }

  function closeEditor() { editingFile.value = null }

  async function openPreview(entry: FileEntry) {
    if (isImageFile(entry.name)) {
      previewFile.value = { path: entry.path, type: 'image' }
    } else if (isMarkdownFile(entry.name)) {
      const result = await filesApi.readFile(entry.path)
      previewFile.value = { path: entry.path, type: 'markdown', content: result.content }
    }
  }

  function closePreview() { previewFile.value = null }

  async function createDir(name: string) {
    const path = currentPath.value ? `${currentPath.value}/${name}` : name
    await filesApi.mkDir(path)
    await fetchEntries()
  }

  async function createFile(name: string) {
    const path = currentPath.value ? `${currentPath.value}/${name}` : name
    await filesApi.writeFile(path, '')
    await fetchEntries()
  }

  async function deleteEntry(entry: FileEntry) {
    await filesApi.deleteFile(entry.path, entry.isDir)
    await fetchEntries()
  }

  async function renameEntry(entry: FileEntry, newName: string) {
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    await filesApi.renameFile(entry.path, newPath)
    await fetchEntries()
  }

  async function copyEntry(entry: FileEntry, destPath: string) {
    await filesApi.copyFile(entry.path, destPath)
    await fetchEntries()
  }

  async function uploadFiles(files: File[]) {
    await filesApi.uploadFiles(currentPath.value, files)
    await fetchEntries()
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
    currentPath, entries, loading, sortBy, sortOrder,
    editingFile, previewFile,
    pathSegments, sortedEntries, hasUnsavedChanges,
    fetchEntries, navigateTo, navigateUp,
    openEditor, saveEditor, closeEditor,
    openPreview, closePreview,
    createDir, createFile, deleteEntry, renameEntry, copyEntry,
    uploadFiles, setSort,
  }
})
