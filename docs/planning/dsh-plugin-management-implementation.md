# DSH 插件清单与附加包管理：当前实现

> Current implementation update: the standalone Studio ACP package store and
> revision/rollback API described below have been removed before release. The
> plugin page now has Configuration / List tabs, reads native Web packages,
> mounts native plugin configuration slots in an owned DSH Web runtime.
> Plugin-specific Studio forms and API adapters have been removed. See
> [current behavior](../dsh-management.md). Earlier sections are historical design.

本页记录当前代码，不替代完整的 [Profiles / Plugins 规划](dsh-profiles-and-plugins.md)。

## 原生插件清单

入口为 Agent 管理 → DSH → 插件管理，优先显示原生预设插件。页面与 Hermes 插件管理共用统计卡片、筛选栏、表格样式和拼图入口图标。

- 从当前 DSH 命令对应的安装包解析 `@deepseek-ai/dsh-agent-presets`，不从 Studio 新建的软件包目录推断原生插件数量。
- 按上游的内置根优先规则读取安装包 `presets/` 和 DSH Home 的 `.agent-presets/`，支持嵌套 group、用户元数据、搜索、预设切换和损坏预设提示。
- 已在本机 `dsh-agent-presets@0.1.5-rc.2` 核对：`standard` 为 28 项，`minimal` 为 6 项，`ptc` 和 `cordis` 各为 29 项。插件条目数不等于 npm 包数；同一模块可用不同配置注册多项。
- YAML 作为数据解析，不执行 `!!js`。条件表达式显示“按条件启用”，运行状态为 `null`，不伪造 active。
- 这是内置和用户预设的配置发现，不是 Web 进程的实时 `pluginInventory.list()`：尚未解析部署自定义 roots / overlays，不包含完整 Host Loader 清单，清单选择不代表该预设正在当前会话运行。实际 ACP 会话按下面的 Web 来源规则挂载预设；清单目前只读。

## Web 配置用于 ACP 运行

Studio 的 DSH 单聊、群聊和工作流统一读取原生 `web` Profile，生成私有的 `studio-web-<generation>` 启动 Profile，通过 ACP 通信。来源为显式 `DSH_HOME`，否则为 Coding Agent 全局 Home 下的 `.dsh`。未初始化的原生 Web Profile 使用官方 base + web 模板；准备过程不会初始化或改写原生来源。

- 保留原生 Web bundle 的声明顺序、已安装依赖和 Profile/Home patch。私有 Profile 中的依赖链接指向原生安装目录，第三方 bundle 的相对模块保留来源锚点；缺依赖直接报错。
- 排除官方 Web 的服务器、启动器、UI 和浏览器传输行，保留后端服务；加入原生 ACP 启动器及版本受控的 Studio ACP 适配入口。不会启动或停止用户已有的 Web 服务。
- ACP 新建 Agent 时，在官方工厂的 `setup` 中挂载 Web 默认预设。等待 settings 服务初始化后再解析默认值，避免抢先使用 `standard`。恢复时使用会话保存的预设；旧的基础 ACP 历史没有预设字段时采用当前默认值。
- 来源自定义 preset roots、内置根和用户 `.agent-presets` 按原生顺序提供给预设服务。子 Agent 使用原生 `composeFrom` 继承组合。清单页面的选择器仍仅用于预览；运行默认值由 Web 设置决定。
- scoped 模式固定 Studio 模型和子 Agent 默认路由，并关闭 Web 的子 Agent 自选模型覆盖；global 模式读取 Web 的默认模型。运行设置、提示和会话文件仍位于 Studio 私有目录。
- DSH 启动环境使用完整工具链 PATH，包含能被平台发现的 pnpm；这不等于自动安装 pnpm。模型收到原生 Web 安装来源说明，执行 `dsh plugin` 时应显式设置来源 `DSH_HOME` 并指定 `--profile web`，避免装入会话运行目录。
- 按用户要求，DSH 运行使用 `danger-full-access` 和 `never` 审批策略；适配器在新建及恢复后通过原生 session 事件写入权限，覆盖旧会话保存的受限状态。不改变其他 Agent 的权限。

