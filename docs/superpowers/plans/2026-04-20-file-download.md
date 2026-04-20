# 文件下载功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Hermes Web UI 添加文件下载能力，支持下载用户上传的文件和 Agent 在不同 terminal backend 中生成的文件。

**Architecture:** BFF 层新增 FileProvider 抽象，按 hermes config 中的 terminal.backend 选择对应的文件读取策略（local/docker/ssh/singularity）。前端拦截 markdown 中的文件路径链接并为附件添加下载按钮，通过 BFF 下载路由获取文件。

**Tech Stack:** Koa 2, @koa/router, Node.js child_process, Vue 3 Composition API, Naive UI, vue-i18n, TypeScript

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/server/src/services/hermes/file-provider.ts` | FileProvider 接口 + Local/Docker/SSH/Singularity 实现 + 工厂函数 |
| `packages/server/src/routes/hermes/download.ts` | 下载路由 `GET /api/hermes/download` |
| `packages/client/src/api/hermes/download.ts` | 前端下载 API（构造 URL + 触发下载） |

### Modified Files

| File | Changes |
|------|---------|
| `packages/server/src/routes/hermes/index.ts` | 注册 downloadRoutes（在 proxyRoutes 之前） |
| `packages/client/src/components/hermes/chat/MarkdownRenderer.vue` | 拦截文件路径链接点击事件 |
| `packages/client/src/components/hermes/chat/MessageItem.vue` | 附件添加下载按钮 |
| `packages/client/src/i18n/locales/en.ts` | 新增 download 翻译 |
| `packages/client/src/i18n/locales/zh.ts` | 新增 download 翻译 |

---

### Task 1: FileProvider 抽象与 LocalFileProvider

**Files:**
- Create: `packages/server/src/services/hermes/file-provider.ts`

- [ ] **Step 1: 创建 FileProvider 接口和 LocalFileProvider**

```typescript
// packages/server/src/services/hermes/file-provider.ts
import { readFile, stat } from 'fs/promises'
import { resolve, normalize, isAbsolute } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import YAML from 'js-yaml'
import { config } from '../../config'
import { getActiveProfileDir, getActiveEnvPath } from './hermes-profile'

const execFileAsync = promisify(execFile)

// Max download file size (default 100MB)
const MAX_DOWNLOAD_SIZE = parseInt(process.env.MAX_DOWNLOAD_SIZE || '', 10) || 100 * 1024 * 1024
// Backend command timeout (default 30s)
const BACKEND_TIMEOUT = 30_000

export type BackendType = 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona'

export interface FileProvider {
  type: BackendType
  readFile(filePath: string): Promise<Buffer>
  exists(filePath: string): Promise<boolean>
}

export interface TerminalConfig {
  backend: BackendType
  docker_image?: string
  docker_container_name?: string
  cwd?: string
  singularity_image?: string
  // SSH params come from .env
}

/**
 * Validate a file path: must be absolute and not contain '..' traversal.
 */
export function validatePath(filePath: string): string {
  if (!filePath) throw Object.assign(new Error('Missing file path'), { code: 'missing_path' })
  const resolved = resolve(filePath)
  const normalized = normalize(resolved)
  // After resolve+normalize, check the resolved path doesn't escape via symlinks
  // The simplest safe check: the normalized path must not contain '..' segments
  if (normalized.includes('..')) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  if (!isAbsolute(normalized)) {
    throw Object.assign(new Error('Path must be absolute'), { code: 'invalid_path' })
  }
  return normalized
}

/**
 * Check if a path is inside the upload directory.
 */
export function isInUploadDir(filePath: string): boolean {
  const normalized = normalize(resolve(filePath))
  const uploadNormalized = normalize(resolve(config.uploadDir))
  return normalized.startsWith(uploadNormalized + '/')
    || normalized.startsWith(uploadNormalized + '\\')
    || normalized === uploadNormalized
}

// --- Local ---

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
}

// --- Docker ---

export class DockerFileProvider implements FileProvider {
  type: BackendType = 'docker'
  private containerName: string

