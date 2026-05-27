# 工作日志

## 2026-05-15

### 任务背景

- 检索并梳理 `hermes-web-ui` 项目的技术栈
- 评估是否可以将项目展示层中的 `Hermes` 品牌字段替换为 `QuantHermes`
- 在不修改上游专有名词和技术协议标识的前提下，完成展示层品牌替换
- 将本次分析、方案、执行和验证结果记录到工作日志中

### 分析记录

- 对仓库进行了技术栈检索，确认该项目为前后端单仓库结构
- 前端技术栈确认为 Vue 3、TypeScript、Vite、Pinia、Vue Router、Naive UI
- 后端技术栈确认为 Node.js、Koa、Socket.IO、TypeScript、esbuild
- 数据层使用 SQLite，并在特定条件下支持 JSON 回退
- 部署方式包含 Docker、Docker Compose 和 GitHub Actions

### 品牌改名评估

- 全仓检索了 `Hermes` 的出现位置，并按以下类型进行了分类：
  - 展示文案
  - UI 标题和图片替代文本
  - README 与官网文案
  - API 路径
  - 请求头协议
  - 环境变量
  - 本地目录和包名
- 结论：
  - 仅替换展示层品牌名为 `QuantHermes` 是可行且低风险的
  - 不建议直接全局替换所有 `Hermes` 标识
  - 本次仅处理用户可见的品牌展示，不改动协议、路径、环境变量和命令名

### 已确认的边界

- 保持原样不改：
  - `Hermes Agent`
  - `Hermes CLI`
  - `/api/hermes`
  - `hermes-web-ui`
  - `hermes/` 目录名
  - `HERMES_*` 环境变量
- 仅修改：
  - 前端展示文案中的品牌名
  - 官网展示文案中的品牌名
  - logo 的 `alt` 文本
  - 页面标题
  - README 中的品牌展示标题和演示图片 alt

### 实际修改内容

- 前端品牌展示更新：
  - `packages/client/src/components/layout/AppSidebar.vue`
  - `packages/client/src/views/LoginView.vue`
  - `packages/client/src/components/hermes/chat/MessageList.vue`
  - `packages/client/src/components/hermes/chat/HistoryMessageList.vue`
  - `packages/client/src/components/hermes/chat/MessageItem.vue`
- 前端多语言文案更新：
  - `packages/client/src/i18n/locales/en.ts`
  - `packages/client/src/i18n/locales/zh.ts`
  - `packages/client/src/i18n/locales/zh-TW.ts`
  - `packages/client/src/i18n/locales/de.ts`
  - `packages/client/src/i18n/locales/es.ts`
  - `packages/client/src/i18n/locales/fr.ts`
  - `packages/client/src/i18n/locales/ja.ts`
  - `packages/client/src/i18n/locales/ko.ts`
  - `packages/client/src/i18n/locales/pt.ts`
- 官网品牌展示更新：
  - `packages/website/src/components/layout/SiteHeader.vue`
  - `packages/website/src/components/layout/SiteFooter.vue`
  - `packages/website/index.html`
  - `packages/website/src/i18n/en.ts`
  - `packages/website/src/i18n/zh.ts`
- 文档更新：
  - `README.md`
  - `README_zh.md`

### 验证记录

- 执行了构建验证：
  - `npm run build`
- 构建结果：
  - 构建成功
  - 未发现因本次品牌替换引入的编译错误
- 对近期关键修改文件执行了诊断检查：
  - `AppSidebar.vue`
  - `LoginView.vue`
  - `SiteHeader.vue`
  - `SiteFooter.vue`
  - `packages/client/src/i18n/locales/zh.ts`
  - `packages/website/src/i18n/en.ts`
- 检查结果：
  - 未发现新增诊断错误

### 额外说明

- 当前本地工作区除本次品牌改名外，还存在运行目录、缓存目录及额外文档文件
- 已根据用户确认，将当前工作区全部内容一并保存到本地 git

### 本次结论

