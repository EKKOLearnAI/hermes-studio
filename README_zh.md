<p align="center">
  <strong>Hermes Web UI</strong>
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> 的全功能桌面应用和 Web 管理面板。<br/>
  管理 AI 聊天会话、监控用量与成本、配置平台渠道、<br/>
  管理定时任务、浏览技能 —— 全部在一个简洁响应式的 Web 界面中完成。
</p>

<p align="center">
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/releases/latest">下载 Hermes Studio 桌面版</a>
  ·
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image1.png" alt="Hermes Web UI 演示" width="680"/>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/image2.png" alt="Hermes Web UI 演示" width="680"/>
</p>

<p align="center">
  <strong>移动端</strong>
</p>

<p align="center">
  <video src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/video.mp4?raw=true" width="360" controls></video>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-web-ui"><img src="https://img.shields.io/npm/v/hermes-web-ui?style=flat-square&color=blue" alt="npm 版本"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/hermes-web-ui?style=flat-square" alt="许可证"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-web-ui/stargazers"><img src="https://img.shields.io/github/stars/EKKOLearnAI/hermes-web-ui?style=flat-square" alt="Star"/></a>
</p>

---

## 功能特性

### AI 聊天

- 聊天前端通过 Socket.IO `/chat-run` 实时流式更新；聊天运行通过 Hermes agent bridge 执行
- 多会话管理 — 创建、重命名、删除、切换会话
- **自建会话数据库** — Web UI 会话使用本地 SQLite；Hermes state.db 仅作为只读来源用于 Hermes 历史 API
- 按来源分组会话（Telegram、Discord、Slack 等），可折叠手风琴面板
- 活跃会话实时指示器 — 正在进行的会话置顶并显示旋转图标
- 按最新消息时间排序会话列表
- Markdown 渲染，支持语法高亮和代码复制
- 工具调用详情展开（参数 / 结果）
- 按 Profile 隔离的文件上传
- 文件下载支持 — 按解析后的路径下载用户上传文件和 Agent 生成文件，兼容 local、Docker、SSH、Singularity 等多种 terminal backend
- 会话搜索 — Ctrl+K 搜索 Web UI 本地会话库；不包含只读 Hermes 历史会话
- 按账号授权 Profile 汇总模型选择器 — 只展示当前账号可访问的 Hermes Profile 中可用的模型
- 每个会话显示模型标签和上下文 Token 用量

### 平台渠道

在一个页面统一配置 **8 个平台**：

| 平台 | 功能 |
|---|---|
| Telegram | Bot Token、提及控制、表情回应、自由回复聊天 |
| Discord | Bot Token、提及、自动线程、表情回应、频道白名单/黑名单 |
| Slack | Bot Token、提及控制、Bot 消息处理 |
| WhatsApp | 启用/禁用、提及控制、提及模式 |
| Matrix | Access Token、Homeserver、自动线程、私信提及线程 |
| 飞书 | App ID / Secret、提及控制 |
| 微信 | 扫码登录（浏览器扫码，自动保存凭证） |
| 企业微信 | Bot ID / Secret |

- 凭证管理写入 `~/.hermes/.env`
- 渠道行为设置写入 `~/.hermes/config.yaml`
- 每个平台已配置/未配置状态检测

### 用量分析

- Token 总用量明细（输入 / 输出）
- 会话数及日均统计
- 预估费用追踪及缓存命中率
- 模型使用分布图
- 30 天每日趋势（柱状图 + 数据表格）

### 定时任务

- 创建、编辑、暂停、恢复、删除 Cron 任务
- 立即触发执行
- Cron 表达式快捷预设

### 模型管理

- 从凭证池自动发现模型（`~/.hermes/auth.json`）
- 从每个 Provider 端点获取可用模型（`/v1/models`）
- 添加、更新、删除 Provider（预设 & 自定义 OpenAI 兼容）
- OpenAI Codex 和 Nous Portal OAuth 登录
- Provider URL 自动检测，支持非 v1 API 版本（如 `/v4`）
- Provider 级别模型分组，支持切换默认模型

### 多配置文件

- 创建、重命名、删除、切换 Hermes 配置文件（Profile）
- 克隆现有配置文件或从归档导入（`.tar.gz`）
- 导出配置文件用于备份或分享
- 按 Profile 隔离配置、缓存、上传、会话、任务、用量、记忆、技能、插件、Provider 和模型可见性
- 账号绑定 Profile 权限：超级管理员可以管理全部 Profile；普通管理员只能查看和使用分配给自己的 Profile

