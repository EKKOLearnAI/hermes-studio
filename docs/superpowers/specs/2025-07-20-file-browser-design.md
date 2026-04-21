# 文件浏览器功能设计

> 日期：2025-07-20
> 状态：设计完成，待实现

---

## 1. 概述

在 Hermes Web UI 中新增一个独立的「文件浏览器」页面（`/hermes/files`），放在侧边栏「工具」分组中（与终端同级）。提供双面板布局（左目录树 + 右文件列表），支持完整的文件 CRUD 操作，兼容 local/Docker/SSH/Singularity 四种 terminal backend。

**参考项目：** [openclaw_upload](https://github.com/wufloor/openclaw_upload) — Go+Vue3+Element Plus 的文件管理器

## 2. 需求

### 2.1 浏览范围

- 浏览整个 `~/.hermes/`（或当前 profile 目录）
- 敏感文件（`.env`、`auth.json`）标记为只读，禁止通过 API 写入或删除
- 无目录白名单限制

### 2.2 支持操作

| 操作 | 说明 |
|------|------|
| 浏览 | 目录树 + 文件列表，支持排序 |
| 在线编辑 | Monaco Editor，支持语法高亮 |
| 上传 | 拖拽上传、支持多文件 |
| 下载 | 复用已有的 `/api/hermes/download` 端点 |
| 删除 | 文件和目录（递归删除需确认） |
| 重命名 | 重命名文件或目录 |
| 新建文件夹 | 创建空目录 |
| 新建文件 | 创建空文件 |
| 预览 | 图片内联预览、Markdown 渲染预览 |
| 复制路径 | 复制文件绝对路径到剪贴板 |

### 2.3 多 Backend 支持

与文件下载功能一致，通过 FileProvider 抽象层实现：
- **Local**: 直接使用 Node.js `fs` 模块
- **Docker**: `docker exec <container>` 执行文件命令
- **SSH**: `ssh <user>@<host>` 执行文件命令（路径使用 shell 单引号转义防注入）
- **Singularity**: `singularity exec <image>` 执行文件命令

### 2.4 交互方式

- 工具栏按钮：新建文件、新建文件夹、上传、刷新
- 行内操作图标：悬停文件行时显示编辑、下载、更多操作
- 右键上下文菜单：打开、编辑、预览、下载、复制路径、重命名、删除

## 3. 架构

### 3.1 后端 — 扩展 FileProvider 接口

在已有的 `FileProvider` 接口（`packages/server/src/services/hermes/file-provider.ts`）上扩展：

```typescript
interface FileProvider {
  // 已有方法
  readFile(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>

  // 新增方法
  listDir(path: string): Promise<FileEntry[]>
  stat(path: string): Promise<FileStat>
  writeFile(path: string, content: Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  deleteDir(path: string): Promise<void>  // 递归删除
  renameFile(oldPath: string, newPath: string): Promise<void>
  mkDir(path: string): Promise<void>
  copyFile(srcPath: string, destPath: string): Promise<void>
}

interface FileEntry {
  name: string
  path: string       // 相对于 hermes home 的路径
  isDir: boolean
  size: number
  modTime: string    // ISO 8601
}

interface FileStat {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
  permissions?: string
}
```

**每个 Backend 的实现方式：**

| 操作 | Local | Docker | SSH | Singularity |
|------|-------|--------|-----|-------------|
| listDir | `fs.readdir` + `fs.stat` | `docker exec ls -la` | `ssh ls -la` | `singularity exec ls -la` |
| stat | `fs.stat` | `docker exec stat` | `ssh stat` | `singularity exec stat` |
| writeFile | `fs.writeFile` | `docker exec sh -c 'cat > file'` | `ssh 'cat > file'` | `singularity exec sh -c 'cat > file'` |
| deleteFile | `fs.unlink` | `docker exec rm` | `ssh rm` | `singularity exec rm` |
| deleteDir | `fs.rm recursive` | `docker exec rm -rf` | `ssh rm -rf` | `singularity exec rm -rf` |
| renameFile | `fs.rename` | `docker exec mv` | `ssh mv` | `singularity exec mv` |
| mkDir | `fs.mkdir recursive` | `docker exec mkdir -p` | `ssh mkdir -p` | `singularity exec mkdir -p` |
| copyFile | `fs.copyFile` | `docker exec cp` | `ssh cp` | `singularity exec cp` |

**安全措施：**
- 路径遍历防护：复用 `validatePath()`，确保路径不超出 hermes home 目录
- 敏感文件保护：`.env`、`auth.json` 只允许读取，禁止写入/删除/重命名
- SSH 命令注入防护：复用 `shellEscape()` 方法
- 文件大小限制：编辑/上传最大 10MB（`MAX_EDIT_SIZE`）
- 递归删除需前端二次确认

### 3.2 REST API 端点

所有端点前缀：`/api/hermes/files`

| 方法 | 路径 | 功能 | 参数 |
|------|------|------|------|
| `GET` | `/api/hermes/files/list` | 列出目录内容 | `?path=` 相对路径 |
| `GET` | `/api/hermes/files/stat` | 获取文件信息 | `?path=` |
| `GET` | `/api/hermes/files/read` | 读取文件内容 | `?path=` |
| `PUT` | `/api/hermes/files/write` | 写入文件 | body: `{ path, content }` |
| `DELETE` | `/api/hermes/files/delete` | 删除文件/目录 | body: `{ path, recursive? }` |
| `POST` | `/api/hermes/files/rename` | 重命名/移动 | body: `{ oldPath, newPath }` |
| `POST` | `/api/hermes/files/mkdir` | 创建目录 | body: `{ path }` |
| `POST` | `/api/hermes/files/copy` | 复制文件 | body: `{ srcPath, destPath }` |
| `POST` | `/api/hermes/files/upload` | 上传文件 | multipart + `?path=` 目标目录 |
| `GET` | `/api/hermes/download` | 下载文件 | 复用已有端点 |

**路径约定：**
- 所有 `path` 参数为相对于 hermes home（`~/.hermes/`）的路径
- 示例：`path=skills/web-search/skill.yaml`
- 服务端拼接 hermes home 路径并做安全验证
- 根目录用空字符串或 `.` 表示

**错误码：**
| code | HTTP 状态 | 说明 |
|------|-----------|------|
| `missing_path` | 400 | 缺少路径参数 |
| `invalid_path` | 400 | 路径无效（遍历攻击等） |
| `not_found` | 404 | 文件/目录不存在 |
| `already_exists` | 409 | 目标已存在（创建/重命名冲突） |
| `permission_denied` | 403 | 敏感文件不允许写入 |
| `file_too_large` | 413 | 超过大小限制 |
| `not_a_directory` | 400 | 对文件执行目录操作 |
| `not_a_file` | 400 | 对目录执行文件操作 |
| `backend_error` | 502 | 后端执行失败 |
| `backend_timeout` | 504 | 后端执行超时 |

**路由注册顺序：**
- 文件管理路由必须注册在 proxy 路由之前（与 download 路由一致）

### 3.3 前端组件架构

```
packages/client/src/
├── api/hermes/
│   └── files.ts                  # API 调用封装
├── components/hermes/files/
│   ├── FileTree.vue              # 目录树（懒加载展开）
│   ├── FileList.vue              # 文件列表表格（排序、行内操作）
│   ├── FileBreadcrumb.vue        # 面包屑导航
│   ├── FileToolbar.vue           # 顶部工具栏
│   ├── FileContextMenu.vue       # 右键上下文菜单
│   ├── FileEditor.vue            # Monaco Editor 包装
│   ├── FilePreview.vue           # 文件预览（图片/Markdown）
│   ├── FileUploadModal.vue       # 上传对话框
│   └── FileRenameModal.vue       # 重命名/新建对话框
├── views/hermes/
│   └── FilesView.vue             # 页面容器
├── stores/hermes/
│   └── files.ts                  # Pinia store
└── i18n/locales/
    ├── en.ts                     # 新增 files 分区
    └── zh.ts                     # 新增 files 分区
```

### 3.4 Pinia Store 状态

```typescript
// stores/hermes/files.ts
interface FilesStoreState {
  currentPath: string           // 当前浏览路径
  entries: FileEntry[]          // 当前目录文件列表
  treeData: TreeNode[]          // 目录树数据
  selectedFile: FileEntry | null // 选中文件
  editingFile: {                // 编辑中文件
    path: string
    content: string
    originalContent: string     // 用于检测修改
    language: string            // Monaco 语言 ID
  } | null
  previewFile: {                // 预览中文件
    path: string
    type: 'image' | 'markdown' | 'pdf'
    url?: string
  } | null
  loading: boolean
  sortBy: 'name' | 'size' | 'modTime'
  sortOrder: 'asc' | 'desc'
}
```

### 3.5 页面布局

```
┌──────────────────────────────────────────────────────────┐
│ Sidebar │ FileTree     │ Toolbar (breadcrumb + buttons)  │
│ (nav)   │ (dir tree)   │─────────────────────────────────│
│         │              │ FileList / FileEditor / Preview  │
│         │              │                                  │
│         │              │                                  │
│         │              │──────────────────────────────────│
│         │              │ Status bar                       │
└──────────────────────────────────────────────────────────┘
```

- 目录树宽度：240px，可拖拽调节
- 编辑/预览模式替换文件列表区域
- 工具栏固定在顶部

### 3.6 交互流程

**浏览目录：**
1. 点击目录树节点 → 更新 `currentPath` → 调用 `GET /list` → 刷新文件列表
2. 点击面包屑 → 同上
3. 双击文件列表中的文件夹 → 导航进入

**编辑文件：**
1. 右键 → 编辑 / 点击行内编辑图标
2. 调用 `GET /read` 获取文件内容
3. 文件列表切换为 Monaco Editor
4. 点击保存 → `PUT /write` 保存内容
5. 点击关闭 → 回到文件列表

**上传文件：**
1. 点击工具栏上传 / 拖拽文件到文件列表区域
2. 弹出上传对话框，显示文件列表和目标路径
3. 确认后 `POST /upload` 上传
4. 完成后刷新当前目录

**删除文件/目录：**
1. 右键 → 删除
2. 弹出确认对话框（删除目录时提示递归删除）
3. `DELETE /delete` 执行删除
4. 刷新当前目录

**预览文件：**
1. 点击图片文件 → 行内预览（使用下载 URL 作为 img src）
2. 点击 Markdown 文件 → 使用现有 MarkdownRenderer 渲染预览
3. 其他类型 → 直接下载

## 4. 依赖

**新增 npm 包：**
- `monaco-editor` — 代码编辑器（通过 vite-plugin-monaco-editor 集成）

**复用已有：**
- `FileProvider` 抽象层（file-provider.ts）
- `MarkdownRenderer` 组件（预览 .md 文件）
- `downloadFile()` 函数（下载功能）
- Naive UI 组件（NTree、NDataTable、NDropdown、NModal）
- js-yaml（读取配置）

## 5. 文件变更清单

**新增文件：**
- `packages/server/src/routes/hermes/files.ts` — 文件管理 REST 路由
- `packages/client/src/api/hermes/files.ts` — 前端 API 封装
- `packages/client/src/stores/hermes/files.ts` — Pinia store
- `packages/client/src/views/hermes/FilesView.vue` — 页面容器
- `packages/client/src/components/hermes/files/FileTree.vue`
- `packages/client/src/components/hermes/files/FileList.vue`
- `packages/client/src/components/hermes/files/FileBreadcrumb.vue`
- `packages/client/src/components/hermes/files/FileToolbar.vue`
- `packages/client/src/components/hermes/files/FileContextMenu.vue`
- `packages/client/src/components/hermes/files/FileEditor.vue`
- `packages/client/src/components/hermes/files/FilePreview.vue`
- `packages/client/src/components/hermes/files/FileUploadModal.vue`
- `packages/client/src/components/hermes/files/FileRenameModal.vue`

**修改文件：**
- `packages/server/src/services/hermes/file-provider.ts` — 扩展 FileProvider 接口
- `packages/server/src/routes/hermes/index.ts` — 注册文件管理路由
- `packages/client/src/router/index.ts` — 添加 /hermes/files 路由
- `packages/client/src/components/layout/AppSidebar.vue` — 工具组添加「文件」导航项
- `packages/client/src/i18n/locales/en.ts` — 添加 files 翻译
- `packages/client/src/i18n/locales/zh.ts` — 添加 files 翻译
- `package.json` — 添加 monaco-editor 依赖
- `vite.config.ts` — 添加 monaco-editor 插件配置
