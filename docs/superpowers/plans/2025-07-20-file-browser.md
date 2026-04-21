# 文件浏览器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-featured file browser page to Hermes Web UI with directory tree, file list, Monaco editor, preview, upload, and CRUD operations across local/Docker/SSH/Singularity backends.

**Architecture:** Extend existing FileProvider abstraction with 8 new methods (listDir, stat, writeFile, deleteFile, deleteDir, renameFile, mkDir, copyFile). RESTful API with 9 new endpoints. Vue 3 frontend with Pinia store, 9 new components, Monaco Editor integration.

**Tech Stack:** Vue 3 + Naive UI + Pinia + Monaco Editor (frontend), Koa + @koa/router + node fs/child_process (backend)

---

## File Structure

**New files (13):**
- `packages/server/src/routes/hermes/files.ts` — File management REST routes (9 endpoints)
- `packages/client/src/api/hermes/files.ts` — Frontend API module
- `packages/client/src/stores/hermes/files.ts` — Pinia store
- `packages/client/src/views/hermes/FilesView.vue` — Page container
- `packages/client/src/components/hermes/files/FileTree.vue` — Directory tree (NTree, lazy load)
- `packages/client/src/components/hermes/files/FileList.vue` — File table (NDataTable, sortable)
- `packages/client/src/components/hermes/files/FileBreadcrumb.vue` — Breadcrumb navigation
- `packages/client/src/components/hermes/files/FileToolbar.vue` — Toolbar buttons
- `packages/client/src/components/hermes/files/FileContextMenu.vue` — Right-click context menu
- `packages/client/src/components/hermes/files/FileEditor.vue` — Monaco Editor wrapper
- `packages/client/src/components/hermes/files/FilePreview.vue` — Image/Markdown preview
- `packages/client/src/components/hermes/files/FileUploadModal.vue` — Upload dialog
- `packages/client/src/components/hermes/files/FileRenameModal.vue` — Rename/New file dialog

**Modified files (8):**
- `packages/server/src/services/hermes/file-provider.ts` — Extend FileProvider interface + all 4 backends
- `packages/server/src/routes/hermes/index.ts` — Register file routes before proxy
- `packages/client/src/router/index.ts` — Add `/hermes/files` route
- `packages/client/src/components/layout/AppSidebar.vue` — Add Files nav item in Tools group
- `packages/client/src/i18n/locales/en.ts` — Add `files` section
- `packages/client/src/i18n/locales/zh.ts` — Add `files` section
- `package.json` — Add monaco-editor dependency
- `vite.config.ts` — Add monaco-editor vite config

---

## Task 1: Install Monaco Editor

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`

- [ ] **Step 1: Install monaco-editor**

```bash
cd /Users/wuchunxu/kika/hermes-web-ui
npm install monaco-editor
```

- [ ] **Step 2: Update vite.config.ts for Monaco worker support**

In `vite.config.ts`, add the `optimizeDeps` config so Vite properly bundles Monaco's web workers:

```typescript
// vite.config.ts — add to defineConfig:
  optimizeDeps: {
    include: ['monaco-editor'],
  },
```

The full updated `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { resolve } from 'path'
import pkg from './package.json'

const BACKEND = 'http://127.0.0.1:8648'

function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyRes', (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-cache'
        proxyRes.headers['x-accel-buffering'] = 'no'
      })
    },
  }
}

export default defineConfig({
  root: 'packages/client',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  server: {
    proxy: {
      '/api': createProxyConfig(),
      '/v1': createProxyConfig(),
      '/health': createProxyConfig(),
      '/upload': createProxyConfig(),
      '/webhook': createProxyConfig(),
    },
  },
})
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json vite.config.ts
git commit -m "feat: 添加 monaco-editor 依赖

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Extend FileProvider — Interface + LocalFileProvider

**Files:**
- Modify: `packages/server/src/services/hermes/file-provider.ts`

- [ ] **Step 1: Add types, constants, and expand the FileProvider interface**

At the top of `file-provider.ts`, add the new types and expand the interface. The changes:

1. Add `FileEntry` and `FileStat` interfaces after imports
2. Add `MAX_EDIT_SIZE` constant
3. Add `SENSITIVE_FILES` set
4. Expand `FileProvider` interface with 8 new methods
5. Add `isSensitivePath()` and `resolveHermesPath()` helpers

Add after the existing imports (line 8):

```typescript
import { readdir, mkdir, rm, rename, copyFile as fsCopyFile, writeFile as fsWriteFile } from 'fs/promises'
```

Add after `MAX_DOWNLOAD_SIZE` and `BACKEND_TIMEOUT` (after line 15):

```typescript
// Max edit/upload file size (default 10MB)
export const MAX_EDIT_SIZE = parseInt(process.env.MAX_EDIT_SIZE || '', 10) || 10 * 1024 * 1024

// Sensitive files that should not be written/deleted/renamed
const SENSITIVE_FILES = new Set(['.env', 'auth.json'])

export interface FileEntry {
  name: string
  path: string       // relative to hermes home
  isDir: boolean
  size: number
  modTime: string    // ISO 8601
}

export interface FileStat {
  name: string
  path: string       // relative to hermes home
  isDir: boolean
  size: number
  modTime: string    // ISO 8601
  permissions?: string
}
```

Expand the `FileProvider` interface to include the new methods:

```typescript
export interface FileProvider {
  type: BackendType
  readFile(filePath: string): Promise<Buffer>
  exists(filePath: string): Promise<boolean>
  listDir(dirPath: string): Promise<FileEntry[]>
  stat(filePath: string): Promise<FileStat>
  writeFile(filePath: string, content: Buffer): Promise<void>
  deleteFile(filePath: string): Promise<void>
  deleteDir(dirPath: string): Promise<void>
  renameFile(oldPath: string, newPath: string): Promise<void>
  mkDir(dirPath: string): Promise<void>
  copyFile(srcPath: string, destPath: string): Promise<void>
}
```

Add these helper functions after `isInUploadDir()`:

```typescript
/**
 * Check if a relative path refers to a sensitive file.
 */
export function isSensitivePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/')
  const fileName = parts[parts.length - 1]
  return SENSITIVE_FILES.has(fileName)
}

/**
 * Resolve a relative path to an absolute path under the hermes home directory.
 * Validates path safety (no traversal).
 */
export function resolveHermesPath(relativePath: string): string {
  const homeDir = getActiveProfileDir()
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    return homeDir
  }
  // Normalize and check for traversal
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  const resolved = resolve(homeDir, normalized)
  // Double-check the resolved path is inside homeDir
  if (!resolved.startsWith(homeDir)) {
    throw Object.assign(new Error('Path traversal detected'), { code: 'invalid_path' })
  }
  return resolved
}
```

- [ ] **Step 2: Implement new methods in LocalFileProvider**

Expand the `LocalFileProvider` class with all 8 new methods:

