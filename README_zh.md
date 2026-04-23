<p align="center">
  <strong>Hermes Web UI</strong>
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> 的全功能 Web 管理面板。<br/>
  管理 AI 聊天会话、监控用量与成本、配置平台渠道、<br/>
  管理定时任务、浏览技能 —— 全部在一个简洁响应式的 Web 界面中完成。
</p>

<p align="center">
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-web-ui/blob/main/packages/client/src/assets/output.gif" alt="Hermes Web UI 演示" width="680"/>
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

- 通过 SSE 实时流式输出，支持异步 Run
- 多会话管理 — 创建、重命名、删除、切换会话
- 按来源分组会话（Telegram、Discord、Slack 等），可折叠手风琴面板
- 活跃会话实时指示器 — 正在进行的会话置顶并显示旋转图标
- 按最新消息时间排序会话列表
- Markdown 渲染，支持语法高亮和代码复制
- 工具调用详情展开（参数 / 结果）
- 文件上传支持
- 文件下载支持 — 支持下载用户上传的文件和 Agent 生成的文件，兼容 local、Docker、SSH、Singularity 等多种 terminal backend
- 会话搜索 — Ctrl+K 全局搜索所有对话
- 全局模型选择器 — 自动从 `~/.hermes/auth.json` 凭证池发现可用模型
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
- 配置变更后自动重启网关
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

### 多配置文件与网关

- 创建、重命名、删除、切换 Hermes 配置文件（Profile）
- 克隆现有配置文件或从归档导入（`.tar.gz`）
- 导出配置文件用于备份或分享
- 多网关管理 — 按 Profile 启动、停止、监控网关
- 自动端口冲突解决
- 配置文件级别的配置和缓存隔离

### 文件浏览器

- 浏览远程后端文件（local、Docker、SSH、Singularity）
- 上传、下载、重命名、复制、移动和删除文件
- 创建目录
- 查看文件内容，支持语法高亮

### 技能与记忆

- 浏览和搜索已安装的技能
- 查看技能详情和附件
- 用户笔记和档案管理

### 日志

- 查看 Agent / Gateway / Error 日志
- 按日志级别、日志文件和关键词过滤
- 结构化日志解析，HTTP 访问日志高亮

### 认证

- 基于 Token 的认证（首次运行自动生成或通过 `AUTH_TOKEN` 环境变量设置）
- 可选的用户名/密码登录 — 通过初始 Token 认证后在设置页面设置
- 可通过 `AUTH_DISABLED=1` 禁用认证

### 设置

- 显示（流式输出、紧凑模式、推理过程、费用显示）
- Agent（最大轮次、超时时间、工具强制执行）
- 记忆（启用/禁用、字符限制）
- 会话重置（空闲超时、定时重置）
- 隐私（PII 脱敏）
- 模型设置（默认模型 & Provider）
- API 服务器配置

### Web 终端

- 集成终端，基于 node-pty 和 @xterm/xterm
- 多会话支持 — 创建、切换、关闭终端会话
- 通过 WebSocket 实时传输键盘输入和 PTY 输出
- 支持窗口大小调整

---

## 快速开始

### npm 安装（推荐）

```bash
npm install -g hermes-web-ui
hermes-web-ui start
```

打开 **http://localhost:8648**

### 一键安装（自动检测系统）

自动安装 Node.js（如未安装）和 hermes-web-ui，支持 Debian/Ubuntu/macOS：

```bash
bash <(curl -fsSL https://cdn.jsdelivr.net/gh/EKKOLearnAI/hermes-web-ui@main/scripts/setup.sh)
```

### WSL

```bash
bash <(curl -fsSL https://cdn.jsdelivr.net/gh/EKKOLearnAI/hermes-web-ui@main/scripts/setup.sh)
hermes-web-ui start
```

> WSL 会自动检测并使用 `hermes gateway run` 进行后台启动（无需 launchd/systemd）。

### Docker Compose

使用仓库内置的 compose 文件联合运行 Hermes Agent + Web UI：

```bash
# 使用预构建镜像（推荐）
WEBUI_IMAGE=ekkoye8888/hermes-web-ui:latest docker compose up -d hermes-agent hermes-webui

# 或从源码构建
docker compose up -d --build hermes-agent hermes-webui

docker compose logs -f hermes-webui
```

打开 **http://localhost:6060**

- Hermes 持久化数据目录：`./hermes_data`
- Web UI 认证 Token 存储在 `./hermes_data/hermes-web-ui/.token`
- 首次启动并开启认证时，Token 会打印到容器日志中
- 运行参数全部由 `docker-compose.yml` 环境变量驱动

更详细的说明与排错见：[`docs/docker.md`](./docs/docker.md)

### CLI 命令

| 命令 | 说明 |
|---|---|
| `hermes-web-ui start` | 后台启动（守护进程模式） |
| `hermes-web-ui start --port 9000` | 自定义端口启动 |
| `hermes-web-ui stop` | 停止后台进程 |
| `hermes-web-ui restart` | 重启后台进程 |
| `hermes-web-ui status` | 查看运行状态 |
| `hermes-web-ui update` | 更新到最新版本并重启 |
| `hermes-web-ui -v` | 显示版本号 |
| `hermes-web-ui -h` | 显示帮助信息 |

### 自动配置

启动时 BFF 服务器会自动：

- 校验 `~/.hermes/config.yaml` 并补全缺失的 `api_server` 字段
- 修改时备份原配置到 `config.yaml.bak`
- 检测并启动网关（如未运行）
- 解决端口冲突（清理残留进程）
- 启动成功后自动打开浏览器

---

## 开发

```bash
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd hermes-web-ui
npm install
npm run dev
```

- 前端：http://localhost:5173
- BFF 服务器：http://localhost:8648（代理到 Hermes 网关 8642）

```bash
npm run build   # 构建输出到 dist/
```

## 架构

```
浏览器 → BFF (Koa, :8648) → Hermes 网关 (:8642)
                ↓
           Hermes CLI (会话、日志、版本)
                ↓
           ~/.hermes/config.yaml  (渠道行为配置)
           ~/.hermes/auth.json    (凭证池)
           腾讯 iLink API         (微信扫码登录)
```

前端采用 **多 Agent 可扩展架构** — 所有 Hermes 相关代码都按命名空间组织在 `hermes/` 目录下（API、组件、视图、Store），可以方便地并行接入新的 Agent。

BFF 层负责：API 代理（含路径重写）、SSE 流式推送、文件上传与下载（多 Backend 支持：local/Docker/SSH/Singularity）、通过 CLI 管理会话 CRUD、配置/凭证管理、微信扫码登录、模型发现、技能/记忆管理、日志读取和静态文件服务。

## 技术栈

**前端：** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**后端：** Koa 2（BFF 服务器）+ node-pty（Web 终端）

## Star 历史

[![Star 历史图表](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-web-ui&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-web-ui&Date)

<!-- 如上方图表未加载，可访问 https://star-history.com/#EKKOLearnAI/hermes-web-ui -->

## 赞助

如果你觉得这个项目对你有帮助，欢迎支持我：

<a href="https://ifdian.net/a/ekko8888"><img src="https://img.shields.io/badge/Sponsor-%E7%88%B1%E5%8F%91%E7%94%B5-orange?style=flat-square" alt="Sponsor"/></a>

## 许可证

[MIT](./LICENSE)
