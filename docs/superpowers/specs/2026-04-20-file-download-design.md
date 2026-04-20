# 文件下载功能设计文档

## 问题陈述

Hermes Web UI 当前支持文件上传（用户可在聊天中发送文件给 Agent），但无法下载文件。存在两类下载需求：

1. **用户上传的文件**：上传后存储在服务器 `uploadDir`（默认 `/tmp/hermes-uploads/`），但未通过 HTTP 提供服务，刷新页面后 blob URL 失效
2. **Agent 生成的文件**：Agent 通过 `write_file`、`terminal` 等工具在工作目录/沙盒中创建的文件，用户无法获取

## 方案概述

采用 **BFF 文件下载代理 + 多 Backend 支持** 方案：

- BFF 层新增文件下载路由，根据 Hermes 的 terminal backend 配置选择对应的文件读取策略
- 前端拦截 markdown 链接中的文件路径、为附件添加下载按钮
- 支持 local、Docker、SSH 等多种 terminal backend 的文件访问

---

## 后端设计

### 1. FileProvider 抽象 (`packages/server/src/services/hermes/file-provider.ts`)

定义统一的文件读取接口，各 backend 实现各自的读取逻辑：

```typescript
export interface FileProvider {
  type: 'local' | 'docker' | 'ssh' | 'modal' | 'daytona' | 'singularity'
  readFile(filePath: string): Promise<Buffer>
  exists(filePath: string): Promise<boolean>
}
```

#### LocalFileProvider

- 直接使用 `fs.readFile()` 和 `fs.stat()` 读取本地文件
- 适用于 `terminal.backend: local` 或未配置 backend 的场景
- 同时覆盖 `uploadDir` 中用户上传的文件

#### DockerFileProvider

- 通过 `docker exec <container> cat <path>` 读取文件内容（docker exec 直接传参，无 shell 注入风险）
- 通过 `docker exec <container> test -f <path>` 检查文件是否存在
- 需要从 hermes config 读取容器名或镜像名
- 容器名解析策略：优先使用配置的 `terminal.docker_container_name`，fallback 到 `docker ps --filter ancestor=<image> -q` 查找运行中的容器，取最新创建的

#### SSHFileProvider

- 通过 `ssh <user>@<host> 'cat <escaped_path>'` 读取文件内容（路径使用 shell 单引号转义防止注入）
- 通过 `ssh <user>@<host> 'test -f <escaped_path>'` 检查文件是否存在
- SSH 连接参数从 hermes `.env` 读取：`TERMINAL_SSH_HOST`、`TERMINAL_SSH_USER`、`TERMINAL_SSH_KEY`

#### ModalFileProvider / DaytonaFileProvider / SingularityFileProvider

- 通过各自的 CLI 工具读取文件
- Modal: `modal volume get` 或类似命令
- Daytona: `daytona` CLI 的文件访问命令
- Singularity: `singularity exec <sif> cat <path>`

#### 工厂函数

```typescript
export function createFileProvider(): FileProvider
```

- 读取活跃 profile 的 `config.yaml` 中 `terminal.backend` 字段
- 根据 backend 类型创建对应的 provider
- 如果读取配置失败，默认使用 `LocalFileProvider`

### 2. 下载路由 (`packages/server/src/routes/hermes/download.ts`)

```
GET /api/hermes/download?path=<url-encoded-path>&name=<optional-filename>
```

**处理流程：**

1. Auth 鉴权（与现有 API 一致）
2. 解析 `path` 参数，进行安全校验
3. 获取 FileProvider 实例
4. 先检查是否为 uploadDir 内的文件（是则使用 LocalFileProvider，不受 backend 类型限制）
5. 否则使用当前 backend 对应的 FileProvider 读取
6. 推断 MIME 类型（基于文件扩展名），默认 `application/octet-stream`
7. 设置 `Content-Disposition: attachment; filename="<name>"` 响应头
8. 返回文件内容

**安全校验规则：**

- 路径必须为绝对路径
- 路径规范化后不得包含 `..` 组件
- 文件大小限制：默认 100MB
- Auth token 必须有效

### 3. 路由注册

在 `packages/server/src/routes/hermes/index.ts` 中注册下载路由。

**注意**：下载路由必须在 proxy 路由之前注册，否则会被 proxy 的 `/api/hermes/{*any}` catch-all 匹配拦截。

### 4. Hermes 配置读取

利用现有的 `hermes-profile.ts` 服务获取活跃 profile 目录，读取 `config.yaml`：

```typescript
// 已有
import { getActiveProfileDir } from '../../services/hermes/hermes-profile'

// 新增：读取 terminal backend 配置
function getTerminalConfig(): { backend: string; [key: string]: any }
```

---

## 前端设计

### 1. 下载 API 模块 (`packages/client/src/api/hermes/download.ts`)