```typescript
export class LocalFileProvider implements FileProvider {
  type: BackendType = 'local'

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    const s = await stat(p)
    if (!s.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not_found' })
    if (s.size > MAX_DOWNLOAD_SIZE) {
      throw Object.assign(new Error(`File too large: ${s.size} bytes`), { code: 'file_too_large' })
    }
    return readFile(p)
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      const p = validatePath(filePath)
      const s = await stat(p)
      return s.isFile()
    } catch {
      return false
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    const s = await stat(p)
    if (!s.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'not_a_directory' })
    const entries = await readdir(p, { withFileTypes: true })
    const result: FileEntry[] = []
    for (const entry of entries) {
      try {
        const entryPath = resolve(p, entry.name)
        const entryStat = await stat(entryPath)
        // Compute relative path from hermes home
        const homeDir = getActiveProfileDir()
        const relPath = entryPath.startsWith(homeDir)
          ? entryPath.slice(homeDir.length + 1).replace(/\\/g, '/')
          : entry.name
        result.push({
          name: entry.name,
          path: relPath,
          isDir: entry.isDirectory(),
          size: entryStat.size,
          modTime: entryStat.mtime.toISOString(),
        })
      } catch {
        // Skip entries we can't stat (permission denied, etc.)
      }
    }
    return result
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    const s = await stat(p)
    const homeDir = getActiveProfileDir()
    const relPath = p.startsWith(homeDir)
      ? p.slice(homeDir.length + 1).replace(/\\/g, '/')
      : basename(p)
    return {
      name: basename(p),
      path: relPath,
      isDir: s.isDirectory(),
      size: s.size,
      modTime: s.mtime.toISOString(),
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    await fsWriteFile(p, content)
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    const s = await stat(p)
    if (!s.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not_a_file' })
    await rm(p)
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    const s = await stat(p)
    if (!s.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'not_a_directory' })
    await rm(p, { recursive: true })
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    await rename(op, np)
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    await mkdir(p, { recursive: true })
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    await fsCopyFile(sp, dp)
  }
}
```

**Note:** There is a naming conflict with the imported `stat` from `fs/promises` and the class method `stat`. Use the imported one as `fsStat` or rename. To avoid conflicts, rename the `stat` import at the top of the file:

```typescript
import { readFile, stat as fsStat } from 'fs/promises'
```

Then update all usages of `stat()` from fs/promises to `fsStat()` throughout the file, including inside the `LocalFileProvider`.

- [ ] **Step 3: Verify the file compiles**

```bash
npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/hermes/file-provider.ts
git commit -m "feat: 扩展 FileProvider 接口，添加 LocalFileProvider 文件管理方法

- 新增 listDir/stat/writeFile/deleteFile/deleteDir/renameFile/mkDir/copyFile
- 新增 FileEntry/FileStat 类型、isSensitivePath/resolveHermesPath 辅助函数
- MAX_EDIT_SIZE 常量 (10MB)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Extend Docker/SSH/Singularity FileProviders

**Files:**
- Modify: `packages/server/src/services/hermes/file-provider.ts`

All three remote providers share a similar pattern: execute commands via `docker exec`, `ssh`, or `singularity exec` and parse the output.

- [ ] **Step 1: Add ls output parser helper**

Add this helper function before the Docker class:

```typescript
/**
 * Parse `ls -la --time-style=+%Y-%m-%dT%H:%M:%S` output into FileEntry[].
 * Example line: `drwxr-xr-x 2 user group 4096 2025-07-20T10:30:00 dirname`
 * Skips the "total N" line and entries "." and "..".
 */
function parseLsOutput(output: string, parentRelPath: string): FileEntry[] {
  const entries: FileEntry[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('total ')) continue
    // Split into at most 7 parts: permissions, links, user, group, size, date, name
    const parts = trimmed.split(/\s+/)
    if (parts.length < 7) continue
    const permissions = parts[0]
    const size = parseInt(parts[4], 10) || 0
    const modTime = parts[5]
    const name = parts.slice(6).join(' ')
    if (name === '.' || name === '..') continue
    const isDir = permissions.startsWith('d')
    const relPath = parentRelPath ? `${parentRelPath}/${name}` : name
    entries.push({ name, path: relPath, isDir, size, modTime: modTime.includes('T') ? modTime : new Date(modTime).toISOString() })
  }
  return entries
}

/**
 * Parse `stat --format='%n|%F|%s|%Y' <path>` output (GNU coreutils).
 * Also handles `stat -c '%n|%F|%s|%Y' <path>`.
 * Output: `/path/to/file|regular file|1234|1721500000`
 */
function parseStatOutput(output: string, relativePath: string): FileStat {
  const parts = output.trim().split('|')
  if (parts.length < 4) throw Object.assign(new Error('Failed to parse stat output'), { code: 'backend_error' })
  const name = basename(parts[0])
  const fileType = parts[1].toLowerCase()
  const size = parseInt(parts[2], 10) || 0
  const modEpoch = parseInt(parts[3], 10) || 0
  const isDir = fileType.includes('directory')
  return {
    name,
    path: relativePath,
    isDir,
    size,
    modTime: new Date(modEpoch * 1000).toISOString(),
  }
}
```

Also add the `basename` import at the top if not already imported:

```typescript
import { resolve, normalize, isAbsolute, basename } from 'path'
```

- [ ] **Step 2: Implement DockerFileProvider new methods**

Add all 8 new methods to `DockerFileProvider`:

```typescript
export class DockerFileProvider implements FileProvider {
  type: BackendType = 'docker'
  private containerName: string

  constructor(containerName: string) {
    this.containerName = containerName
  }

  // ... existing readFile and exists methods stay unchanged ...

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', p,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relParent = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr))) {
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'stat', '-c', '%n|%F|%s|%Y', p,
      ], { timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relPath = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', [
        'exec', '-i', this.containerName, 'sh', '-c', `cat > '${p.replace(/'/g, "'\\''")}'`,
      ], { timeout: BACKEND_TIMEOUT, input: content } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'rm', p,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'rm', '-rf', p,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'mv', op, np,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'mkdir', '-p', p,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'cp', sp, dp,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }
}
```

- [ ] **Step 3: Implement SSHFileProvider new methods**

All SSH methods use `shellEscape()` for safe path passing:

```typescript
export class SSHFileProvider implements FileProvider {
  // ... existing constructor, sshArgs(), shellEscape(), readFile, exists stay unchanged ...

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), `ls -la --time-style=+%Y-%m-%dT%H:%M:%S ${this.shellEscape(p)}`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relParent = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr))) {
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), `stat -c '%n|%F|%s|%Y' ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relPath = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `cat > ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT, input: content } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `rm ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `rm -rf ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `mv ${this.shellEscape(op)} ${this.shellEscape(np)}`,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `mkdir -p ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `cp ${this.shellEscape(sp)} ${this.shellEscape(dp)}`,
      ], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }
}
```

- [ ] **Step 4: Implement SingularityFileProvider new methods**

Same pattern as Docker, using `singularity exec`:

