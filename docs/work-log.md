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