```typescript
import { getApiKey, getBaseUrlValue } from '../client'

/**
 * 构造文件下载 URL（带 auth token 作为 query 参数）
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
 * 触发浏览器下载（先 fetch 检测错误，成功后用 blob URL 下载）
 */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const url = getDownloadUrl(filePath, fileName)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
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

### 2. MarkdownRenderer 增强 (`packages/client/src/components/hermes/chat/MarkdownRenderer.vue`)

增加全局点击事件委托，拦截文件路径链接：

```typescript
function handleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('a')
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // HTTP(S) 链接：正常跳转
  if (href.startsWith('http://') || href.startsWith('https://')) return

  // 文件路径链接：拦截并触发下载
  if (href.startsWith('/') && !href.startsWith('/api/') && !href.startsWith('/#/')) {
    e.preventDefault()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6) : linkText
    downloadFile(href, fileName)
  }
}
```

使用 `@click` 事件委托绑定在 `.markdown-body` 容器上。

### 3. MessageItem 附件下载 (`packages/client/src/components/hermes/chat/MessageItem.vue`)

为文件附件添加点击下载能力：

**图片附件：**
- 保持现有缩略图展示
- 添加点击放大预览（可选）
- 增加下载按钮图标

**其他文件附件：**
- 整个附件区域可点击
- 点击触发下载
- 添加下载箭头图标
- 如果有有效的 blob URL（当前会话刚上传的文件），用 blob URL 下载
- 如果 blob URL 无效（历史消息），解析消息 content 中的文件路径，通过 download API 下载

**附件路径回退策略：**

用户上传的附件在消息 content 中的格式为 `[File: name.txt](/tmp/hermes-uploads/abc123.txt)`。当 blob URL 失效时，从消息 content 中解析出文件路径用于下载。

### 4. 下载状态反馈

- 使用 Naive UI `useMessage()` 显示下载状态 toast
- 下载失败时根据 HTTP 状态码显示中英文错误信息
- i18n 新增相关翻译 key

---

## 安全设计

### 路径安全

1. 所有传入路径先 `path.resolve()` 规范化为绝对路径
2. 检查规范化后的路径不包含 `..` 组件
3. uploadDir 内的文件始终允许访问（不受 backend 类型限制）
4. 非 uploadDir 文件通过 FileProvider 访问，Provider 自身的安全边界（容器隔离、SSH 权限等）提供额外保护

### 认证

- 下载端点需要有效的 auth token
- 支持 `Authorization: Bearer <token>` 和 `?token=<token>` 两种方式（与 SSE 事件源一致）

### 大小限制

- 默认最大下载文件大小：100MB
- 可通过环境变量 `MAX_DOWNLOAD_SIZE` 配置
- 超过限制返回 413 状态码

---

## 错误处理

| 场景 | HTTP 状态码 | 错误代码 | 前端展示 |
|------|-------------|----------|----------|
| 缺少 path 参数 | 400 | `missing_path` | "请提供文件路径" |
| 路径非法（含 `..`） | 400 | `invalid_path` | "无效的文件路径" |
| 文件不存在 | 404 | `not_found` | "文件不存在或已被删除" |
| Backend 执行失败 | 502 | `backend_error` | "文件读取失败，远程环境可能不可用" |
| Backend 执行超时 | 504 | `backend_timeout` | "文件读取超时" |
| Backend 不支持 | 501 | `unsupported_backend` | "当前 terminal backend 暂不支持文件下载" |
| 文件过大 | 413 | `file_too_large` | "文件过大（超过 100MB 限制）" |
| 认证失败 | 401 | — | 跳转到登录页 |

---

## i18n 翻译新增

### en.ts
```typescript
download: {
  downloading: 'Downloading...',
  downloadFailed: 'Download failed',
  fileNotFound: 'File not found or deleted',
  fileTooLarge: 'File too large (exceeds limit)',
  backendError: 'File read failed, remote environment may be unavailable',
  backendTimeout: 'File read timed out',
  unsupportedBackend: 'Current terminal backend does not support file download',
  invalidPath: 'Invalid file path',
}
```

### zh.ts
```typescript
download: {
  downloading: '正在下载...',
  downloadFailed: '下载失败',
  fileNotFound: '文件不存在或已被删除',
  fileTooLarge: '文件过大（超过限制）',
  backendError: '文件读取失败，远程环境可能不可用',
  backendTimeout: '文件读取超时',
  unsupportedBackend: '当前 terminal backend 暂不支持文件下载',
  invalidPath: '无效的文件路径',
}
```

---

## 文件变更清单

### 新建文件
- `packages/server/src/services/hermes/file-provider.ts` — FileProvider 接口 + 各 backend 实现
- `packages/server/src/routes/hermes/download.ts` — 下载路由
- `packages/client/src/api/hermes/download.ts` — 前端下载 API

### 修改文件
- `packages/server/src/routes/hermes/index.ts` — 注册下载路由
- `packages/client/src/components/hermes/chat/MarkdownRenderer.vue` — 拦截文件链接点击
- `packages/client/src/components/hermes/chat/MessageItem.vue` — 附件下载功能
- `packages/client/src/i18n/locales/en.ts` — 英文翻译
- `packages/client/src/i18n/locales/zh.ts` — 中文翻译

---

## 数据流图

```
用户点击文件链接/附件下载
  ↓
前端 downloadFile(path, name)
  ↓
GET /api/hermes/download?path=<path>&name=<name>&token=<token>
  ↓
BFF 下载路由
  ├─ 路径在 uploadDir 内？ → LocalFileProvider.readFile()
  └─ 否 → 读取 hermes config → createFileProvider()
       ├─ local  → LocalFileProvider.readFile()
       ├─ docker → DockerFileProvider.readFile() → docker cp
       ├─ ssh    → SSHFileProvider.readFile() → ssh cat
       └─ ...    → 对应 Provider
  ↓
返回文件流 (Content-Disposition: attachment)
  ↓
浏览器触发文件下载
```