```typescript
export class SingularityFileProvider implements FileProvider {
  // ... existing constructor, readFile, exists stay unchanged ...

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', p,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relParent = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr))) {
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'stat', '-c', '%n|%F|%s|%Y', p,
      ], { timeout: BACKEND_TIMEOUT })
      const homeDir = getActiveProfileDir()
      const relPath = p.startsWith(homeDir) ? p.slice(homeDir.length + 1).replace(/\\/g, '/') : basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', [
        'exec', this.imagePath, 'sh', '-c', `cat > '${p.replace(/'/g, "'\\''")}'`,
      ], { timeout: BACKEND_TIMEOUT, input: content } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'rm', p], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'rm', '-rf', p], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'mv', op, np], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'mkdir', '-p', p], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'cp', sp, dp], { timeout: BACKEND_TIMEOUT })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }
}
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/hermes/file-provider.ts
git commit -m "feat: 实现 Docker/SSH/Singularity 文件管理方法

- parseLsOutput/parseStatOutput 解析远程命令输出
- 所有远程 backend 支持 listDir/stat/writeFile/deleteFile/deleteDir/renameFile/mkDir/copyFile
- SSH 路径使用 shellEscape 防注入

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Server File Management Routes

**Files:**
- Create: `packages/server/src/routes/hermes/files.ts`

- [ ] **Step 1: Create the file routes module**

Create `packages/server/src/routes/hermes/files.ts` with all 9 endpoints:

```typescript
import Router from '@koa/router'
import { basename } from 'path'
import {
  createFileProvider,
  resolveHermesPath,
  isSensitivePath,
  MAX_EDIT_SIZE,
  type FileEntry,
} from '../../services/hermes/file-provider'
import { getActiveProfileDir } from '../../services/hermes/hermes-profile'

export const fileRoutes = new Router()

// Error handler helper
function handleError(ctx: any, err: any) {
  const code = err.code || 'unknown'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    not_found: 404,
    ENOENT: 404,
    already_exists: 409,
    permission_denied: 403,
    file_too_large: 413,
    not_a_directory: 400,
    not_a_file: 400,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

// GET /api/hermes/files/list?path=
fileRoutes.get('/api/hermes/files/list', async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  try {
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    const entries = await provider.listDir(absPath)
    // Sort: directories first, then by name
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { entries, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/stat?path=
fileRoutes.get('/api/hermes/files/stat', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    const info = await provider.stat(absPath)
    ctx.body = info
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    const data = await provider.readFile(absPath)
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    // Return as UTF-8 text
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// PUT /api/hermes/files/write  body: { path, content }
fileRoutes.put('/api/hermes/files/write', async (ctx) => {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', async (ctx) => {
  const { path: relativePath, recursive } = ctx.request.body as { path?: string; recursive?: boolean }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    if (recursive) {
      await provider.deleteDir(absPath)
    } else {
      await provider.deleteFile(absPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/rename  body: { oldPath, newPath }
fileRoutes.post('/api/hermes/files/rename', async (ctx) => {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (isSensitivePath(oldPath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absOld = resolveHermesPath(oldPath)
    const absNew = resolveHermesPath(newPath)
    const provider = await createFileProvider()
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', async (ctx) => {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveHermesPath(relativePath)
    const provider = await createFileProvider()
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', async (ctx) => {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  try {
    const absSrc = resolveHermesPath(srcPath)
    const absDest = resolveHermesPath(destPath)
    const provider = await createFileProvider()
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', async (ctx) => {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundary = '--' + contentType.split('boundary=')[1]
  if (!boundary || boundary === '--undefined') {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  // Read raw body as Buffer
  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const boundaryBuf = Buffer.from(boundary)
  const parts = splitMultipart(raw, boundaryBuf)
  const provider = await createFileProvider()
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    // Parse filename
    let filename = ''
    const filenameStarMatch = header.match(/filename\*=UTF-8''(.+)/i)
    if (filenameStarMatch) {
      filename = decodeURIComponent(filenameStarMatch[1])
    } else {
      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (!filenameMatch) continue
      filename = filenameMatch[1]
    }

    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File ${filename} too large`, code: 'file_too_large' }
      return
    }

    const filePath = targetDir ? `${targetDir}/${filename}` : filename
    if (isSensitivePath(filePath)) {
      ctx.status = 403
      ctx.body = { error: `Cannot overwrite sensitive file: ${filename}`, code: 'permission_denied' }
      return
    }

    const absPath = resolveHermesPath(filePath)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})

/**
 * Split multipart Buffer by boundary.
 */
function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      const partStart = start + 2
      parts.push(raw.subarray(partStart, idx))
    }
    start = idx + boundary.length
  }
  return parts
}
```

- [ ] **Step 2: Register file routes in index.ts**

Modify `packages/server/src/routes/hermes/index.ts` to import and register file routes BEFORE proxy routes:

Add import:
```typescript
import { fileRoutes } from './files'
```

Add registration before `proxyRoutes`:
```typescript
hermesRoutes.use(fileRoutes.routes())
hermesRoutes.use(proxyRoutes.routes())
```

The complete updated `index.ts`:

```typescript
import Router from '@koa/router'
import { sessionRoutes } from './sessions'
import { profileRoutes } from './profiles'
import { configRoutes } from './config'
import { fsRoutes } from './filesystem'
import { logRoutes } from './logs'
import { weixinRoutes } from './weixin'
import { codexAuthRoutes } from './codex-auth'
import { gatewayRoutes } from './gateways'
import { downloadRoutes } from './download'
import { fileRoutes } from './files'
import { proxyRoutes, proxyMiddleware } from './proxy'
import { setupTerminalWebSocket } from './terminal'

export const hermesRoutes = new Router()

hermesRoutes.use(sessionRoutes.routes())
hermesRoutes.use(profileRoutes.routes())
hermesRoutes.use(configRoutes.routes())
hermesRoutes.use(fsRoutes.routes())
hermesRoutes.use(logRoutes.routes())
hermesRoutes.use(weixinRoutes.routes())
hermesRoutes.use(codexAuthRoutes.routes())
hermesRoutes.use(gatewayRoutes.routes())
hermesRoutes.use(downloadRoutes.routes())
hermesRoutes.use(fileRoutes.routes())
hermesRoutes.use(proxyRoutes.routes())

export { setupTerminalWebSocket, proxyMiddleware }
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/hermes/files.ts packages/server/src/routes/hermes/index.ts
git commit -m "feat: 添加文件管理 REST API 路由

- 9 个端点: list/stat/read/write/delete/rename/mkdir/copy/upload
- 敏感文件写入保护 (.env, auth.json)
- 路径遍历防护
- 文件大小限制 (10MB)
- 多文件上传支持

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Frontend API Module

**Files:**
- Create: `packages/client/src/api/hermes/files.ts`

- [ ] **Step 1: Create the files API module**

