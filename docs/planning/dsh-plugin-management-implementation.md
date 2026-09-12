# DSH 插件清单与附加包管理：当前实现

本页记录当前代码，不替代完整的 [Profiles / Plugins 规划](dsh-profiles-and-plugins.md)。

## 原生插件清单

入口为 Agent 管理 → DSH → 插件管理，优先显示原生预设插件。页面与 Hermes 插件管理共用统计卡片、筛选栏、表格样式和拼图入口图标。

- 从当前 DSH 命令对应的安装包解析 `@deepseek-ai/dsh-agent-presets`，不从 Studio 新建的软件包目录推断原生插件数量。
- 按上游的内置根优先规则读取安装包 `presets/` 和 DSH Home 的 `.agent-presets/`，支持嵌套 group、用户元数据、搜索、预设切换和损坏预设提示。
- 已在本机 `dsh-agent-presets@0.1.5-rc.2` 核对：`standard` 为 28 项，`minimal` 为 6 项，`ptc` 和 `cordis` 各为 29 项。插件条目数不等于 npm 包数；同一模块可用不同配置注册多项。
- YAML 作为数据解析，不执行 `!!js`。条件表达式显示“按条件启用”，运行状态为 `null`，不伪造 active。
- 这是内置和用户预设的配置发现，不是 Web 进程的实时 `pluginInventory.list()`：尚未解析部署自定义 roots / overlays，不包含完整 Host Loader 清单，不能据此声称 Studio ACP 已挂载这些预设。原生清单目前只读。

## 附加 ACP 包

首屏清单下面的折叠区域管理 Studio 自己安装的软件包。

- 安装 / 更新必须指定 registry 包精确版本，使用官方 `dsh plugin`，固定 pnpm 10.33.0 并禁用安装脚本。新 bundle 默认禁用，普通依赖没有插件启用开关。
- 支持卸载、bundle 启停、附加 YAML patch 编辑、异步操作记录和保留版本回滚。声明 Web browser component 的 bundle 不能启用。
- 每次包变更在新的 Studio Home 中安装依赖，检查实际安装版本后才发布状态指针；CLI 退出成功但没有完成变更也判为失败。
- 所有写入位于 `<Studio Home>/coding-agents/dsh/plugins`，不修改原生 DSH Home。修改按 `If-Match` 防止覆盖冲突；幂等键避免网络重试重复执行。
- 全局和 scoped ACP 启动均加入已启用的 bundle patches 与附加配置，然后应用 Studio 自己的启动覆盖。配置修改在下一次 DSH 启动时生效；旧版本路径保留。
- bundle 兼容性始终标为未验证。当前真实安装实验覆盖相对模块路径的 bundle；没有证明任意第三方 bundle、裸模块解析、浏览器注入或全部 Web 能力兼容。
- 尚未实现旧版本自动清理、原生预设编辑/挂载、持久 ACP runtime 或实时 Fiber 状态。不能把本次提交记为 T04–T11 整体完成。

## API

所有接口均要求 super admin，完整请求格式见 `docs/openapi.json`。

- `GET /api/coding-agents/dsh/plugin-inventory`：原生预设条目、来源路径和配置启用状态。
- `GET /api/coding-agents/dsh/plugins`：附加包、活动版本、YAML 配置、保留版本和最近 30 次操作。
- `POST /api/coding-agents/dsh/plugin-operations`：带 `If-Match` 与 `idempotencyKey` 的变更请求，返回 `202`。
- `GET /api/coding-agents/dsh/plugin-operations/:operationId`：查询异步操作终态。

## 验证

```sh
# 环境不应继承 Studio 服务的 NODE_ENV=production 或 PORT。
env -u NODE_ENV -u PORT npx vitest run tests/server/dsh-plugin-inventory.test.ts tests/server/dsh-plugins.test.ts tests/server/dsh-plugin-routes.test.ts tests/server/dsh-runtime-config.test.ts
npx playwright test tests/e2e/dsh-plugins.spec.ts tests/e2e/dsh-management.spec.ts

# 显式启用本地真实 CLI 实验；应先按兼容性证据安装已固定的 rc.1 runtime。
DSH_PLUGINS_REAL=1 DSH_REAL_BIN=/absolute/path/to/dsh/lib/bin.js npx vitest run tests/server/dsh-plugins-real.test.ts
# 验证实际路由通过 PATH 找到当前 CLI，再读取 standard 的 28 项。
DSH_NATIVE_REAL=1 npx vitest run tests/server/dsh-native-discovery-real.test.ts
# 对已安装的 rc.2 原生清单核对 standard 的 28 项。
DSH_NATIVE_REAL_BIN=/absolute/path/to/dsh npx vitest run tests/server/dsh-plugin-inventory.test.ts
```

真实安装实验使用临时本地 registry、临时 DSH Home 和一个带故意失败 postinstall 的测试包，验证脚本未执行、包安装成功，以及启用后的模块确实进入 ACP 进程。它不调用付费模型、不发布 npm 包，也不改用户原生配置。