### 文件浏览器

- 浏览远程后端文件（local、Docker、SSH、Singularity）
- 上传、下载、重命名、复制、移动和删除文件
- 上传文件保存到当前选择/请求的 Hermes Profile 目录下；下载按真实路径解析，支持下载上传目录外的 Agent 产物
- 创建目录
- 查看文件内容，支持语法高亮

### 群聊

- 多 Agent 聊天房间，通过 Socket.IO 实时通信
- @提及路由 — 提及 Agent 触发上下文回复
- 上下文压缩 — 历史消息超过 Token 阈值时自动摘要压缩
- 输入状态和回复进度指示器
- 房间创建、删除和邀请码管理
- Agent 管理 — 添加/移除房间中的 Agent，支持独立 Profile
- SQLite 消息持久化
- 移动端响应式布局，可折叠侧边栏

### 技能与记忆

- 浏览和搜索已安装的技能
- 查看技能详情和附件
- 用户笔记和档案管理

### 日志

- 查看 Agent / Server / Error 日志
- 按日志级别、日志文件和关键词过滤
- 结构化日志解析，HTTP 访问日志高亮

### 认证

- 基于 Token 的认证（首次运行自动生成或通过 `AUTH_TOKEN` 环境变量设置）
- 用户名/密码登录，并在设置页提供账户管理
- 默认登录名/密码为 `admin` / `123456`；登录后会提示尽快修改默认账户和密码
- 超级管理员可以管理用户和 Profile 绑定；普通管理员只能管理自己的账户信息

CLI 维护命令：

```bash
# 删除持久化的登录 IP 锁记录
hermes-web-ui clear-login-locks

# 删除登录锁并重启正在运行的 Web UI 进程
hermes-web-ui clear-login-locks --restart

# 创建或重置默认超级管理员登录名/密码为 admin / 123456
hermes-web-ui reset-default-login
```

`clear-login-locks` 会删除 `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json`。如果服务正在运行，需要重启服务才能清理内存中的锁定状态。`reset-default-login` 会更新 Web UI 账户数据库；如果已存在 `admin` 用户，则会把密码重置为 `123456`，并启用为超级管理员账户。

### 设置

- 显示（流式输出、紧凑模式、推理过程、费用显示）
- Agent（最大轮次、超时时间、工具强制执行）
- 记忆（启用/禁用、字符限制）
- 会话重置（空闲超时、定时重置）
- 隐私（PII 脱敏）
- 模型设置（默认模型 & Provider）
- Profile 和 Provider 配置

### Web 终端

- 集成终端，基于 node-pty 和 @xterm/xterm
- 多会话支持 — 创建、切换、关闭终端会话
- 通过 WebSocket 实时传输键盘输入和 PTY 输出
- 支持窗口大小调整

---

## 快速开始

### 桌面应用（推荐）