```typescript
// packages/client/src/api/hermes/files.ts
import { request, getApiKey, getBaseUrlValue } from '../client'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
}

export interface FileStat {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
  permissions?: string
}

export async function listFiles(path: string = ''): Promise<{ entries: FileEntry[]; path: string }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request<{ entries: FileEntry[]; path: string }>(`/api/hermes/files/list${query ? `?${query}` : ''}`)
}

export async function statFile(path: string): Promise<FileStat> {
  return request<FileStat>(`/api/hermes/files/stat?path=${encodeURIComponent(path)}`)
}

export async function readFile(path: string): Promise<{ content: string; path: string; size: number }> {
  return request<{ content: string; path: string; size: number }>(`/api/hermes/files/read?path=${encodeURIComponent(path)}`)
}

export async function writeFile(path: string, content: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

export async function deleteFile(path: string, recursive: boolean = false): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  })
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/rename', {
    method: 'POST',
    body: JSON.stringify({ oldPath, newPath }),
  })
}

export async function mkDir(path: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export async function copyFile(srcPath: string, destPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/copy', {
    method: 'POST',
    body: JSON.stringify({ srcPath, destPath }),
  })
}

export async function uploadFiles(targetDir: string, files: File[]): Promise<{ name: string; path: string }[]> {
  const base = getBaseUrlValue()
  const formData = new FormData()
  for (const file of files) {
    formData.append('file', file)
  }
  const params = new URLSearchParams()
  if (targetDir) params.set('path', targetDir)
  const query = params.toString()
  const url = `${base}/api/hermes/files/upload${query ? `?${query}` : ''}`

  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers['Authorization'] = `Bearer ${token}`
  // Do NOT set Content-Type — browser sets it with boundary for FormData

  const res = await fetch(url, { method: 'POST', headers, body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return data.files
}

/**
 * Get a download URL for a file (reuses existing download endpoint).
 */
export function getFileDownloadUrl(relativePath: string, fileName?: string): string {
  const base = getBaseUrlValue()
  // Convert relative path to absolute path for the download endpoint
  // The download endpoint expects absolute paths, but we'll pass relative
  // and let the server resolve it. Actually, the existing download route uses
  // absolute paths. We need to use the files/read for preview or the existing
  // download endpoint with the full path.
  const params = new URLSearchParams({ path: relativePath })
  if (fileName) params.set('name', fileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/api/hermes/files.ts
git commit -m "feat: 添加文件管理前端 API 模块

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Pinia Store

**Files:**
- Create: `packages/client/src/stores/hermes/files.ts`

- [ ] **Step 1: Create the files store**

```typescript
// packages/client/src/stores/hermes/files.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as filesApi from '@/api/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

// Map file extension to Monaco language ID
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

// Image extensions for preview
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
  // Most files without a binary extension are text
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.zip', '.gz', '.tar', '.7z', '.rar', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp3', '.mp4', '.wav', '.webm', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite'])
  return !binaryExts.has(getFileExt(name))
}