  constructor(containerName: string) {
    this.containerName = containerName
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      // docker cp outputs tar to stdout when target is '-'
      // Use docker exec cat instead for simpler binary output
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'cat', p,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found in container'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'test', '-f', p,
      ], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
}

// --- SSH ---

export class SSHFileProvider implements FileProvider {
  type: BackendType = 'ssh'
  private host: string
  private user: string
  private keyPath?: string

  constructor(host: string, user: string, keyPath?: string) {
    this.host = host
    this.user = user
    this.keyPath = keyPath
  }

  private sshArgs(): string[] {
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes']
    if (this.keyPath) args.push('-i', this.keyPath)
    args.push(`${this.user}@${this.host}`)
    return args
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), 'cat', p,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found on remote'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), 'test', '-f', p,
      ], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
}

// --- Singularity ---

export class SingularityFileProvider implements FileProvider {
  type: BackendType = 'singularity'
  private imagePath: string

  constructor(imagePath: string) {
    this.imagePath = imagePath
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'cat', p,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found in container'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', [
        'exec', this.imagePath, 'test', '-f', p,
      ], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  }
}

// --- Config helpers ---

/**
 * Read terminal config from hermes config.yaml.
 */
export function getTerminalConfig(): TerminalConfig {
  try {
    const configPath = `${getActiveProfileDir()}/config.yaml`
    if (!existsSync(configPath)) return { backend: 'local' }
    const raw = readFileSync(configPath, 'utf-8')
    const doc = YAML.load(raw) as any
    const t = doc?.terminal || {}
    return {
      backend: (t.backend as BackendType) || 'local',
      docker_image: t.docker_image,
      docker_container_name: t.docker_container_name,
      cwd: t.cwd,
      singularity_image: t.singularity_image,
    }
  } catch {
    return { backend: 'local' }
  }
}

/**
 * Read SSH env vars from hermes .env file.
 */
function getSSHEnvVars(): { host?: string; user?: string; key?: string } {
  try {
    const envPath = getActiveEnvPath()
    if (!existsSync(envPath)) return {}
    const raw = readFileSync(envPath, 'utf-8')
    const vars: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }
    return {
      host: vars.TERMINAL_SSH_HOST,
      user: vars.TERMINAL_SSH_USER,
      key: vars.TERMINAL_SSH_KEY,
    }
  } catch {
    return {}
  }
}

/**
 * Resolve Docker container name. If not configured, try to find a running
 * container based on the configured image.
 */
async function resolveDockerContainer(cfg: TerminalConfig): Promise<string> {
  if (cfg.docker_container_name) return cfg.docker_container_name
  if (cfg.docker_image) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'ps', '-q', '--filter', `ancestor=${cfg.docker_image}`, '--latest',
      ], { timeout: 5000 })
      const id = stdout.trim()
      if (id) return id
    } catch { }
  }
  throw Object.assign(
    new Error('Cannot determine Docker container. Set terminal.docker_container_name in hermes config.'),
    { code: 'backend_error' },
  )
}

// --- Factory ---

// Cache the provider for a short time to avoid re-reading config on every request
let cachedProvider: FileProvider | null = null
let cachedAt = 0
const CACHE_TTL = 10_000

/**
 * Create a FileProvider based on the active hermes terminal config.
 * Defaults to LocalFileProvider if config cannot be read or backend is unknown.
 */
export async function createFileProvider(): Promise<FileProvider> {
  const now = Date.now()
  if (cachedProvider && now - cachedAt < CACHE_TTL) return cachedProvider

  const cfg = getTerminalConfig()
  let provider: FileProvider

  switch (cfg.backend) {
    case 'docker': {
      const container = await resolveDockerContainer(cfg)
      provider = new DockerFileProvider(container)
      break
    }
    case 'ssh': {
      const ssh = getSSHEnvVars()
      if (!ssh.host || !ssh.user) {
        throw Object.assign(
          new Error('SSH backend requires TERMINAL_SSH_HOST and TERMINAL_SSH_USER in .env'),
          { code: 'backend_error' },
        )
      }
      provider = new SSHFileProvider(ssh.host, ssh.user, ssh.key)
      break
    }
    case 'singularity': {
      if (!cfg.singularity_image) {
        throw Object.assign(
          new Error('Singularity backend requires terminal.singularity_image in config'),
          { code: 'backend_error' },
        )
      }
      provider = new SingularityFileProvider(cfg.singularity_image)
      break
    }
    case 'modal':
    case 'daytona':
      throw Object.assign(
        new Error(`File download not yet supported for '${cfg.backend}' backend`),
        { code: 'unsupported_backend' },
      )
    default:
      provider = new LocalFileProvider()
  }

  cachedProvider = provider
  cachedAt = now
  return provider
}