- 已完成展示层品牌从 `Hermes` 到 `QuantHermes` 的替换
- 已保持所有上游专有名词和技术标识不变
- 已完成工作日志落盘
- 已准备将当前所有本地工作保存到 git 提交

## 2026-05-15 - 定制版更新机制改造

### 任务背景

- 评估页面内置“更新”功能是否会覆盖定制化开发内容
- 设计并落地“自有包名 + 自有更新源”的更新方案
- 默认阻止定制版继续从上游 `hermes-web-ui` 包执行自更新
- 将更新机制改造过程、配置项和验证结果记录到工作日志，便于后续追踪问题

### 问题分析

- 原有更新提示并不是根据上游源码仓库提交变化触发，而是通过 npm registry 比较版本号
- 原有更新执行会直接运行 `npm install -g hermes-web-ui@latest`
- 对定制版而言，这意味着用户在页面点击更新后，可能直接安装上游官方包并覆盖定制逻辑
- 原有实现还把版本检测源写死为 `https://registry.npmjs.org`
- 更新后的 CLI 路径也写死为 `hermes-web-ui/bin/hermes-web-ui.mjs`，无法支持自有包名

### 实施方案

- 新增服务端更新配置：
  - `WEBUI_UPDATE_ENABLED`
  - `WEBUI_UPDATE_PACKAGE`
  - `WEBUI_UPDATE_REGISTRY`
  - `WEBUI_UPDATE_SOURCE_LABEL`
  - `WEBUI_UPDATE_CLI_BIN`
- 默认行为改为：
  - 未启用或配置不完整时，不检查更新、不显示可升级版本、不允许执行应用内更新
- 自有更新源启用后：
  - 版本检查使用 `WEBUI_UPDATE_REGISTRY + WEBUI_UPDATE_PACKAGE`
  - 安装命令使用自定义包名与自定义 registry
  - 重启时根据自定义 CLI 文件名定位全局安装后的启动脚本

### 实际修改内容

- 服务端配置化更新能力：
  - `packages/server/src/config.ts`
- 服务端版本检测改造：
  - `packages/server/src/controllers/health.ts`
- 服务端更新执行改造：
  - `packages/server/src/controllers/update.ts`
- 前端健康状态类型扩展：
  - `packages/client/src/api/hermes/system.ts`
- 前端更新状态管理改造：
  - `packages/client/src/stores/hermes/app.ts`
- 侧边栏更新入口显示逻辑改造：
  - `packages/client/src/components/layout/AppSidebar.vue`
- 多语言更新文案调整：
  - `packages/client/src/i18n/locales/en.ts`
  - `packages/client/src/i18n/locales/zh.ts`
  - `packages/client/src/i18n/locales/zh-TW.ts`
  - `packages/client/src/i18n/locales/de.ts`
  - `packages/client/src/i18n/locales/es.ts`
  - `packages/client/src/i18n/locales/fr.ts`
  - `packages/client/src/i18n/locales/ja.ts`
  - `packages/client/src/i18n/locales/ko.ts`
  - `packages/client/src/i18n/locales/pt.ts`
- 文档补充：
  - `README.md`
  - `README_zh.md`

### 关键行为变化

- 不再默认向上游 npm 仓库检查更新
- 不再默认执行 `npm install -g hermes-web-ui@latest`
- 只有在显式设置 `WEBUI_UPDATE_ENABLED=true` 且补齐自有更新源配置后，页面才会出现可升级逻辑
- 侧边栏在未启用更新时会提示当前为定制版，升级由内部发布流程管理
- 页面显示的更新源标签可通过 `WEBUI_UPDATE_SOURCE_LABEL` 配置

### 推荐配置

```env
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=quanthermes-web-ui
WEBUI_UPDATE_REGISTRY=https://your-registry.example.com
WEBUI_UPDATE_SOURCE_LABEL=QuantHermes Internal Registry
WEBUI_UPDATE_CLI_BIN=quanthermes-web-ui.mjs
```