适配器位于 `services/dsh/acp-adapter.ts`，只支持 ACP 包 `0.1.5-rc.1` / `0.1.5-rc.2` 的已核对发布产物（两者 SHA-256 相同）。它将受控修改写入 Studio 私有文件，不修改已安装包；每个修改点检查匹配次数，未知版本或内容拒绝启动 Web 适配。升级必须复核源码接缝并运行真实 ACP 测试。发布包的 MIT 许可随生成文件保留。

DSH 的源发现、包操作、Web 组合、ACP 生命周期和事件转换均在 `coding-agents/services/dsh/` 内。公共 registry/运行管理器只做参数及通用回调接线。`scripts/dsh-module-harness.mjs` 随 `npm run harness:check` 检查权限、组合和 ACP 实例化逻辑不能外溢。

仍未交付：浏览器插件界面与前后端交互、实时 Web inventory、原生插件安装管理界面、多轮常驻进程，以及原生依赖的完整不可变快照。源包仍由原生 Web 的包管理器拥有，升级后需重新准备运行环境；不保证在源包被原地修改时继续运行旧依赖。每轮结束仍关闭 ACP，下轮恢复历史，进程内动态插件状态不跨进程保留。原生预设的实际挂载不代表任意第三方 Web 插件都已通过兼容验证。

## 附加 ACP 包

首屏清单下面的折叠区域管理 Studio 自己安装的软件包。

- 安装 / 更新必须指定 registry 包精确版本，使用官方 `dsh plugin`，固定 pnpm 10.33.0 并禁用安装脚本。新 bundle 默认禁用，普通依赖没有插件启用开关。
- 支持卸载、bundle 启停、附加 YAML patch 编辑、异步操作记录和保留版本回滚。声明 Web browser component 的 bundle 不能启用。
- 每次包变更在新的 Studio Home 中安装依赖，检查实际安装版本后才发布状态指针；CLI 退出成功但没有完成变更也判为失败。
- 所有写入位于 `<Studio Home>/coding-agents/dsh/plugins`，不修改原生 DSH Home。修改按 `If-Match` 防止覆盖冲突；幂等键避免网络重试重复执行。
- 全局和 scoped ACP 启动均加入已启用的 bundle patches 与附加配置，然后应用 Studio 自己的启动覆盖。配置修改在下一次 DSH 启动时生效；旧版本路径保留。
- bundle 兼容性始终标为未验证。当前真实安装实验覆盖相对模块路径的 bundle；没有证明任意第三方 bundle、裸模块解析、浏览器注入或全部 Web 能力兼容。
- 尚未实现旧版本自动清理、原生预设编辑、持久 ACP runtime 或实时 Fiber 状态。不能把本次提交记为 T04–T11 整体完成。

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
# 验证真实 Web 后端复用、预设继承、scoped/global 模型和新建/恢复时的无沙盒访问。
DSH_WEB_REAL=1 DSH_WEB_COMMAND=/absolute/path/to/dsh npx vitest run tests/server/dsh-web-real.test.ts
# 验证实际路由通过 PATH 找到当前 CLI，再读取 standard 的 28 项。
DSH_NATIVE_REAL=1 npx vitest run tests/server/dsh-native-discovery-real.test.ts
# 对已安装的 rc.2 原生清单核对 standard 的 28 项。
DSH_NATIVE_REAL_BIN=/absolute/path/to/dsh npx vitest run tests/server/dsh-plugin-inventory.test.ts
```

真实安装实验使用临时本地 registry、临时 DSH Home 和一个带故意失败 postinstall 的测试包，验证脚本未执行、包安装成功，以及启用后的模块确实进入 ACP 进程。它不调用付费模型、不发布 npm 包，也不改用户原生配置。