// Always-available local provider for upload directory files
const localProvider = new LocalFileProvider()
export { localProvider, MAX_DOWNLOAD_SIZE }
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx tsc -p packages/server/tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors related to `file-provider.ts`

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/services/hermes/file-provider.ts
git commit -m "feat: 添加 FileProvider 抽象层，支持 local/docker/ssh/singularity backend 文件读取

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 下载路由

**Files:**
- Create: `packages/server/src/routes/hermes/download.ts`
- Modify: `packages/server/src/routes/hermes/index.ts`

- [ ] **Step 1: 创建下载路由**

```typescript
// packages/server/src/routes/hermes/download.ts
import Router from '@koa/router'
import { basename, extname } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  validatePath,
  MAX_DOWNLOAD_SIZE,
} from '../../services/hermes/file-provider'

export const downloadRoutes = new Router()

// MIME type mapping for common extensions
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.log': 'text/plain',
}

function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

downloadRoutes.get('/api/hermes/download', async (ctx) => {
  const filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    // Validate the path first
    const validPath = validatePath(filePath)

    // Choose provider: always use local for upload directory files
    let data: Buffer
    if (isInUploadDir(validPath)) {
      data = await localProvider.readFile(validPath)
    } else {
      const provider = await createFileProvider()
      data = await provider.readFile(validPath)
    }

    // Determine filename and MIME type
    const name = fileName || basename(validPath)
    const mime = getMimeType(name)

    // Set response headers
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(data.length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.body = data
  } catch (err: any) {
    const code = err.code || 'unknown'
    const statusMap: Record<string, number> = {
      missing_path: 400,
      invalid_path: 400,
      not_found: 404,
      file_too_large: 413,
      unsupported_backend: 501,
      backend_error: 502,
      backend_timeout: 504,
    }
    ctx.status = statusMap[code] || 500
    ctx.body = { error: err.message, code }
  }
})
```

- [ ] **Step 2: 注册下载路由到 hermesRoutes（在 proxyRoutes 之前）**

修改 `packages/server/src/routes/hermes/index.ts`：

```typescript
// packages/server/src/routes/hermes/index.ts
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
hermesRoutes.use(proxyRoutes.routes())

export { setupTerminalWebSocket, proxyMiddleware }
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx tsc -p packages/server/tsconfig.json --noEmit 2>&1 | head -30`
Expected: No errors

- [ ] **Step 4: 提交**

```bash
git add packages/server/src/routes/hermes/download.ts packages/server/src/routes/hermes/index.ts
git commit -m "feat: 添加文件下载路由 GET /api/hermes/download

- MIME 类型自动推断
- 上传目录文件始终使用 LocalFileProvider
- 其他文件根据 terminal backend 配置选择 provider
- 完整错误处理和状态码映射

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: 前端下载 API 模块

**Files:**
- Create: `packages/client/src/api/hermes/download.ts`

- [ ] **Step 1: 创建前端下载 API**

```typescript
// packages/client/src/api/hermes/download.ts
import { getApiKey, getBaseUrlValue } from '../client'

/**
 * Construct a download URL with auth token as query parameter.
 * Token is passed via query param because <a> tags cannot set headers.
 */
export function getDownloadUrl(filePath: string, fileName?: string): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: filePath })
  if (fileName) params.set('name', fileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}