### 验证计划

- 检查 TypeScript 诊断是否新增错误
- 执行构建验证更新链路改造后前后端是否仍可正常打包
- 确认未配置更新源时：
  - `webui_update_enabled=false`
  - 前端不显示更新按钮
- 确认配置完成后：
  - 版本检测和安装都只指向自有包与自有 registry

## 2026-05-16 - Armbian 源码部署改造

### 任务背景

- 在 Armbian / Ubuntu ARM64 设备上尝试使用 Docker 部署 `hermes-web-ui`
- 已对 Docker 镜像源、镜像拉取失败、本地构建 fallback 做过多轮修复
- 设备最终仍无法稳定访问 `docker.io`，导致：
  - 预构建镜像拉取失败
  - 本地构建时基础镜像 `nousresearch/hermes-agent:latest` 拉取失败
- 目标切换为：提供一套宿主机源码部署方案，绕开 Docker Hub 依赖，同时保持一键安装、开机自启和文档可追踪

### 问题分析

- 设备对 `hub-mirror.c.163.com` 解析失败，脚本已能自动摘除坏镜像源
- 回退到直连 `docker.io` 后，`registry-1.docker.io` 仍然超时
- 继续坚持 Docker 方案意味着还需要同时处理：
  - Docker Hub 镜像源
  - `nousresearch/hermes-agent` 基础镜像获取
  - `nodejs.org` 下载链路
  - npm registry
- 相比之下，源码部署虽然仍依赖网络，但链路可以拆成：
  - Git 源码
  - Hermes 官方安装脚本
  - Node.js 二进制镜像
  - npm 包镜像
- 用户确认切换为源码部署，并要求 Hermes 也纳入自动安装流程，而不是手工前置安装

### 方案设计

- 新增独立的源码部署脚本，不与现有 Docker 部署脚本混在一起，避免两套路径互相污染
- 脚本职责：
  - 安装基础依赖
  - 自动校时并兜底 `apt update`
  - 创建专用运行用户
  - 通过 `npmmirror` 下载 Node.js 23
  - 调用 Hermes 官方安装脚本自动安装 Hermes Agent
  - 为运行用户写入 npm 国内源配置
  - 执行 `npm install` 和 `npm run build`
  - 生成 systemd 环境文件和服务文件
  - 开机自启 `hermes-web-ui.service`
- 运行模式改为：
  - 宿主机源码构建
  - `node dist/server/index.js`
  - `systemd` 守护
- Hermes 首次配置与绑定仍保留人工执行，避免在脚本中硬编码用户私有凭证流程

### 实际修改内容

- 新增源码部署脚本：
  - `scripts/deploy-source-armbian.sh`
- 新增 systemd 模板：
  - `scripts/hermes-web-ui.service`
- 新增源码部署文档：
  - `docs/deploy-source-armbian.md`
- README 增补源码部署入口：
  - `README.md`
  - `README_zh.md`
- 工作日志补充：
  - `docs/work-log.md`

### 关键实现点

- 运行用户默认使用 `hermesui`，避免直接以交互用户承载 systemd 服务
- Node.js 23 默认从 `npmmirror` 下载，失败时回退官方源
- Hermes 官方安装脚本默认先走 `jsdelivr`，失败时回退 `raw.githubusercontent.com`
- Hermes 官方安装默认附带：
  - `--skip-setup`
  - `--skip-browser`
- npm 默认写入：
  - `https://registry.npmmirror.com`
  - `https://cdn.npmmirror.com/binaries`
- 服务环境写入 `/etc/default/hermes-web-ui`
- systemd 服务名固定为：
  - `hermes-web-ui.service`

### 验证记录

- 对新增脚本和文档进行了静态复读，确认：
  - Node 安装链路、Hermes 安装链路、npm 源配置、构建命令、systemd 变量传递逻辑完整
  - README 与中文 README 均已增加源码部署入口
