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
