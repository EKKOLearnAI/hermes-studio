# 项目结构解析

## 概述

本仓库是一个围绕 Hermes Agent 构建的单仓库全栈项目，主要由以下三部分组成：

- `packages/client`：主 Web UI，负责页面、交互、状态管理和前端 API 调用
- `packages/server`：Koa BFF 服务，负责鉴权、聚合接口、代理 Hermes Gateway、管理实时通道与本地数据
- `packages/website`：官网与文档站点

除业务代码外，仓库根目录还包含 CLI 启动器、构建脚本、Docker 部署文件、测试和开发文档。

---

## 仓库顶层结构

| 路径 | 作用 |
|------|------|
| `bin/` | CLI 入口，提供 `hermes-web-ui` 启停、状态检查和更新能力 |
| `docs/` | 开发、部署和实现说明文档 |
| `packages/` | 主体代码目录，包含前端、后端和官网 |
| `scripts/` | 构建、打包、OpenAPI 生成等脚本 |
| `tests/` | 前后端测试与共享逻辑测试 |
| `dist/` | 构建输出目录，包含 `dist/client`、`dist/server`、`dist/website` |
| `package.json` | 仓库总入口，定义依赖、脚本、CLI 映射和构建命令 |
| `vite.config.ts` | 主 Web UI 的 Vite 配置 |
| `vite.config.website.ts` | 官网的 Vite 配置 |
| `nodemon.json` | 服务端开发态热重载配置 |
| `Dockerfile` / `docker-compose.yml` | 容器构建与部署入口 |

---

## packages/client：前端应用

`packages/client` 是主 Web UI 的前端工程，使用 Vue 3、Pinia、Vue Router、Vue I18n、Naive UI 和 Vite。

### 重点目录

| 路径 | 作用 |
|------|------|
| `src/main.ts` | 前端启动入口，负责挂载 Pinia、i18n、router |
| `src/router/` | 页面路由定义，组织登录页与各 Hermes 功能页 |
| `src/views/` | 页面级视图组件 |
| `src/components/` | 通用组件与 Hermes 业务组件 |
| `src/components/hermes/` | 聊天、文件、群聊、看板、设置等核心业务 UI |
| `src/stores/` | Pinia 状态管理 |
| `src/stores/hermes/` | Hermes 业务域 store，如 chat、profiles、gateways、files、jobs |
| `src/api/` | HTTP 请求封装与业务 API |
| `src/api/hermes/` | Hermes 相关 API 与 Socket.IO 客户端 |
| `src/i18n/` | 国际化资源和初始化逻辑 |
| `src/composables/` | 复用式组合逻辑 |
| `src/utils/` | 前端工具函数 |

### 前端职责

- 负责渲染登录、聊天、历史、任务、看板、模型、Profile、Gateway、终端、文件等界面
- 统一管理登录态、当前 profile、会话状态和业务缓存
- 通过 `fetch` 调用本地 BFF，通过 Socket.IO 或原生 WebSocket 接入实时能力

---

## packages/server：后端服务

`packages/server` 是项目的 Koa BFF 服务，也是本仓库运行时的核心调度层。它既提供本地管理接口，也代理 Hermes Gateway，并负责 WebSocket、Socket.IO、SQLite、本地文件和部分 CLI 集成能力。

### 重点目录

| 路径 | 作用 |
|------|------|
| `src/index.ts` | 服务启动入口 |
| `src/config.ts` | 服务端基础配置，如端口、绑定地址、目录和 CORS |
| `src/routes/` | Koa 路由注册入口与各业务路由 |
| `src/routes/hermes/` | Hermes 相关 API，包括 sessions、profiles、models、gateways、files、jobs、kanban 等 |
| `src/controllers/` | 路由对应的控制器逻辑 |
| `src/controllers/hermes/` | Hermes 业务控制器 |
| `src/services/` | 服务层逻辑 |
| `src/services/hermes/` | Gateway、群聊、聊天运行、上下文压缩、终端、文件等核心服务 |
| `src/services/hermes/agent-bridge/` | Python Agent Bridge 集成层 |
| `src/db/` | 本地 SQLite 数据访问与初始化 |
| `src/db/hermes/` | Hermes Web UI 自建数据表和初始化逻辑 |
| `src/shared/` | 前后端共享类型和常量 |
| `src/lib/` | 基础工具与辅助库 |

### 后端职责

- 启动和管理 Koa 服务
- 提供健康检查、认证、配置管理、日志、文件、任务、看板等本地接口
- 根据当前 profile 选择并代理 Hermes Gateway
- 管理 `/chat-run`、`/group-chat` 等 Socket.IO 命名空间
- 管理终端和看板事件的原生 WebSocket 通道
- 维护本地 SQLite 会话、usage、快照和业务状态

---

## packages/website：官网与文档站

`packages/website` 是独立的 Vite 站点，用于官网展示、文档内容和部分独立页面。它不参与主 Web UI 的运行链路，也不会由主服务端直接在开发态托管。

### 典型用途

- 对外展示项目能力
- 承载官网页面与文档内容
- 与主应用共享一部分工程配置，但构建产物独立输出到 `dist/website`

---

## docs：开发与运维文档