export const useFilesStore = defineStore('files', () => {
  const currentPath = ref('')
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  const sortBy = ref<'name' | 'size' | 'modTime'>('name')
  const sortOrder = ref<'asc' | 'desc'>('asc')

  // Editor state
  const editingFile = ref<{
    path: string
    content: string
    originalContent: string
    language: string
  } | null>(null)

  // Preview state
  const previewFile = ref<{
    path: string
    type: 'image' | 'markdown'
    content?: string
  } | null>(null)

  // Computed: path segments for breadcrumb
  const pathSegments = computed(() => {
    if (!currentPath.value) return []
    return currentPath.value.split('/').filter(Boolean)
  })

  // Computed: sorted entries
  const sortedEntries = computed(() => {
    const copy = [...entries.value]
    copy.sort((a, b) => {
      // Directories always first
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let cmp = 0
      switch (sortBy.value) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'size':
          cmp = a.size - b.size
          break
        case 'modTime':
          cmp = a.modTime.localeCompare(b.modTime)
          break
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

  function navigateTo(path: string) {
    return fetchEntries(path)
  }

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

  function closeEditor() {
    editingFile.value = null
  }

  async function openPreview(entry: FileEntry) {
    if (isImageFile(entry.name)) {
      previewFile.value = { path: entry.path, type: 'image' }
    } else if (isMarkdownFile(entry.name)) {
      const result = await filesApi.readFile(entry.path)
      previewFile.value = { path: entry.path, type: 'markdown', content: result.content }
    }
  }

  function closePreview() {
    previewFile.value = null
  }

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
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/stores/hermes/files.ts
git commit -m "feat: 添加文件管理 Pinia store

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: i18n + Router + Sidebar

**Files:**
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/components/layout/AppSidebar.vue`

- [ ] **Step 1: Add files i18n section to en.ts**

Add before the closing `}` of the default export (before the `download` section or after it):

```typescript
  // Files
  files: {
    title: 'Files',
    tree: 'Directory Tree',
    list: 'File List',
    breadcrumbRoot: 'Home',
    newFile: 'New File',
    newFolder: 'New Folder',
    upload: 'Upload',
    refresh: 'Refresh',
    open: 'Open',
    edit: 'Edit',
    preview: 'Preview',
    download: 'Download',
    copyPath: 'Copy Path',
    rename: 'Rename',
    delete: 'Delete',
    name: 'Name',
    size: 'Size',
    modified: 'Modified',
    actions: 'Actions',
    emptyDir: 'Empty directory',
    loading: 'Loading...',
    confirmDelete: 'Are you sure you want to delete "{name}"?',
    confirmDeleteDir: 'Are you sure you want to delete directory "{name}" and all its contents?',
    deleteFailed: 'Delete failed',
    deleted: 'Deleted',
    renameTo: 'Rename to',
    newFileName: 'File name',
    newFolderName: 'Folder name',
    created: 'Created',
    createFailed: 'Create failed',
    renamed: 'Renamed',
    renameFailed: 'Rename failed',
    uploadSuccess: 'Uploaded {count} file(s)',
    uploadFailed: 'Upload failed',
    saveFailed: 'Save failed',
    saved: 'Saved',
    unsavedChanges: 'You have unsaved changes. Discard?',
    pathCopied: 'Path copied',
    fileTooLarge: 'File too large (max 10MB)',
    permissionDenied: 'Cannot modify protected file',
    notFound: 'File or directory not found',
    backendError: 'File operation failed',
    dragDropHint: 'Drag files here to upload',
    closeEditor: 'Close Editor',
    saveFile: 'Save',
  },
```

- [ ] **Step 2: Add files i18n section to zh.ts**

```typescript
  // 文件管理
  files: {
    title: '文件',
    tree: '目录树',
    list: '文件列表',
    breadcrumbRoot: '根目录',
    newFile: '新建文件',
    newFolder: '新建文件夹',
    upload: '上传',
    refresh: '刷新',
    open: '打开',
    edit: '编辑',
    preview: '预览',
    download: '下载',
    copyPath: '复制路径',
    rename: '重命名',
    delete: '删除',
    name: '名称',
    size: '大小',
    modified: '修改时间',
    actions: '操作',
    emptyDir: '空目录',
    loading: '加载中...',
    confirmDelete: '确定要删除「{name}」吗？',
    confirmDeleteDir: '确定要删除目录「{name}」及其所有内容吗？',
    deleteFailed: '删除失败',
    deleted: '已删除',
    renameTo: '重命名为',
    newFileName: '文件名',
    newFolderName: '文件夹名',
    created: '已创建',
    createFailed: '创建失败',
    renamed: '已重命名',
    renameFailed: '重命名失败',
    uploadSuccess: '已上传 {count} 个文件',
    uploadFailed: '上传失败',
    saveFailed: '保存失败',
    saved: '已保存',
    unsavedChanges: '有未保存的更改，是否丢弃？',
    pathCopied: '路径已复制',
    fileTooLarge: '文件过大（最大 10MB）',
    permissionDenied: '无法修改受保护的文件',
    notFound: '文件或目录不存在',
    backendError: '文件操作失败',
    dragDropHint: '拖拽文件到此处上传',
    closeEditor: '关闭编辑器',
    saveFile: '保存',
  },
```

- [ ] **Step 3: Add route for /hermes/files**

In `packages/client/src/router/index.ts`, add the route after the terminal route:

```typescript
    {
      path: '/hermes/files',
      name: 'hermes.files',
      component: () => import('@/views/hermes/FilesView.vue'),
    },
```

- [ ] **Step 4: Add Files nav item in AppSidebar.vue**

In `packages/client/src/components/layout/AppSidebar.vue`, inside the Tools group's `v-show` div (after the Terminal button), add:

```html
          <button class="nav-item" :class="{ active: selectedKey === 'hermes.files' }" @click="handleNav('hermes.files')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{{ t("sidebar.files") }}</span>
          </button>
```

Also add to the sidebar i18n keys — add `files: 'Files'` in en.ts sidebar section and `files: '文件'` in zh.ts sidebar section.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts packages/client/src/router/index.ts packages/client/src/components/layout/AppSidebar.vue
git commit -m "feat: 添加文件浏览器路由、侧边栏和 i18n 翻译

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: FilesView + FileTree + FileBreadcrumb + FileToolbar

**Files:**
- Create: `packages/client/src/views/hermes/FilesView.vue`
- Create: `packages/client/src/components/hermes/files/FileTree.vue`
- Create: `packages/client/src/components/hermes/files/FileBreadcrumb.vue`
- Create: `packages/client/src/components/hermes/files/FileToolbar.vue`

Note: Create the directory first: `mkdir -p packages/client/src/components/hermes/files`

- [ ] **Step 1: Create FilesView.vue**

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useFilesStore } from '@/stores/hermes/files'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'

const filesStore = useFilesStore()

onMounted(() => {
  filesStore.fetchEntries('')
})
</script>

<template>
  <div class="files-view">
    <div class="files-tree-panel">
      <FileTree />
    </div>
    <div class="files-main-panel">
      <FileToolbar />
      <FileBreadcrumb />
      <div class="files-content">
        <FileEditor v-if="filesStore.editingFile" />
        <FilePreview v-else-if="filesStore.previewFile" />
        <FileList v-else />
      </div>
    </div>
    <FileContextMenu />
    <FileUploadModal />
    <FileRenameModal />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.files-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.files-tree-panel {
  width: 240px;
  min-width: 180px;
  max-width: 400px;
  border-right: 1px solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .files-view {
    flex-direction: column;
  }

  .files-tree-panel {
    width: 100%;
    max-width: none;
    height: 200px;
    border-right: none;
    border-bottom: 1px solid $border-color;
  }
}
</style>
```

- [ ] **Step 2: Create FileTree.vue**

```vue
<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import { NTree, NIcon } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import * as filesApi from '@/api/hermes/files'

const { t } = useI18n()
const filesStore = useFilesStore()

interface TreeOption {
  key: string
  label: string
  isLeaf: boolean
  children?: TreeOption[]
}

const treeData = ref<TreeOption[]>([])
const selectedKeys = ref<string[]>([])

async function loadChildren(path: string): Promise<TreeOption[]> {
  try {
    const result = await filesApi.listFiles(path)
    return result.entries
      .filter(e => e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        key: e.path,
        label: e.name,
        isLeaf: false,
      }))
  } catch {
    return []
  }
}

async function handleLoad(node: TreeOption) {
  node.children = await loadChildren(node.key)
  return
}

function handleSelect(keys: string[]) {
  if (keys.length > 0) {
    selectedKeys.value = keys
    filesStore.navigateTo(keys[0])
  }
}

function handleRootClick() {
  selectedKeys.value = []
  filesStore.navigateTo('')
}

onMounted(async () => {
  treeData.value = await loadChildren('')
})

// Refresh tree when path changes from outside
function refreshTree() {
  loadChildren('').then(data => { treeData.value = data })
}

defineExpose({ refreshTree })
</script>

<template>
  <div class="file-tree">
    <div class="tree-header" @click="handleRootClick">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
      <span>{{ t('files.breadcrumbRoot') }}</span>
    </div>
    <NTree
      :data="treeData"
      :selected-keys="selectedKeys"
      :on-load="handleLoad"
      expand-on-click
      block-line
      :render-switcher-icon="() => null"
      @update:selected-keys="handleSelect"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-tree {
  padding: 8px;
}

.tree-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: $radius-sm;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
  }
}
</style>
```

- [ ] **Step 3: Create FileBreadcrumb.vue**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const filesStore = useFilesStore()

function handleClick(index: number) {
  if (index < 0) {
    filesStore.navigateTo('')
  } else {
    const path = filesStore.pathSegments.slice(0, index + 1).join('/')
    filesStore.navigateTo(path)
  }
}
</script>

<template>
  <div class="file-breadcrumb">
    <NBreadcrumb>
      <NBreadcrumbItem @click="handleClick(-1)">
        {{ t('files.breadcrumbRoot') }}
      </NBreadcrumbItem>
      <NBreadcrumbItem
        v-for="(segment, index) in filesStore.pathSegments"
        :key="index"
        @click="handleClick(index)"
      >
        {{ segment }}
      </NBreadcrumbItem>
    </NBreadcrumb>
  </div>
</template>

<style scoped lang="scss">
.file-breadcrumb {
  padding: 0 16px;
}
</style>
```

- [ ] **Step 4: Create FileToolbar.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NSpace, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const filesStore = useFilesStore()

const showUploadModal = defineModel<boolean>('showUpload', { default: false })
const showNewFileModal = defineModel<boolean>('showNewFile', { default: false })
const showNewFolderModal = defineModel<boolean>('showNewFolder', { default: false })

const emit = defineEmits<{
  (e: 'showUpload'): void
  (e: 'showNewFile'): void
  (e: 'showNewFolder'): void
}>()

async function handleRefresh() {
  try {
    await filesStore.fetchEntries()
    message.success(t('files.refresh'))
  } catch {
    message.error(t('files.backendError'))
  }
}
</script>

<template>
  <div class="file-toolbar">
    <NSpace>
      <NButton size="small" @click="$emit('showNewFile')">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </template>
        {{ t('files.newFile') }}
      </NButton>
      <NButton size="small" @click="$emit('showNewFolder')">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </template>
        {{ t('files.newFolder') }}
      </NButton>
      <NButton size="small" @click="$emit('showUpload')">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 16 12 12 8 16" />
            <line x1="12" y1="12" x2="12" y2="21" />
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
          </svg>
        </template>
        {{ t('files.upload') }}
      </NButton>
      <NButton size="small" @click="handleRefresh">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </template>
        {{ t('files.refresh') }}
      </NButton>
    </NSpace>
  </div>
</template>

<style scoped lang="scss">
.file-toolbar {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
</style>
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/views/hermes/FilesView.vue packages/client/src/components/hermes/files/
git commit -m "feat: 添加文件浏览器页面容器、目录树、面包屑和工具栏组件

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: FileList + FileContextMenu

**Files:**
- Create: `packages/client/src/components/hermes/files/FileList.vue`
- Create: `packages/client/src/components/hermes/files/FileContextMenu.vue`

- [ ] **Step 1: Create FileList.vue**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { NDataTable, NButton, NSpace, NSpin, NEmpty } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useFilesStore, isImageFile, isMarkdownFile, isTextFile } from '@/stores/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const contextMenuRef = ref<{ show: (e: MouseEvent, entry: FileEntry) => void } | null>(null)

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

function getFileIcon(entry: FileEntry): string {
  if (entry.isDir) return '📁'
  const ext = entry.name.split('.').pop()?.toLowerCase() || ''
  const iconMap: Record<string, string> = {
    yaml: '⚙️', yml: '⚙️', json: '📋', toml: '⚙️',
    md: '📝', txt: '📄', log: '📄',
    py: '🐍', js: '📜', ts: '📜', vue: '💚',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    zip: '📦', gz: '📦', tar: '📦',
    sh: '⚡', bash: '⚡',
  }
  return iconMap[ext] || '📄'
}

function handleDoubleClick(entry: FileEntry) {
  if (entry.isDir) {
    filesStore.navigateTo(entry.path)
  } else if (isTextFile(entry.name)) {
    filesStore.openEditor(entry.path)
  } else if (isImageFile(entry.name) || isMarkdownFile(entry.name)) {
    filesStore.openPreview(entry)
  }
}

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  e.preventDefault()
  contextMenuRef.value?.show(e, entry)
}

async function handleDownload(entry: FileEntry) {
  try {
    // Use the resolveHermesPath on the server side — we need absolute path for download
    // Actually the download endpoint uses absolute paths, but we store relative paths.
    // We'll need to pass the relative path to a helper that constructs the right URL.
    // For now, prefix with ~/.hermes/ conceptually — but the download route expects abs path.
    // Solution: use the files/read endpoint for text, or add a download-by-relative-path feature.
    // Simplest: use getFileDownloadUrl with relative path and handle on server.
    await downloadFile(entry.path, entry.name)
  } catch (err: any) {
    message.error(err.message || t('files.backendError'))
  }
}

function handleCopyPath(entry: FileEntry) {
  navigator.clipboard.writeText(entry.path)
  message.success(t('files.pathCopied'))
}

const columns = computed(() => [
  {
    key: 'name',
    title: t('files.name'),
    sorter: true,
    render: (row: FileEntry) => {
      return `${getFileIcon(row)} ${row.name}`
    },
  },
  {
    key: 'size',
    title: t('files.size'),
    width: 100,
    sorter: true,
    render: (row: FileEntry) => row.isDir ? '—' : formatSize(row.size),
  },
  {
    key: 'modTime',
    title: t('files.modified'),
    width: 180,
    sorter: true,
    render: (row: FileEntry) => formatDate(row.modTime),
  },
])

defineExpose({ contextMenuRef })
</script>

<template>
  <div class="file-list">
    <NSpin :show="filesStore.loading">
      <NEmpty v-if="!filesStore.loading && filesStore.sortedEntries.length === 0" :description="t('files.emptyDir')" />
      <div v-else class="file-list-items">
        <div
          v-for="entry in filesStore.sortedEntries"
          :key="entry.path"
          class="file-list-row"
          @dblclick="handleDoubleClick(entry)"
          @contextmenu="handleContextMenu($event, entry)"
        >
          <div class="file-name">
            <span class="file-icon">{{ getFileIcon(entry) }}</span>
            <span>{{ entry.name }}</span>
          </div>
          <div class="file-size">{{ entry.isDir ? '—' : formatSize(entry.size) }}</div>
          <div class="file-date">{{ formatDate(entry.modTime) }}</div>
          <div class="file-actions">
            <NButton v-if="isTextFile(entry.name) && !entry.isDir" size="tiny" quaternary @click.stop="filesStore.openEditor(entry.path)" :title="t('files.edit')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </NButton>
            <NButton v-if="!entry.isDir" size="tiny" quaternary @click.stop="handleDownload(entry)" :title="t('files.download')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </NButton>
          </div>
        </div>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-list {
  padding: 8px 16px;
}

.file-list-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: $radius-sm;
  cursor: pointer;
  gap: 16px;
  font-size: 13px;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);

    .file-actions {
      opacity: 1;
    }
  }
}

.file-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-icon {
  flex-shrink: 0;
}

.file-size {
  width: 80px;
  text-align: right;
  color: $text-secondary;
  flex-shrink: 0;
}

.file-date {
  width: 160px;
  color: $text-secondary;
  flex-shrink: 0;
}

.file-actions {
  opacity: 0;
  transition: opacity $transition-fast;
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .file-size, .file-date {
    display: none;
  }
}
</style>
```

- [ ] **Step 2: Create FileContextMenu.vue**

```vue
<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { NDropdown, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore, isTextFile, isImageFile, isMarkdownFile } from '@/stores/hermes/files'
import { downloadFile } from '@/api/hermes/download'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const filesStore = useFilesStore()

const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const targetEntry = ref<FileEntry | null>(null)

const emit = defineEmits<{
  (e: 'rename', entry: FileEntry): void
}>()

function show(e: MouseEvent, entry: FileEntry) {
  targetEntry.value = entry
  menuX.value = e.clientX
  menuY.value = e.clientY
  showMenu.value = false
  nextTick(() => {
    showMenu.value = true
  })
}

function getOptions() {
  const entry = targetEntry.value
  if (!entry) return []
  const options: any[] = []

  if (entry.isDir) {
    options.push({ label: t('files.open'), key: 'open' })
  } else {
    if (isTextFile(entry.name)) {
      options.push({ label: t('files.edit'), key: 'edit' })
    }
    if (isImageFile(entry.name) || isMarkdownFile(entry.name)) {
      options.push({ label: t('files.preview'), key: 'preview' })
    }
    options.push({ label: t('files.download'), key: 'download' })
  }
  options.push({ type: 'divider', key: 'd1' })
  options.push({ label: t('files.copyPath'), key: 'copyPath' })
  options.push({ label: t('files.rename'), key: 'rename' })
  options.push({ type: 'divider', key: 'd2' })
  options.push({ label: t('files.delete'), key: 'delete', props: { style: { color: 'var(--error)' } } })
  return options
}

async function handleSelect(key: string) {
  showMenu.value = false
  const entry = targetEntry.value
  if (!entry) return

  switch (key) {
    case 'open':
      filesStore.navigateTo(entry.path)
      break
    case 'edit':
      try { await filesStore.openEditor(entry.path) } catch { message.error(t('files.backendError')) }
      break
    case 'preview':
      try { await filesStore.openPreview(entry) } catch { message.error(t('files.backendError')) }
      break
    case 'download':
      try { await downloadFile(entry.path, entry.name) } catch (err: any) { message.error(err.message) }
      break
    case 'copyPath':
      navigator.clipboard.writeText(entry.path)
      message.success(t('files.pathCopied'))
      break
    case 'rename':
      emit('rename', entry)
      break
    case 'delete':
      dialog.warning({
        title: t('files.delete'),
        content: entry.isDir ? t('files.confirmDeleteDir', { name: entry.name }) : t('files.confirmDelete', { name: entry.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await filesStore.deleteEntry(entry)
            message.success(t('files.deleted'))
          } catch {
            message.error(t('files.deleteFailed'))
          }
        },
      })
      break
  }
}

function handleClickOutside() {
  showMenu.value = false
}

defineExpose({ show })
</script>

<template>
  <NDropdown
    :show="showMenu"
    :x="menuX"
    :y="menuY"
    :options="getOptions()"
    placement="bottom-start"
    trigger="manual"
    @select="handleSelect"
    @clickoutside="handleClickOutside"
  />
</template>
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/hermes/files/FileList.vue packages/client/src/components/hermes/files/FileContextMenu.vue
git commit -m "feat: 添加文件列表和右键上下文菜单组件

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: FileEditor (Monaco)

**Files:**
- Create: `packages/client/src/components/hermes/files/FileEditor.vue`

- [ ] **Step 1: Create FileEditor.vue**

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { NButton, NSpace, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import * as monaco from 'monaco-editor'

// Configure Monaco workers
self.MonacoEnvironment = {
  getWorker(_: any, label: string) {
    // Use simple worker for all languages
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    )
  },
}

const { t } = useI18n()
const message = useMessage()
const dialogApi = useDialog()
const filesStore = useFilesStore()

const editorContainer = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const saving = ref(false)

onMounted(() => {
  if (!editorContainer.value || !filesStore.editingFile) return

  editor = monaco.editor.create(editorContainer.value, {
    value: filesStore.editingFile.content,
    language: filesStore.editingFile.language,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
  })

  editor.onDidChangeModelContent(() => {
    if (filesStore.editingFile) {
      filesStore.editingFile.content = editor!.getValue()
    }
  })

  // Ctrl/Cmd + S to save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    handleSave()
  })
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})

async function handleSave() {
  saving.value = true
  try {
    await filesStore.saveEditor()
    message.success(t('files.saved'))
  } catch {
    message.error(t('files.saveFailed'))
  } finally {
    saving.value = false
  }
}

function handleClose() {
  if (filesStore.hasUnsavedChanges) {
    dialogApi.warning({
      title: t('files.unsavedChanges'),
      positiveText: t('common.ok'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        filesStore.closeEditor()
      },
    })
  } else {
    filesStore.closeEditor()
  }
}
</script>

<template>
  <div class="file-editor">
    <div class="editor-header">
      <span class="editor-filename">{{ filesStore.editingFile?.path }}</span>
      <NSpace>
        <NButton size="small" type="primary" :loading="saving" @click="handleSave">
          {{ t('files.saveFile') }}
        </NButton>
        <NButton size="small" @click="handleClose">
          {{ t('files.closeEditor') }}
        </NButton>
      </NSpace>
    </div>
    <div ref="editorContainer" class="editor-container" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background-color: $bg-card;
}

.editor-filename {
  font-size: 13px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-container {
  flex: 1;
  min-height: 0;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/components/hermes/files/FileEditor.vue
git commit -m "feat: 添加 Monaco Editor 文件编辑组件

- 语法高亮、自动语言检测
- Ctrl+S 保存快捷键
- 未保存变更提示

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: FilePreview + FileUploadModal + FileRenameModal

**Files:**
- Create: `packages/client/src/components/hermes/files/FilePreview.vue`
- Create: `packages/client/src/components/hermes/files/FileUploadModal.vue`
- Create: `packages/client/src/components/hermes/files/FileRenameModal.vue`

- [ ] **Step 1: Create FilePreview.vue**

```vue
<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { getFileDownloadUrl } from '@/api/hermes/files'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

const { t } = useI18n()
const filesStore = useFilesStore()

function getImageUrl(): string {
  if (!filesStore.previewFile) return ''
  return getFileDownloadUrl(filesStore.previewFile.path)
}
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
      <NButton size="small" @click="filesStore.closePreview()">
        {{ t('common.cancel') }}
      </NButton>
    </div>
    <div class="preview-content">
      <img
        v-if="filesStore.previewFile.type === 'image'"
        :src="getImageUrl()"
        class="preview-image"
        :alt="filesStore.previewFile.path"
      />
      <div v-else-if="filesStore.previewFile.type === 'markdown'" class="preview-markdown">
        <MarkdownRenderer :content="filesStore.previewFile.content || ''" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.preview-filename {
  font-size: 13px;
  color: $text-secondary;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-markdown {
  max-width: 800px;
  width: 100%;
}
</style>
```

- [ ] **Step 2: Create FileUploadModal.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton, NUpload, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const uploading = ref(false)
const fileList = ref<File[]>([])

function handleFileChange(data: { file: { file: File | null }; fileList: any[] }) {
  if (data.file.file) {
    fileList.value = data.fileList.map((f: any) => f.file).filter(Boolean)
  }
}

async function handleUpload() {
  if (fileList.value.length === 0) return
  uploading.value = true
  try {
    await filesStore.uploadFiles(fileList.value)
    message.success(t('files.uploadSuccess', { count: fileList.value.length }))
    fileList.value = []
    emit('update:show', false)
  } catch (err: any) {
    message.error(err.message || t('files.uploadFailed'))
  } finally {
    uploading.value = false
  }
}

function handleClose() {
  fileList.value = []
  emit('update:show', false)
}
</script>

<template>
  <NModal :show="props.show" preset="dialog" :title="t('files.upload')" @update:show="handleClose" style="width: 500px;">
    <NUpload
      multiple
      directory-dnd
      :default-upload="false"
      @change="handleFileChange"
    >
      <div class="upload-dragger">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.4">
          <polyline points="16 16 12 12 8 16" />
          <line x1="12" y1="12" x2="12" y2="21" />
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
        </svg>
        <p>{{ t('files.dragDropHint') }}</p>
      </div>
    </NUpload>
    <template #action>
      <NSpace>
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="uploading" :disabled="fileList.length === 0" @click="handleUpload">
          {{ t('files.upload') }} ({{ fileList.length }})
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.upload-dragger {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  cursor: pointer;
}

.upload-dragger p {
  margin-top: 12px;
  opacity: 0.6;
  font-size: 14px;
}
</style>
```

- [ ] **Step 3: Create FileRenameModal.vue**

This modal handles three operations: new file, new folder, and rename.

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const props = defineProps<{
  show: boolean
  mode: 'newFile' | 'newFolder' | 'rename'
  entry?: FileEntry | null  // only for rename mode
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const inputValue = ref('')
const submitting = ref(false)

watch(() => props.show, (val) => {
  if (val) {
    if (props.mode === 'rename' && props.entry) {
      inputValue.value = props.entry.name
    } else {
      inputValue.value = ''
    }
  }
})

const title = ref('')
watch(() => props.mode, () => {
  switch (props.mode) {
    case 'newFile': title.value = t('files.newFile'); break
    case 'newFolder': title.value = t('files.newFolder'); break
    case 'rename': title.value = t('files.rename'); break
  }
}, { immediate: true })

const placeholder = ref('')
watch(() => props.mode, () => {
  switch (props.mode) {
    case 'newFile': placeholder.value = t('files.newFileName'); break
    case 'newFolder': placeholder.value = t('files.newFolderName'); break
    case 'rename': placeholder.value = t('files.renameTo'); break
  }
}, { immediate: true })

async function handleSubmit() {
  if (!inputValue.value.trim()) return
  submitting.value = true
  try {
    switch (props.mode) {
      case 'newFile':
        await filesStore.createFile(inputValue.value.trim())
        message.success(t('files.created'))
        break
      case 'newFolder':
        await filesStore.createDir(inputValue.value.trim())
        message.success(t('files.created'))
        break
      case 'rename':
        if (props.entry) {
          await filesStore.renameEntry(props.entry, inputValue.value.trim())
          message.success(t('files.renamed'))
        }
        break
    }
    emit('update:show', false)
  } catch (err: any) {
    const msg = props.mode === 'rename' ? t('files.renameFailed') : t('files.createFailed')
    message.error(err.message || msg)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <NModal :show="props.show" preset="dialog" :title="title" @update:show="emit('update:show', false)" style="width: 400px;">
    <NInput
      v-model:value="inputValue"
      :placeholder="placeholder"
      @keydown.enter="handleSubmit"
      autofocus
    />
    <template #action>
      <NSpace>
        <NButton @click="emit('update:show', false)">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="submitting" :disabled="!inputValue.trim()" @click="handleSubmit">
          {{ t('common.ok') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/hermes/files/FilePreview.vue packages/client/src/components/hermes/files/FileUploadModal.vue packages/client/src/components/hermes/files/FileRenameModal.vue
git commit -m "feat: 添加文件预览、上传和重命名/新建对话框组件

- FilePreview: 图片内联预览 + Markdown 渲染预览
- FileUploadModal: 拖拽上传、多文件支持
- FileRenameModal: 复用于新建文件、新建文件夹、重命名

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 12: Integration — Wire Up FilesView + Build Verification

**Files:**
- Modify: `packages/client/src/views/hermes/FilesView.vue` (update with modal state wiring)

- [ ] **Step 1: Update FilesView.vue to wire all modals and context menu**

The initial FilesView.vue from Task 8 imports all components but doesn't wire up modal show/hide state. Update it:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useFilesStore } from '@/stores/hermes/files'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileEditor from '@/components/hermes/files/FileEditor.vue'
import FilePreview from '@/components/hermes/files/FilePreview.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import type { FileEntry } from '@/api/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
const showUpload = ref(false)
const showRenameModal = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  showRenameModal.value = true
}

onMounted(() => {
  filesStore.fetchEntries('')
})
</script>

<template>
  <div class="files-view">
    <div class="files-tree-panel">
      <FileTree />
    </div>
    <div class="files-main-panel">
      <FileToolbar
        @show-new-file="handleShowNewFile"
        @show-new-folder="handleShowNewFolder"
        @show-upload="showUpload = true"
      />
      <FileBreadcrumb />
      <div class="files-content">
        <FileEditor v-if="filesStore.editingFile" />
        <FilePreview v-else-if="filesStore.previewFile" />
        <FileList v-else @contextmenu-entry="handleContextMenu" />
      </div>
    </div>
    <FileContextMenu ref="contextMenuRef" @rename="handleRename" />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal v-model:show="showRenameModal" :mode="renameMode" :entry="renameEntry" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.files-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.files-tree-panel {
  width: 240px;
  min-width: 180px;
  max-width: 400px;
  border-right: 1px solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .files-view {
    flex-direction: column;
  }

  .files-tree-panel {
    width: 100%;
    max-width: none;
    height: 200px;
    border-right: none;
    border-bottom: 1px solid $border-color;
  }
}
</style>
```

Also update `FileList.vue` to emit the contextmenu event to the parent:

```vue
<!-- In FileList.vue, add emit declaration -->
const emit = defineEmits<{
  (e: 'contextmenu-entry', event: MouseEvent, entry: FileEntry): void
}>()

<!-- Update the contextmenu handler -->
function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  e.preventDefault()
  emit('contextmenu-entry', e, entry)
}
```

- [ ] **Step 2: Fix download route to support relative paths**

The existing download route at `/api/hermes/download` expects absolute paths, but the file browser works with relative paths. Add support for relative paths by resolving them:

In `packages/server/src/routes/hermes/download.ts`, add import:
```typescript
import { resolveHermesPath } from '../../services/hermes/file-provider'
```

Then in the route handler, after getting `filePath`, add relative path resolution:
```typescript
  try {
    // Support both absolute and relative paths
    let validPath: string
    if (filePath.startsWith('/')) {
      validPath = validatePath(filePath)
    } else {
      validPath = resolveHermesPath(filePath)
    }
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
```

Expected: Build succeeds with no errors.

If there are TypeScript errors, fix them. Common issues:
- Import paths
- Missing type annotations
- Monaco worker configuration

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: 完成文件浏览器集成和构建验证

- FilesView 串联所有子组件和模态框
- 下载路由支持相对路径
- 构建验证通过

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Notes

### Download URL Resolution
The existing download endpoint (`/api/hermes/download`) uses absolute paths. The file browser uses relative paths (relative to `~/.hermes/`). Task 12 adds relative path support to the download route so that file browser downloads work correctly.

### Monaco Editor Workers
Monaco Editor requires web workers for syntax highlighting. The simplest approach is using `import.meta.url` to create workers inline. If this doesn't work in the Vite build, an alternative is to use `vite-plugin-monaco-editor`:

```bash
npm install vite-plugin-monaco-editor
```

And in `vite.config.ts`:
```typescript
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

plugins: [vue(), monacoEditorPlugin({})],
```

### Sensitive File Protection
Files named `.env` and `auth.json` at any level under `~/.hermes/` are protected:
- Can be **read** (viewed in editor in read-only mode)
- Cannot be **written**, **deleted**, or **renamed** via the API
- The frontend should show a visual indicator (lock icon) for these files

### Error Handling Pattern
All API errors follow the same pattern:
- Server returns `{ error: string, code: string }` with appropriate HTTP status
- Frontend catches errors and shows toast messages using `useMessage()`
- Error codes map to i18n keys for user-friendly messages

### File Size Limits
- Edit/upload: 10MB max (`MAX_EDIT_SIZE`)
- Download: 100MB max (`MAX_DOWNLOAD_SIZE`, existing)
- These limits apply to the content being transferred, not the file on disk