- 2026-05-18 追加排障确认：
  - 当前仓库根目录未提交 `package-lock.json`
  - 源码部署脚本中的 `npm ci` 会在干净环境直接失败
  - 已将源码部署脚本调整为 `npm install`
  - 已同步修正源码部署文档，避免脚本与文档不一致
- 计划对以下文件执行诊断检查：
  - `scripts/deploy-source-armbian.sh`
  - `scripts/hermes-web-ui.service`
  - `docs/deploy-source-armbian.md`
  - `README.md`
  - `README_zh.md`

### 当前结论

- Docker 路径保留，但不再作为这类受限网络设备的唯一方案
- 已为 Armbian / Ubuntu 设备补充源码部署通道
- 下一步重点是：
  - 校验新增脚本和文档诊断
  - 提交本轮改动到 Git
  - 由用户推送远端并在目标设备执行源码部署脚本验证

## 2026-05-19 - Armbian 源码部署排障补充

### 现场现象

- 目标设备已完成 `scripts/deploy-source-armbian.sh` 部署，`hermes-web-ui.service` 状态正常
- 页面可以访问，但实际聊天时报错：
  - `Error: connect ENOENT /tmp/hermes-agent-bridge.sock`
- 前端可用但 `/chat-run` 不可用，说明 Web UI 主服务启动成功、Hermes agent bridge 未正常就绪

### 根因分析

- `agent bridge` 在启动阶段直接退出，未能创建 `/tmp/hermes-agent-bridge.sock`
- 设备上 `hermesui` 用户实际引用到了 `root` 目录下的 Hermes 安装：
  - `/home/hermesui/.local/bin/hermes -> /root/.local/bin/hermes`
- Web UI 会根据 `hermes` 命令和 Hermes 源码目录反推 `run_agent.py` 所在位置
- 当 `hermesui` 运行的服务错误引用 `root` 用户目录下的 Hermes 安装时，bridge 会报：
  - `RuntimeError: hermes-agent run_agent.py not found`
- 这类情况下即使 `systemd` 服务本身为 `active (running)`，聊天链路仍会失败

### 修复过程

- 停止 `hermes-web-ui.service`
- 清理以下错误或残留安装，避免 `hermesui` 与 `root` 的 Hermes 安装互相污染：
  - `/home/hermesui/.hermes/hermes-agent`
  - `/home/hermesui/.local/share/uv/tools/hermes-agent`
  - `/home/hermesui/.local/bin/hermes`
  - `/root/.local/share/uv/tools/hermes-agent`
  - `/root/.local/bin/hermes`
- 由于 Hermes 官方安装脚本会尝试通过 `sudo` 安装可选依赖，需提前以 `root` 安装系统依赖，避免安装过程卡在 `hermesui` 的 sudo 密码交互：
  - `ripgrep`
  - `ffmpeg`
  - `build-essential`
  - `python3-dev`
  - `libffi-dev`
- 重新以 `hermesui` 用户安装 Hermes，确保安装路径回到 `hermesui` 自己目录
- 安装完成后重启 `hermes-web-ui.service`

### 验证结果

- `hermesui` 用户下的 `hermes` 命令恢复正常
- 重启服务后，聊天功能恢复可用
- 本次问题确认不是前端 UI 或模型配置问题，而是源码部署后的 Hermes 安装归属错误导致 bridge 启动失败

### 后续部署注意事项

- 源码部署完成后，必须优先检查：
  - `/home/hermesui/.local/bin/hermes`
  - `head -n 1 /home/hermesui/.local/bin/hermes`
  - `hermes-web-ui.service` 日志中是否出现 bridge ready
  - `/tmp/hermes-agent-bridge.sock` 是否存在
- 如果发现 `hermesui` 下的 `hermes` 链接到了 `/root/.local/...`，应立即判定为错误安装状态，先修正 Hermes 安装归属再继续排查
- 后续 README 和部署说明需要明确提醒：源码部署前先看 `docs/work-log.md` 中的排障记录
