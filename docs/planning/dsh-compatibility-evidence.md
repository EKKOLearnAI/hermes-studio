# DSH M0 后端兼容性实验记录

日期：2026-09-12

状态：T01 / M0-A 与 T02 / M0-B 的首轮真实实验通过，仅覆盖 macOS arm64、固定的 DSH rc.1 依赖图和最小后端组合。生产接入仍待 M1/M2；浏览器 M0-C 未执行。

对应[主规划](dsh-profiles-and-plugins.md)与[实施任务](dsh-profiles-and-plugins-execution.md)。这里记录实际执行的实验，不将实验原型等同于用户可用功能。

## 1. 版本基线与复现

本机全局 CLI 自报 `0.1.5-rc.1`，但其 ACP、Agent、预设与动态插件包实际为 `0.1.5-rc.2`。本次没有将该混合安装作为 rc.1 验收依据，而是另外安装固定依赖的临时环境。

- CLI 与所有使用的 `@deepseek-ai/dsh-*` 服务包固定为 `0.1.5-rc.1`。
- ACP SDK 固定为 `1.4.0`；完整依赖和 integrity 见独立 fixture lockfile。
- 测试读取实际已安装包版本，并核对 lockfile 和 ACP 发布产物哈希。
- 模型服务只监听 `127.0.0.1`，返回确定的 Responses SSE；不调用付费模型。
- Home、工作目录、会话文件和适配模块均位于测试临时目录，不读取或写入用户来源。

复现命令见 [fixture README](../../tests/fixtures/dsh-m0/README.md)。主要测试是 [dsh-m0-real.test.ts](../../tests/server/dsh-m0-real.test.ts)，机器可读结果见 [macOS arm64 记录](evidence/dsh-m0-darwin-arm64.json)。记录包含平台、Node、包版本、输入文件哈希、组合删减项及耗时；不包含凭据或模型请求正文。

## 2. 发布 API 核对与维护决定

| 能力 | 实际发布情况 | 本次使用方式 |
| --- | --- | --- |
| ACP 插件 | 根出口只有 `apply`、`Config`、`inject`、`name` | 保留原生 ACP 协议实现，构建临时适配副本 |
| `AcpSession` | 有类型声明，但根出口不导出；发布包没有可导入的源码实现 | 不使用未发布子路径，不从声明推断可调用性 |
| Agent 创建与恢复 | `ctx.agents.create/resume` 的 `setup` 可用 | 在原生 ACP 工厂 setup 中调用预设挂载 |
| 预设 | `AgentPresets.mount/composeFrom` 已发布 | `mount` 已在创建、恢复实测；子 Agent 继承留给 T06 验收 |
| 会话 flush | `ctx.sessions.flush(session)` 可用 | 原生本轮静止且 ACP 输出排空后调用，完成后才放开本轮槽位 |
| 动态插件 | 原生 runner 的 define/run/invoke/snapshot 可用 | 测试工具创建真实 host 插件，其闭包保存计数状态 |

决定：继续采用规划中的版本固定 Studio ACP 适配器方向。当前发布接口不足以用一个普通旁挂插件完成预设绑定，需要维护 ACP 入口与会话创建/结束部分。

原型以 [acp-rc1.patch](../../tests/fixtures/dsh-m0/acp-rc1.patch)记录对发布产物的八处补丁。原始模块约 1,400 行，哈希与 MIT 许可一并保留。每次实验只在临时副本上应用补丁，不修改全局安装，也不替换运行中的方法。此做法限定为 M0 证据；生产交付前须整理可维护的源码适配模块、标准协议回归和升级流程，不能直接把实验补丁当作通用兼容层发布。

## 3. 组合差异

输入为固定版本的官方 Web patch。保留其顶层设置和 Agent 工具禁用规则；新增 host 行只保留预设注册表与动态插件 runner。Web 启动、服务器、浏览器模块、UI、Web 控制器等明确排除，逐项列表写入 JSON 记录。

以基础 ACP 组合提供通用后端服务，禁用官方 ACP 入口，另插入版本固定的实验 ACP 适配入口。测试预设包含独有工具和 Skill，使用真实预设 Loader 挂载。

这证明最小 Web 后端语义与 ACP 可以组合，尚未证明自动转换完整 Web Profile、任意第三方 bundle、路径重定位或依赖快照。因此 A01 和 M1 整体仍未验收。

## 4. 真实观察与断言

| 场景 | 已观察结果 |
| --- | --- |
| 新建时绑定预设 | 模型工具目录包含 `m0_counter`，提示中含预设 Skill 描述；实际调用原生 `skill` 后，正文进入下一次模型请求 |
| 同实例两轮 | 只 initialize 一次、只启动一个进程，PID/native session 与插件运行 ID 不变；计数为 1、2 |
| 工具执行中取消 | 等待工具报告真正开始后发送 ACP cancel，返回 cancelled；下一轮同实例返回计数 3 |
| 完成后强杀 | prompt 返回后直接 SIGKILL，未发送 session/close；新进程恢复时仍有已完成历史 |
| 恢复时绑定预设 | 恢复后再次验证工具目录、Skill 正文和工具执行 |
| 插件内存恢复边界 | 新进程恢复历史后原生插件清单为空；显式再次调用工具才创建新插件，计数从 1 开始 |
| 缺失或错误预设 | 缺失预设拒绝创建；恢复时预设与持久化元数据不一致则拒绝 |
| 不挂载预设的对照 | 相同后端组合不挂载预设时，模型请求不含该预设工具与 Skill |
| 输出和退出 | 每轮原生 ACP 最终文本仅一次；显式 session/close、EOF 后进程正常退出 |

一个实际发现：原生插件运行 ID 在重启后可能再次为 `run-1`。因此它不能单独作为跨进程事件身份；生产协议必须保留规划中的 runtime/generation，并拒绝旧代事件。

flush 实验只证明进程崩溃后的恢复。没有验证断电、磁盘故障或 fsync 语义。该测试也未证明生产 Studio 历史与原生历史之间的事务一致性。

## 5. 尚未通过的发布门槛

- M0-C：官方浏览器客户端、允许/拒绝、host/client 双端交互。
- T04–T07：来源登记、revision、路径解析、完整预设继承与选择页面。
- T08–T09：生产多轮连接、owner 互斥、generation 事件、代理寿命、flush 失败和取消超时处理。
- A13：scoped 子 Agent、压缩和辅助模型路由限制。
- Windows/Linux、官方 standard/cordis 完整组合、浏览器关闭时所有工具的可完成性。

耗时是本地 fixture 的一次观察，不是线上模型性能或容量承诺；空闲内存与多实例上限尚未测定。下一步进入 T04/T05 的来源和组合模型，同时将已证实的 setup/flush 接缝转为可维护的适配实现。

## 6. 本次验证

- 独立 fixture 的 `npm ci --ignore-scripts --no-audit --no-fund` 通过。
- 六个 DSH 测试文件合计 36 项通过，包含新的 M0 实验及原有真实 ACP 流式/跨进程恢复实验；两项真实实验均使用锁定的 rc.1。
- `npm run build` 与 `npm run harness:check` 通过。
- 本次只新增实验、依赖锁和证据文档，未改变生产或浏览器行为，未跑全量 coverage / Playwright。
