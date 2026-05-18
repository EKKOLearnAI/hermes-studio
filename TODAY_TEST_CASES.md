# 今日改动测试用例

日期：2026-05-18

## 基础检查

### TC-001 类型检查

步骤：
1. 在项目根目录执行 `npx tsc --noEmit -p packages/server/tsconfig.json`。
2. 执行 `npx vue-tsc -b --noEmit`。

期望：
- 两个命令都通过。
- 没有新增 TypeScript 编译错误。

### TC-002 启动服务

步骤：
1. 启动本地开发服务。
2. 打开 `http://localhost:5173`。
3. 观察控制台和服务端日志。

期望：
- Vite 和 server 正常启动。
- 不出现 `ECONNREFUSED 127.0.0.1:8648` 之外的持续异常。
- 页面可以正常进入 Hermes。

## Profile 与模型

### TC-010 available-models 返回多 profile 合集

步骤：
1. 准备至少两个 profile，每个 profile 配置不同 provider/model。
2. 请求 `GET /api/hermes/available-models`。
3. 检查返回模型列表。

期望：
- 返回所有有效 profile 的 provider/model 合集。
- 需要远程拉模型的 provider 按 base URL 去重请求。
- 默认模型优先使用当前 active profile 的默认配置。

### TC-011 新建对话选择 profile 和模型

步骤：
1. 点击新建对话。
2. 在弹窗选择 profile、provider、model。
3. 发送第一条消息。

期望：
- 新建时会把选择的 profile/provider/model 带到后端。
- 不依赖前端长期 state 存储 provider/model。
- 聊天使用选择的 profile 启动。

### TC-012 Sidebar 模型切换

步骤：
1. 在 sidebar 切换当前会话模型。
2. 等待接口返回。
3. 刷新页面或重新打开会话。

期望：
- UI 不会自动跳回旧模型。
- 当前会话继续显示新模型。
- 后续请求使用新模型。

## 单聊 Bridge 与上下文压缩

### TC-020 多 profile bridge worker

步骤：
1. 使用 default profile 发起一次聊天。
2. 切换到另一个 profile 发起聊天。
3. 查看 bridge 日志。

期望：
- 不会因为切换 profile 杀掉其他 profile 的 worker。
- `chat`、`destroy` 日志中的 profile、profile_dir、config 路径匹配实际会话 profile。

### TC-021 强制上下文压缩使用会话模型

步骤：
1. 创建一个非 default profile 的会话。
2. 设置不同 provider/model/context_length。
3. 触发上下文压缩。
4. 查看日志和压缩请求。

期望：
- context_length 依据当前 session 的 profile/provider/model 获取。
- 获取顺序为 sqlite 会话信息、profile 配置、硬编码 fallback。
- 压缩请求通过 `source=api_server` 走 bridge。
- Web UI 本地数据库不写入压缩会话记录。

### TC-022 指令压缩

步骤：
1. 在单聊中执行压缩相关指令。
2. 使用非 default profile 会话重复执行。

期望：
- 指令压缩同样使用当前 session 的 profile/provider/model。
- 不固定使用 default 模型。
- 不污染正常聊天历史。

## Session 列表与历史

### TC-030 Session 列表合并

步骤：
1. 使用多个 profile 创建会话。
2. 打开会话列表。
3. 使用 profile 过滤下拉。

期望：
- 默认显示所有有效 profile 下的会话。
- 传入 profile 过滤时只显示该 profile 会话。
- 已删除 profile 的旧会话被过滤，不再进入后报错。

### TC-031 Chat 列表 profile 信息

步骤：
1. 打开普通聊天会话列表。
2. 查看每条 session item。

期望：
- 普通 chat session item 显示 profile 头像和 profile 名称。
- profile 信息位于模型和日期下方。
- history 页面不显示 profile 信息。

### TC-032 History profile 过滤

步骤：
1. 打开历史页面。
2. 查看顶部说明和 profile 下拉。
3. 切换 “只显示当前 profile”。

期望：
- 原描述文案被替换为 profile 过滤控件。
- “All Profiles” 已国际化。
- history 列表按过滤条件变化。

## 删除会话

### TC-040 单个删除同步 Hermes

步骤：
1. 创建一个 Hermes 侧存在的会话。
2. 在 Web UI session 列表删除单条会话。
3. 查看本地 DB 和 Hermes profile 侧数据。