`docs/` 用于保存开发、部署和实现文档，当前采用扁平目录结构。

### 已有文档类型

- `docker.md`：容器部署说明
- `gateway-development.md`：Gateway 开发与运行机制
- `cli-chat-sessions.md`：聊天链路实现说明
- `openapi.json`：接口描述文件

### 适合放入 docs 的内容

- 架构说明
- 实现细节
- 开发排障指南
- 部署和运行手册

---

## scripts：构建与辅助脚本

`scripts/` 存放构建、打包和辅助脚本，通常由根 `package.json` 中的 scripts 调用。

### 关键脚本

| 文件 | 作用 |
|------|------|
| `scripts/build-server.mjs` | 使用 esbuild 打包服务端代码到 `dist/server/index.js` |
| `scripts/setup.sh` | 环境检查与初始化脚本，偏向类 Unix 环境 |
| 其他脚本 | OpenAPI 生成、构建辅助和维护任务 |

---

## tests：测试组织

`tests/` 用于保存前端、后端和共享逻辑的测试用例，整体结构与业务模块对应关系较清晰。

### 测试价值

- 帮助识别作者重点关注的能力边界
- 为关键行为提供回归保障
- 作为理解复杂模块行为的补充入口

---

## 关键入口文件

以下文件是理解项目时最值得优先阅读的入口：

| 文件 | 说明 |
|------|------|
| `package.json` | 总脚本、依赖、CLI 映射、构建入口 |
| `packages/client/src/main.ts` | 前端挂载入口 |
| `packages/client/src/router/index.ts` | 前端页面地图 |
| `packages/client/src/api/client.ts` | 前端请求基础设施 |
| `packages/server/src/index.ts` | 服务启动总入口 |
| `packages/server/src/routes/index.ts` | 后端路由装配点 |
| `packages/server/src/services/hermes/gateway-manager.ts` | 多 Profile Gateway 核心管理器 |
| `packages/server/src/services/hermes/chat-run-socket.ts` | 聊天实时链路核心 |
| `bin/hermes-web-ui.mjs` | CLI 启动与守护入口 |

---

## 启动链路

项目可以从开发态、生产构建和 CLI 三条路径理解运行过程。

### 开发态

```text
npm run dev
  ├─ npm run dev:client  -> Vite Dev Server
  └─ npm run dev:server  -> nodemon -> ts-node -> packages/server/src/index.ts
```

开发时浏览器访问前端页面，接口请求由 Vite 代理到本地 Koa 服务。Koa 服务再根据路由决定是本地处理，还是继续转发到 Hermes Gateway。

### 生产构建

```text
npm run build
  ├─ vue-tsc -b
  ├─ vite build                -> dist/client
  ├─ tsc --noEmit (server)
  └─ node scripts/build-server.mjs -> dist/server/index.js
```

构建完成后，服务端静态托管 `dist/client`，并以 `dist/server/index.js` 作为运行入口。

### CLI 启动

```text
hermes-web-ui start
  └─ bin/hermes-web-ui.mjs
       └─ node dist/server/index.js
```

CLI 会处理 token、端口占用、PID 和守护运行，再轮询 `/health` 判断服务是否就绪。

---

## 运行时数据流

从运行时角度看，主应用大致是如下结构：

```text
Browser
  -> Client (Vue + Pinia + Router)
  -> Server (Koa BFF)
  -> GatewayManager
  -> Hermes Gateway
  -> 模型平台 / 外部能力
```

其中：

- 普通管理接口由 Koa 本地处理
- Hermes 原生能力通过代理层转发到对应 profile 的 Gateway
- 聊天走 `/chat-run` Socket.IO
- 群聊走 `/group-chat` Socket.IO
- 终端和看板事件走原生 WebSocket

---

## 推荐阅读顺序

如果是第一次接手本仓库，建议按以下顺序阅读：

1. `package.json`
2. `packages/server/src/index.ts`
3. `packages/server/src/routes/index.ts`
4. `packages/client/src/main.ts`
5. `packages/client/src/router/index.ts`
6. `packages/client/src/stores/hermes/`
7. `packages/server/src/services/hermes/`
8. `docs/` 中与目标功能相关的实现文档

这样可以先掌握启动方式和主链路，再进入具体业务模块。

---

## 新增模块时的放置建议

- 新页面优先放在 `packages/client/src/views/hermes/`
- 新业务组件优先放在 `packages/client/src/components/hermes/`
- 新前端状态优先归档到 `packages/client/src/stores/hermes/`
- 新后端接口优先在 `packages/server/src/routes/hermes/` 与 `controllers/hermes/` 成对落位
- 新服务编排逻辑优先放在 `packages/server/src/services/hermes/`
- 新文档优先放在 `docs/`，除非文档数量明显增长再考虑分目录

---

## 维护约定

- `packages/client` 负责界面、交互和前端状态，不直接承担后端编排逻辑
- `packages/server` 负责鉴权、聚合、代理、实时连接和本地数据
- `packages/website` 作为独立站点维护，不与主 Web UI 运行链路混在一起
- `docs/` 用于记录实现、部署和接手说明，适合作为长期维护资料

这份文档的目标不是替代 README，而是帮助开发者在进入具体模块前快速建立仓库地图。