/**
 * Download a file. Uses fetch to detect errors, then creates a blob URL
 * for the browser download. Throws with error message on failure.
 */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const url = getDownloadUrl(filePath, fileName)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Download failed: ${res.status}`)
  }
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = fileName || filePath.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(blobUrl)
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors related to download.ts

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/api/hermes/download.ts
git commit -m "feat: 添加前端文件下载 API 模块

- getDownloadUrl() 构造带 auth token 的下载 URL
- downloadFile() fetch 检测错误后用 blob URL 触发浏览器下载

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: i18n 翻译

**Files:**
- Modify: `packages/client/src/i18n/locales/en.ts`
- Modify: `packages/client/src/i18n/locales/zh.ts`

- [ ] **Step 1: 添加英文翻译**

在 `packages/client/src/i18n/locales/en.ts` 的末尾 `}` 之前（`usage` section 之后）添加：

```typescript
  // Download
  download: {
    downloading: 'Downloading...',
    downloadFailed: 'Download failed',
    fileNotFound: 'File not found or deleted',
    fileTooLarge: 'File too large (exceeds limit)',
    backendError: 'File read failed, remote environment may be unavailable',
    backendTimeout: 'File read timed out',
    unsupportedBackend: 'Current terminal backend does not support file download',
    invalidPath: 'Invalid file path',
    download: 'Download',
  },
```

- [ ] **Step 2: 添加中文翻译**

在 `packages/client/src/i18n/locales/zh.ts` 的末尾 `}` 之前（`usage` section 之后）添加：

```typescript
  // 下载
  download: {
    downloading: '正在下载...',
    downloadFailed: '下载失败',
    fileNotFound: '文件不存在或已被删除',
    fileTooLarge: '文件过大（超过限制）',
    backendError: '文件读取失败，远程环境可能不可用',
    backendTimeout: '文件读取超时',
    unsupportedBackend: '当前 terminal backend 暂不支持文件下载',
    invalidPath: '无效的文件路径',
    download: '下载',
  },
```

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/i18n/locales/en.ts packages/client/src/i18n/locales/zh.ts
git commit -m "feat: 添加文件下载相关 i18n 翻译（中/英）

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: MarkdownRenderer 拦截文件链接

**Files:**
- Modify: `packages/client/src/components/hermes/chat/MarkdownRenderer.vue`

- [ ] **Step 1: 添加链接点击拦截逻辑**

修改 `packages/client/src/components/hermes/chat/MarkdownRenderer.vue`，在 `<script setup>` 中添加点击处理函数，在模板中绑定事件：

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { downloadFile } from '@/api/hermes/download'

const props = defineProps<{ content: string }>()
const { t } = useI18n()
const message = useMessage()

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs-code-block"><div class="code-header"><span class="code-lang">${lang}</span><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.hljs-code-block').querySelector('code').textContent)">${t('common.copy')}</button></div><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // fall through
      }
    }
    return `<pre class="hljs-code-block"><div class="code-header"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.hljs-code-block').querySelector('code').textContent)">${t('common.copy')}</button></div><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`
  },
})

const renderedHtml = computed(() => md.render(props.content))

/**
 * Intercept clicks on file path links inside rendered markdown.
 * - http(s) links: open in new tab (default browser behavior)
 * - File path links (starting with /): trigger download via API
 */
function handleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('a') as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // Let http(s) links behave normally
  if (href.startsWith('http://') || href.startsWith('https://')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return
  }

  // File path links: intercept and download
  if (href.startsWith('/')) {
    e.preventDefault()
    e.stopPropagation()
    const linkText = link.textContent || ''
    // Parse filename from "File: xxx" pattern or use link text
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    downloadFile(href, fileName || undefined).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}
</script>

<template>
  <div class="markdown-body" v-html="renderedHtml" @click="handleClick"></div>
