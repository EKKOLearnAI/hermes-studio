// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockFilesApi = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  mkDir: vi.fn(),
  copyFile: vi.fn(),
  uploadFiles: vi.fn(),
}))

vi.mock('@/api/hermes/files', () => mockFilesApi)

import { getLanguageFromPath, isPreviewableFile, isTextFile, useFilesStore } from '@/stores/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

describe('files store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('detects special workspace filenames and extensionless text files', () => {
    expect(getLanguageFromPath('Dockerfile')).toBe('dockerfile')
    expect(getLanguageFromPath('Makefile')).toBe('makefile')
    expect(getLanguageFromPath('CMakeLists.txt')).toBe('cmake')
    expect(getLanguageFromPath('.gitignore')).toBe('gitignore')
    expect(getLanguageFromPath('.dockerignore')).toBe('gitignore')
    expect(getLanguageFromPath('README')).toBe('plaintext')

    expect(isTextFile('README')).toBe(true)
    expect(isTextFile('LICENSE')).toBe(true)
    expect(isTextFile('.env.local')).toBe(true)
    expect(isTextFile('script.ts')).toBe(true)
    expect(isTextFile('unknown-extensionless-binary')).toBe(false)
    expect(isPreviewableFile('README')).toBe(true)
    expect(isPreviewableFile('archive.zip')).toBe(false)
    expect(isPreviewableFile('font.woff2')).toBe(false)
    expect(isPreviewableFile('module.wasm')).toBe(false)
  })

  it('opens text previews with detected syntax language', async () => {
    mockFilesApi.readFile.mockResolvedValue({
      content: 'FROM node:20\nRUN npm test\n',
      path: 'Dockerfile',
      size: 27,
    })

    const store = useFilesStore()
    const entry: FileEntry = {
      name: 'Dockerfile',
      path: 'Dockerfile',
      isDir: false,
      size: 27,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await store.openPreview(entry)

    expect(mockFilesApi.readFile).toHaveBeenCalledWith('Dockerfile', null)
    expect(store.previewFile).toEqual({
      path: 'Dockerfile',
      profile: null,
      type: 'text',
      content: 'FROM node:20\nRUN npm test\n',
      language: 'dockerfile',
    })
  })

  it('resets profile scope for unscoped file panels', async () => {
    mockFilesApi.listFiles.mockResolvedValue({ entries: [], path: '' })

    const store = useFilesStore()

    await store.fetchEntries('', { profile: 'reviewer' })
    await store.fetchEntries('', { profile: null })

    expect(store.currentProfile).toBeNull()
    expect(mockFilesApi.listFiles).toHaveBeenLastCalledWith('', null)
  })

  it('keeps an explicit profile scope for config editor actions', async () => {
    mockFilesApi.listFiles.mockResolvedValue({ entries: [], path: '' })
    mockFilesApi.readFile.mockResolvedValue({
      content: 'model:\n  default: gpt-5.4\n',
      path: 'config.yaml',
      size: 28,
    })

    const store = useFilesStore()

    await store.fetchEntries('', { profile: 'reviewer' })
    await store.openEditor('config.yaml')
    store.editingFile!.content = 'model:\n  default: gpt-5.4-mini\n'
    await store.saveEditor()

    expect(store.currentProfile).toBe('reviewer')
    expect(mockFilesApi.listFiles).toHaveBeenCalledWith('', 'reviewer')
    expect(mockFilesApi.readFile).toHaveBeenCalledWith('config.yaml', 'reviewer')
    expect(mockFilesApi.writeFile).toHaveBeenCalledWith('config.yaml', 'model:\n  default: gpt-5.4-mini\n', 'reviewer')
  })

  it('opens image previews without reading file contents', async () => {
    const store = useFilesStore()
    const entry: FileEntry = {
      name: 'diagram.png',
      path: 'diagram.png',
      isDir: false,
      size: 128,
      modTime: '2026-06-02T00:00:00.000Z',
    }

    await store.openPreview(entry)

    expect(mockFilesApi.readFile).not.toHaveBeenCalled()
    expect(store.previewFile).toEqual({
      path: 'diagram.png',
      profile: null,
      type: 'image',
    })
  })
})