从 [GitHub Releases](https://github.com/EKKOLearnAI/hermes-web-ui/releases/latest)
下载最新的 **Hermes Studio** 桌面安装包。

桌面版会发布 macOS、Windows 和 Linux 构建；适用时会区分不同 CPU 架构。
桌面应用内置 Web UI 运行时，Hermes Agent 数据会保存到原生 Hermes 目录：

- Windows：`%LOCALAPPDATA%\hermes`（找不到时回退到 `%APPDATA%\hermes`）
- macOS/Linux：`~/.hermes`

桌面壳自身的 Web UI 状态会单独保存到 `~/.hermes-web-ui`，除非设置了
`HERMES_WEB_UI_HOME`。

### npm 安装

```bash
npm install -g hermes-web-ui
hermes-web-ui start
```

打开 **http://localhost:8648**

### Docker Compose

单容器部署，内置 Hermes Agent 运行时：

```bash
# 使用预构建镜像（推荐）
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# 或从源码构建
docker compose up -d --build

docker compose logs -f hermes-webui
```

打开 **http://localhost:6060**

- Hermes 持久化数据目录：`./hermes_data`
- Web UI 认证 Token 存储在 `./hermes_data/hermes-web-ui/.token`
- 首次启动并开启认证时，Token 会打印到容器日志中
- 运行参数全部由 `docker-compose.yml` 环境变量驱动

更详细的说明与排错见：[`docs/docker.md`](./docs/docker.md)

### Hermes Agent 运行时发现

Web UI 启动后端聊天能力时，会优先使用包含 `run_agent.py` 的源码目录，例如
`~/.hermes/hermes-agent`。如果找不到源码目录，会退回到已安装 `hermes` 命令所使用
的 Python 环境，再退到系统 Python。因此源码安装和 `pip install hermes-agent` 这类
包安装方式都可以兼容。

## Web UI 环境变量

这些变量用于配置 Hermes Web UI、本地 Hermes runtime 集成以及开发/预览辅助能力。Provider API Key 和 Hermes Agent 相关设置通常仍通过 Hermes profile 管理；这里列出的变量是进程级覆盖项。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8648` | Web UI 监听端口。 |
| `BIND_HOST` | `0.0.0.0` | Web UI 绑定地址。如需 IPv6，可显式设置为 `::`。 |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Web UI 数据目录，用于认证 token、登录凭据、日志、数据库和默认上传目录。兼容支持 `HERMES_WEBUI_STATE_DIR` 作为别名。 |
| `HERMES_WEBUI_STATE_DIR` | 未设置 | `HERMES_WEB_UI_HOME` 的兼容别名。 |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | 覆盖上传根目录。文件会保存在按 Profile 隔离的子目录下。 |
| `CORS_ORIGINS` | 仅同 host | HTTP、Socket.IO、WebSocket 跨源 allowlist，支持逗号或空格分隔。只有明确需要旧版 wildcard CORS 时才设置为 `*`。 |
| `AUTH_TOKEN` | 自动生成 | 显式指定 bearer token。未设置时，Web UI 会在 `HERMES_WEB_UI_HOME` 下自动生成。 |
| `AUTH_JWT_SECRET` | `AUTH_TOKEN` | 用户名/密码会话的 JWT 签名密钥覆盖。 |
| `PROFILE` | `default` | 启动/默认 Hermes profile。运行时请求使用前端当前选择且当前账号有权限访问的 Profile。 |
| `LOG_LEVEL` | `info` | Server 日志级别。 |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` 或 `info` | Bridge 日志级别。 |
| `MAX_DOWNLOAD_SIZE` | `200MB` | 最大文件下载大小。 |
| `MAX_EDIT_SIZE` | `10MB` | 最大可编辑文件大小。 |
| `WORKSPACE_BASE` | `/opt/data/workspace` | Workspace 浏览根目录。 |
| `HERMES_HOME` | 平台默认值 | Hermes 数据目录。Windows 使用 `%LOCALAPPDATA%\hermes`；macOS/Linux 使用 `~/.hermes`。 |
| `HERMES_BIN` | `hermes` | 自定义 Hermes CLI 二进制路径。 |
| `HERMES_AGENT_ROOT` | 自动发现 | 包含 `run_agent.py` 的 Hermes Agent 源码目录。 |
| `HERMES_AGENT_BRIDGE_PYTHON` | 自动发现 | 用于启动 agent bridge 的 Python 解释器。 |
| `HERMES_AGENT_BRIDGE_UV` | 自动发现 | 可用时用于启动 agent bridge 的 `uv` 可执行文件。 |
| `UV` | 自动发现 | `uv` 可执行文件 fallback。 |
| `PYTHON` | 自动发现 | agent bridge 的 Python 可执行文件 fallback。 |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | 平台默认值 | Agent bridge broker endpoint。Windows 默认 `tcp://127.0.0.1:18765`；macOS/Linux 默认 `ipc:///tmp/hermes-agent-bridge.sock`。 |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Node 请求 bridge broker 的响应超时。 |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | 连接 bridge socket 失败时的短重试窗口。 |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | 等待 Python bridge ready 的超时。 |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | 开启 | bridge broker 意外退出后是否自动重启；设为 `0`、`false`、`no` 或 `off` 可关闭。 |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | bridge 自动重启退避的基础延迟。 |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | 传给 Hermes Agent 的 platform 标识。 |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | 平台默认值 | Profile worker transport。设为 `tcp` 使用 loopback TCP；设为 `ipc`/`unix` 使用 Unix domain socket；默认 Windows TCP、macOS/Linux IPC。 |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | TCP worker endpoint 起始端口。 |
| `HERMES_BRIDGE_PROVIDER` | profile/默认值 | bridge 运行时的 provider 覆盖。 |
| `HERMES_BRIDGE_TOOLSETS` | profile/默认值 | bridge 运行时的 toolset 覆盖。 |
| `HERMES_BRIDGE_MAX_TURNS` | profile/默认值 | bridge 运行时的最大轮数覆盖。 |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | 控制传给 Hermes Agent 的 bridge platform hint suppression。 |
| `HERMES_OPENROUTER_APP_REFERER` | `https://hermes-studio.ai` | bridge 运行发送给 OpenRouter 的 attribution referer。 |
| `HERMES_OPENROUTER_APP_TITLE` | `Hermes Web UI` | bridge 运行发送给 OpenRouter 的 attribution title。 |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | bridge 运行发送给 OpenRouter 的 attribution categories。 |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | 由平台/运行环境决定 | 强制启用旧 gateway 进程托管；设为 `1`、`true`、`yes` 或 `on` 开启。 |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | 未设置 | 跳过启动时的 gateway 检查/自动启动；dashboard-only 部署中如果由其它服务管理 Hermes gateway，可设为 `1`、`true`、`yes` 或 `on`。 |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | 未设置 | 跳过启动时的内置 skill 注入；如果内置 skills 由 Web UI 外部管理，或不希望覆盖同名目标目录，可设为 `1`、`true`、`yes` 或 `on`。 |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | 生产环境默认开启 | Web UI 关闭时是否同时停止托管的 gateway 进程；设为 `0` 或 `false` 可让 gateway 分离运行。 |
| `GATEWAY_HOST` | `127.0.0.1` | 旧 gateway 兼容配置中写入 profile 的默认 gateway host。 |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | Version Preview 使用的 GitHub 仓库。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | 平台默认值 | Version Preview broker transport。设为 `tcp` 可让预览环境在 macOS/Linux 上也使用 loopback TCP；未设置时会跟随 `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp`。 |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | 隔离的预览 endpoint | 直接覆盖 Version Preview 的 broker endpoint。 |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Vite dev proxy 使用的后端端口。 |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | 前端 Vite dev server 端口。 |

### CLI 命令

| 命令 | 说明 |
|---|---|
| `hermes-web-ui start` | 后台启动（守护进程模式） |
| `hermes-web-ui start --port 9000` | 自定义端口启动 |
| `hermes-web-ui stop` | 停止后台进程 |
| `hermes-web-ui restart` | 重启后台进程 |
| `hermes-web-ui status` | 查看运行状态 |
| `hermes-web-ui update` | 更新到最新版本并重启 |
| `hermes-web-ui upgrade` | `update` 的别名 |
| `hermes-web-ui -v` | 显示版本号 |
| `hermes-web-ui -h` | 显示帮助信息 |

`update` / `upgrade` 会先尝试执行 `npm cache clean --force`，再执行 `npm install -g hermes-web-ui@latest` 并重启。缓存清理是 best-effort；如果清理失败，只提示 warning，升级安装会继续执行。

### 自动配置

启动时 BFF 服务器会自动：

- 初始化 Web UI 数据目录、本地数据库和内置技能
- 启动 `/chat-run` 使用的 Hermes agent bridge
- 启动成功后自动打开浏览器

---

## 开发

```bash
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd hermes-web-ui
npm install
npm run dev
```

- 前端：http://localhost:8649
- BFF 服务器：http://localhost:8647

```bash
npm run build   # 构建输出到 dist/
```

项目开发规范见：[DEVELOPMENT.md](./DEVELOPMENT.md)。

## 架构

```
浏览器 → BFF (Koa, :8648) → Socket.IO /chat-run
                ↓
        Hermes agent bridge → Hermes Agent runtime
                ↓
           Hermes CLI / profiles
           profile config.yaml    (渠道/Provider 配置)
           profile auth.json      (凭证池)
           腾讯 iLink API         (微信扫码登录)
```

前端采用 **多 Agent 可扩展架构** — 所有 Hermes 相关代码都按命名空间组织在 `hermes/` 目录下（API、组件、视图、Store），可以方便地并行接入新的 Agent。

BFF 层负责：Socket.IO 聊天流式推送、Hermes agent bridge、按 Profile 隔离的上传和按路径解析的下载（多 Backend 支持：local/Docker/SSH/Singularity）、会话 CRUD、分账户分 Profile 管理、配置/凭证管理、微信扫码登录、模型发现、技能/记忆管理、日志读取和静态文件服务。

## 技术栈

**前端：** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**后端：** Koa 2（BFF 服务器）+ node-pty（Web 终端）

## Star 历史

[![Star 历史图表](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-web-ui&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-web-ui&Date)

<!-- 如上方图表未加载，可访问 https://star-history.com/#EKKOLearnAI/hermes-web-ui -->

## 许可证

[BSL-1.1](./LICENSE)