期望：
- Web UI 本地会话被删除。
- 如果 Hermes 对应 profile 下存在该 session，也同步删除。
- profile 缺失或 Hermes 侧不存在时不报错。

### TC-041 批量删除同步 Hermes

步骤：
1. 选择多个 session，覆盖不同 profile。
2. 点击批量删除。
3. 在确认弹窗确认。

期望：
- 确认弹窗显示 loading。
- 每条会话按自己的 profile 删除 Hermes 侧数据。
- 批量删除期间 UI 不重复提交。
- 部分 Hermes 删除失败时，本地删除逻辑不被无关 profile 阻塞。

## 群聊基础

### TC-050 群聊清空消息

步骤：
1. 进入群聊房间并发送几条消息。
2. 清空群聊消息。
3. 再发起一次群聊。

期望：
- 消息被清空。
- room 生成新的 sessionId/sessionSeed。
- 后续 agent run 不复用旧 session。

### TC-051 群聊并发触发

步骤：
1. 在同一条用户消息里 @ 多个 agent。
2. 观察多个 agent 回复。
3. 在某个 agent 回复未结束时再次 @ 同一个 agent。

期望：
- 不同 agent 可以并发回复。
- 同一个 agent 串行处理。
- 同一 agent 忙时新 mention 进入该 agent 的队列，最终只处理最新一条排队消息。

### TC-052 群聊 source 使用 api_server

步骤：
1. 在群聊中 @ agent。
2. 查看服务端日志和 bridge 请求。

期望：
- 群聊 agent 调用 source 为 `api_server`。
- 不再走 cli source。

## 群聊流式与消息入库

### TC-060 群聊流式输出

步骤：
1. @ 一个 agent 并观察回复过程。
2. 刷新前查看 UI。
3. 刷新后再次查看消息。

期望：
- agent 回复流式显示。
- 流式结束前不落库空 content 占位消息。
- 刷新后不会出现空 assistant 消息。
- 完成后 loading/thinking 状态消失。

### TC-061 toolcall/toolresult 展示

步骤：
1. 让 agent 执行一个工具调用。
2. 查看群聊消息气泡。
3. 展开工具详情。

期望：
- toolcall 和 toolresult 合并成一条工具消息展示。
- 工具消息显示头像和 agent 名称。
- 工具样式与单聊一致。
- 参数和结果有截断，长内容不撑破 UI。
- `hermes_show_tool_calls` 只影响群聊自身可见性，不影响单聊常显规则。

### TC-062 toolcall 顺序

步骤：
1. 让 agent 回复中先说一句话，再调用工具，再继续回复。
2. 查看 UI 和 `group-chat-history-preview.json`。

期望：
- 工具调用前的普通文本保留在 toolcall 前面。
- toolcall/toolresult 不被错误插到最终回复下面。
- 最终 agent 回复不会丢失。

### TC-063 入库原子性

步骤：
1. 同时 @ 多个 agent。
2. 等待多个 agent 回复完成。
3. 查看 `gc_messages`。

期望：
- 每个 agent 的一次回复作为完整消息落库。
- 不出现谁先完成谁把别人的消息合并进同一条的情况。
- 工具消息和最终文本消息的归属正确。

## 群聊 History 组装

### TC-070 生成预览 JSON

步骤：
1. 在群聊产生用户消息、agent 回复、toolcall、toolresult。
2. 生成 `group-chat-history-preview.json`。
3. 检查 JSON 顺序和 role。

期望：
- 当前 agent 自己的普通回复为 `assistant`。
- 当前 agent 自己的 toolcall 为 `assistant`，内容格式为 `[Calling tool: name with arguments: ...]`。
- toolresult 为 `user`。
- 其他 agent 的回复、toolcall、toolresult 都作为 `user`。
- 每条内容只带 `[发送者]:` 前缀，不生成 `[发送者 to 目标]:`。
- 预览中的 `source`、`sourceRole`、`originalMessageId` 只用于调试，不发送给 bridge。

### TC-071 @User 清理

步骤：
1. 用户或 agent 消息中包含 `@User-dfd5fd`。
2. 生成 history preview。

期望：
- 对应内容转换为 `[发送者]: 内容`。
- body 中原始 `@User-dfd5fd` 被移除。
- history preview 中不出现 `[test to User-dfd5fd]:` 这种前缀。

### TC-072 群聊 prompt 约束