</template>
```

注意：`<style>` 部分保持不变，不需要修改。

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/components/hermes/chat/MarkdownRenderer.vue
git commit -m "feat: MarkdownRenderer 拦截文件路径链接，点击触发下载

- http(s) 链接在新标签页打开
- 以 / 开头的路径链接拦截为文件下载
- 从 'File: xxx' 格式的链接文本中提取文件名
- 下载失败显示错误 toast

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: MessageItem 附件下载按钮

**Files:**
- Modify: `packages/client/src/components/hermes/chat/MessageItem.vue`

- [ ] **Step 1: 添加附件下载功能**

修改 `packages/client/src/components/hermes/chat/MessageItem.vue`，在 `<script setup>` 中添加下载逻辑，在模板中为附件添加下载交互：

在 `<script setup>` 顶部的 import 中添加：

```typescript
import { useMessage } from 'naive-ui'
import { downloadFile } from '@/api/hermes/download'
```

在 `const { t } = useI18n()` 后添加：

```typescript
const toast = useMessage()
```

在 `formatSize` 函数后添加：

```typescript
/**
 * Extract the upload file path from message content for a given attachment.
 * Upload format in content: [File: name.txt](/tmp/hermes-uploads/abc123.txt)
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || ''
  // Match [File: <name>](<path>) pattern
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    if (match[1].trim() === attName.trim()) return match[2]
  }
  return null
}

function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  // If blob URL is still valid (current session upload), use it directly
  if (att.url && att.url.startsWith('blob:')) {
    const a = document.createElement('a')
    a.href = att.url
    a.download = att.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return
  }
  // Fallback: extract path from message content and use download API
  const filePath = getFilePathFromContent(att.name)
  if (filePath) {
    toast.info(t('download.downloading'))
    downloadFile(filePath, att.name).catch((err: Error) => {
      toast.error(err.message || t('download.downloadFailed'))
    })
  } else {
    toast.warning(t('download.fileNotFound'))
  }
}
```

- [ ] **Step 2: 修改附件模板，添加下载交互**

修改模板中的附件区域。将 `<div v-if="hasAttachments" class="msg-attachments">` 内的内容替换为：

```html
<div v-if="hasAttachments" class="msg-attachments">
  <div
    v-for="att in message.attachments"
    :key="att.id"
    class="msg-attachment"
    :class="{ image: isImage(att.type), clickable: true }"
    @click="handleAttachmentDownload(att)"
  >
    <template v-if="isImage(att.type) && att.url">
      <img
        :src="att.url"
        :alt="att.name"
        class="msg-attachment-thumb"
      />
      <div class="msg-attachment-download-overlay">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
    </template>
    <template v-else>
      <div class="msg-attachment-file">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
          />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span class="att-name">{{ att.name }}</span>
        <span class="att-size">{{ formatSize(att.size) }}</span>
        <svg class="att-download-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
    </template>
  </div>
</div>
```

- [ ] **Step 3: 添加下载相关样式**

在 `<style scoped lang="scss">` 中，在 `.msg-attachment-file` 规则后添加：

```scss
.msg-attachment.clickable {
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.8;
  }
}

.msg-attachment-download-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  opacity: 0;
  transition: opacity $transition-fast;

  .msg-attachment.image:hover & {
    opacity: 1;
  }
}

.msg-attachment.image {
  position: relative;
}

.att-download-icon {
  flex-shrink: 0;
  color: $text-muted;
  opacity: 0;
  transition: opacity $transition-fast;

  .msg-attachment:hover & {
    opacity: 1;
  }
}
```

- [ ] **Step 4: 验证编译通过**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/components/hermes/chat/MessageItem.vue
git commit -m "feat: MessageItem 附件添加下载能力

- 点击附件触发下载
- 图片附件 hover 显示下载叠加层
- 其他文件附件 hover 显示下载图标
- blob URL 有效时直接下载，失效时从消息内容解析路径走 API 下载
- 下载状态 toast 反馈

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: 构建验证

**Files:** 无新增

- [ ] **Step 1: 服务端编译验证**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: 0 errors

- [ ] **Step 2: 客户端类型检查验证**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx vue-tsc --noEmit`
Expected: 0 errors（或仅有已知的预存问题）

- [ ] **Step 3: Vite 构建验证**

Run: `cd /Users/wuchunxu/kika/hermes-web-ui && npx vite build`
Expected: Build succeeds, outputs to `dist/client`

- [ ] **Step 4: 提交构建验证通过标记（如果前面有任何修复）**

如果构建中发现问题并修复，提交修复：
```bash
git add -A
git commit -m "fix: 修复文件下载功能构建问题

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