步骤：
1. 只 @ 一个 agent，让它回答普通问题。
2. 不要求它转交、邀请、询问其他成员。

期望：
- agent 不会主动 @ 其他人。
- 不会在结尾要求其他 agent 接力。
- 只有明确需要对方执行动作、提供信息、确认决策时才 @。

### TC-073 群聊 token 统计

步骤：
1. 群聊中产生多轮 user/assistant/tool 消息。
2. 请求 `GET /api/hermes/group-chat/rooms`。
3. 对比房间 `totalTokens`。

期望：
- token 估算逻辑与单聊一致，按 role/input/output/tool_calls 统计。
- 不是简单拼接 content/senderName 计算。
- snapshot 场景下统计不重复。

## 群聊附件与图片

### TC-080 用户发送图片

步骤：
1. 在群聊输入框上传或粘贴图片。
2. 输入文字并发送。
3. 查看本地 UI 和 agent 收到的内容。

期望：
- 用户消息不显示原始 JSON 数组。
- 图片以缩略图展示。
- 点击图片可以预览。
- 文本只显示 text block。
- 发送给 bridge 时图片转 base64，与单聊 ContentBlock[] 处理一致。

### TC-081 用户发送文件

步骤：
1. 在群聊发送普通文件。
2. 查看消息展示。

期望：
- 文件以文件附件样式展示。
- 不被错误当作纯文本 JSON 展示。
- 下载链接可用。

### TC-082 Windows 路径兼容

步骤：
1. 构造或上传一个路径形如 `C:\path\file.jpg` 的附件记录。
2. 查看群聊消息。

期望：
- 下载 URL 中路径被标准化为 `C:/path/file.jpg`。
- 图片和文件都可以正常展示或下载。

## 群聊语音与操作栏

### TC-090 自动播放开关

步骤：
1. 打开群聊输入框的自动播放语音开关。
2. 让 agent 回复一条完整消息。

期望：
- 回复完成后触发语音播放。
- 不在流式未完成时播放半截内容。
- 设置与单聊共用 `autoPlaySpeech` 行为。

### TC-091 手动播放语音

步骤：
1. 点击群聊 assistant 消息底部语音按钮。
2. 再次点击暂停或恢复。

期望：
- 按当前 TTS provider 播放。
- WebSpeech、OpenAI、custom、edge、mimo 路径与单聊一致。
- 播放状态按钮图标变化。

### TC-092 呼吸灯和操作栏样式

步骤：
1. 播放群聊 assistant 消息语音。
2. 对比单聊消息播放态。

期望：
- 群聊气泡出现与单聊一致的呼吸灯动画。
- 群聊底部操作栏包含语音按钮、复制按钮、时间。
- 操作栏 hover 显示，移动端常显。
- 操作栏和气泡之间有合理间距，不贴边。

### TC-093 复制消息

步骤：
1. 点击群聊消息底部复制按钮。
2. 粘贴剪贴板内容。

期望：
- 复制的是当前气泡可读文本。
- ContentBlock[] 消息只复制文本部分，不复制图片 JSON。
- tool 消息不显示普通复制按钮。

## 群聊工具可见性

### TC-100 工具显示开关

步骤：
1. 在群聊输入框切换工具调用显示开关。
2. 触发一次工具调用。

期望：
- 关闭时隐藏已完成工具消息。
- 正在运行的工具消息仍可见，避免用户误以为卡住。
- 打开后工具消息恢复显示。

## 回归检查

### TC-110 单聊不受群聊改动影响

步骤：
1. 在普通单聊发送文本、图片、工具调用消息。
2. 播放语音并复制消息。
3. 触发上下文压缩。

期望：
- 单聊工具调用仍常显。
- 单聊图片展示、预览、base64 发送正常。
- 单聊语音呼吸灯和操作栏样式不变。
- 单聊压缩仍走正确 session profile/model。

### TC-111 已删除 profile 数据

步骤：
1. 创建一个 profile 并产生聊天记录。
2. 删除该 profile。
3. 打开 session 列表和历史页面。

期望：
- 不展示不属于当前全部有效 profile 的聊天记录。
- 不会因为进入旧会话请求缺失 profile 而报错。

### TC-112 多语言文案

步骤：
1. 切换到中文、英文、日文等语言。
2. 查看 profile 过滤选项。

期望：
- `All Profiles` 或对应翻译正常显示。
- 不出现缺失 i18n key。
