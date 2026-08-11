# Ekko Agent 框架无关的交互式 UI 系统

## 状态

本文档是实现规划，不表示当前 Ekko Agent 已经提供交互式 UI 工具。

## 背景

Ekko Agent 目前可以调用普通工具和请求危险操作审批，但不能在一次运行中创建丰富的
用户交互界面并等待结构化结果。普通澄清问题只能覆盖单个文本回答，无法表达表单、
选择器、表格、画布、拖拽编辑器或多步骤配置器。

目标不是增加一个固定的 `ask_user` 工具，而是让 Agent 能够使用一套受控协议组合出
交互界面。Ekko 提供内置组件、行为和样式；Agent 只描述界面和提交结果，不编写或执行
任意浏览器代码。

Ekko Agent 未来可能被 Web、桌面、移动端、终端或其他服务引用，因此 UI 协议、Agent
工具和具体渲染技术必须分离。

## 核心决定

### JSON 是标准协议

Agent、Ekko Runtime 和 Host 之间只交换可验证的 JSON。HTML 不是标准传输格式。

官方 Web renderer 使用原生 DOM API 和内置样式，将通过校验的 JSON 物化为 HTML。
非 Web Host 可以把相同 JSON 映射到自己的原生控件，或者只显示 `fallbackText`。

### 核心不依赖 UI 框架

Ekko 的 UI 协议、校验、状态和 Host interface 不依赖 Vue、React、Svelte、Naive UI
或浏览器 DOM。官方浏览器 renderer 也只使用原生 DOM、Shadow DOM、Canvas 2D 和 CSS
Custom Properties。

Hermes Studio 可以使用一个很薄的 Vue mount wrapper，但 Vue 不能进入 Ekko 的 UI
协议或 renderer。

### Agent 不发送任意代码

Agent 不能发送：

- 原始 HTML 或 `innerHTML`。
- JavaScript、表达式代码或 `eval` 内容。
- `<script>`、`<iframe>`、`<object>`、`<embed>` 等可执行或嵌入元素。
- `onclick`、`onload` 等事件属性。
- 任意 CSS 文本。
- `javascript:` URL 或未经 Host 解析的本地文件路径。

所有组件、属性、事件、动作、样式字段和资源引用都必须存在于当前 Host 公布的
capability catalog 中。

### Catalog 可扩展

Ekko 提供一组标准组件，但不假设所有 Host 都能渲染所有组件。Host 可以公布标准组件的
子集，也可以注册带命名空间的自定义组件。Agent 必须以当前运行的 catalog 为准。

## 分层结构

```text
Agent model
  -> ui_catalog / ui_present / ui_update / ui_close
  -> Ekko UI protocol + validation
  -> EkkoUIHost
  -> Host transport and persistence
  -> Renderer
  -> User action
  -> EkkoUIHost
  -> tool result
  -> Agent model continues
```

建议同一个发布包提供彼此隔离的子路径：

| 导入路径 | 职责 | 环境 |
| --- | --- | --- |
| `ekko-agent` | 模型、Agent Runtime 和普通工具 | Node.js |
| `ekko-agent/ui` | UI 协议、catalog、校验、动作和 Host 类型 | 任意 JavaScript 环境 |
| `ekko-agent/ui/dom` | 官方原生 DOM renderer | 浏览器 |
| `ekko-agent/ui/styles.css` | 官方基础样式 | 浏览器 |

浏览器子路径必须独立构建。导入 `ekko-agent/ui` 不能加载 Node 内置模块或 DOM
实现，导入 `ekko-agent` 也不能自动加载浏览器 renderer。

目标目录：

```text
packages/ekko-agent/src/ui/
  protocol.ts
  catalog.ts
  validation.ts
  expressions.ts
  actions.ts
  limits.ts
  host.ts
  errors.ts
  index.ts
  dom/
    renderer.ts
    registry.ts
    theme.ts
    components/
      layout.ts
      content.ts
      form.ts
      data.ts
      overlay.ts
    canvas/
      renderer.ts
      scene.ts
      tools.ts
      hit-testing.ts
      serialization.ts
    styles.css

packages/ekko-agent/src/tools/
  ui.ts
```

## 协议

协议从 `ekko-ui/v1` 开始。所有公开值都必须是 JSON 可序列化值。

```ts
type EkkoUIJSONValue =
  | null
  | boolean
  | number
  | string
  | EkkoUIJSONValue[]
  | { [key: string]: EkkoUIJSONValue }

interface EkkoUISpec {
  protocol: 'ekko-ui/v1'
  surfaceId?: string
  revision?: number
  title?: string
  fallbackText: string
  state?: Record<string, EkkoUIJSONValue>
  root: EkkoUINode
  submitSchema?: Record<string, EkkoUIJSONValue>
}

interface EkkoUINode {
  id: string
  type: string
  props?: Record<string, EkkoUIJSONValue>
  style?: EkkoUIStyle
  bind?: string
  visibleWhen?: EkkoUIExpression
  events?: Record<string, EkkoUIAction | EkkoUIAction[]>
  children?: EkkoUINode[]
}
```

每个节点必须有稳定且在当前 Surface 内唯一的 `id`。Host 不能依赖数组下标识别节点。

`fallbackText` 是必填字段。Host 不支持交互式 UI、客户端能力不足、Surface 已过期或
导出会话时，都可以使用它表达界面的目的。

## Component Catalog

每个组件由可序列化定义描述：

```ts
interface EkkoUIComponentDefinition {
  type: string
  category: 'layout' | 'content' | 'input' | 'action' | 'data' | 'overlay' | 'visual'
  description: string
  propsSchema: Record<string, EkkoUIJSONValue>
  events: string[]
  acceptsChildren: boolean
  bindValueType?: string
}
```

第一批标准组件：

### 布局

- `box`
- `stack`
- `row`
- `grid`
- `scroll`
- `card`
- `divider`
- `spacer`

### 内容

- `text`
- `heading`
- `code`
- `image`
- `icon`
- `badge`
- `alert`

`markdown` 可以作为可选 capability 提供。实现必须清理输出，不能通过 Markdown
绕过原始 HTML 限制。

### 输入

- `form`
- `field`
- `input`
- `textarea`
- `number`
- `select`
- `radio`
- `checkbox`
- `switch`
- `range`
- `date`
- `time`
- `color`

第一版不提供 `password`。Agent 不应请求或接收密码、访问令牌或其他认证秘密。

文件选择由 Host 能力控制，结果只能返回 Host asset id 和安全元数据，不能向 Agent
暴露客户端绝对路径或未经限制的文件内容。

### 操作与容器

- `button`
- `button-group`
- `tabs`
- `accordion`
- `dialog`

### 数据与可视化

- `list`
- `table`
- `tree`
- `progress`
- `chart`
- `canvas`

Host 自定义组件必须使用命名空间，例如 `company.product-picker`，避免与未来的标准组件
冲突。

## Capability Negotiation

Ekko 不能假设当前 Host 支持官方完整 catalog。

```ts
interface EkkoUICapabilities {
  protocolVersions: string[]
  components: EkkoUIComponentDefinition[]
  limits: EkkoUILimits
  features: {
    blocking: boolean
    persistent: boolean
    updates: boolean
    canvas: boolean
    uploads: boolean
  }
}
```

`ui_catalog` 按名称、分类或关键词查询当前 Host 的 capabilities。完整 catalog 不进入
每一轮 system prompt，避免组件增多后持续占用模型上下文。

Agent 使用不存在的组件、属性或事件时，校验器返回带 JSON path、错误码和允许值的
可修复错误。它不能静默删除未知字段后继续显示一个含义不同的界面。

## 状态、绑定和表达式

Surface 状态属于 Host，不属于模型消息。输入组件通过 `bind` 绑定状态路径：

```json
{
  "id": "profile-name",
  "type": "input",
  "bind": "profile.name",
  "props": {
    "label": "Name",
    "required": true
  }
}
```

表达式不是 JavaScript 字符串，而是有限 AST：

```ts
type EkkoUIExpression =
  | { kind: 'literal'; value: EkkoUIJSONValue }
  | { kind: 'state'; path: string }
  | { kind: 'event'; path: string }
  | { kind: 'equals'; left: EkkoUIExpression; right: EkkoUIExpression }
  | { kind: 'not'; value: EkkoUIExpression }
  | { kind: 'and'; values: EkkoUIExpression[] }
  | { kind: 'or'; values: EkkoUIExpression[] }
```

第一版不实现算术语言、字符串代码、函数调用或通用模板语言。新操作必须作为版本化的
AST 节点加入。

所有状态路径必须拒绝 `__proto__`、`prototype`、`constructor` 和其他可能修改对象
原型的片段。

## 本地动作

高频交互必须在 renderer 本地执行，不能让每次输入和指针移动都触发模型调用。

```ts
type EkkoUIAction =
  | { type: 'state.set'; path: string; value: EkkoUIExpression }
  | { type: 'state.merge'; path: string; value: EkkoUIExpression }
  | { type: 'state.toggle'; path: string }
  | { type: 'array.append'; path: string; value: EkkoUIExpression }
  | { type: 'array.remove'; path: string; index: EkkoUIExpression }
  | { type: 'tabs.open'; nodeId: string; value: string }
  | { type: 'dialog.open'; nodeId: string }
  | { type: 'dialog.close'; nodeId: string }
  | { type: 'surface.submit'; actionId: string; payload: EkkoUIExpression }
  | { type: 'surface.cancel'; actionId: string }
  | { type: 'surface.close' }
```

只有 `surface.submit`、`surface.cancel` 和后续显式增加的 Agent boundary action 会
到达 Host 和 Agent。其他动作只修改客户端状态。

## 样式与主题

Agent 不发送 CSS。协议提供受控的布局和视觉字段：

```ts
interface EkkoUIStyle {
  display?: 'block' | 'flex' | 'grid' | 'none'
  direction?: 'row' | 'column'
  columns?: number
  gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  width?: 'auto' | 'full'
  align?: 'start' | 'center' | 'end' | 'stretch'
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger'
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'full'
}
```

实现过程中可以增加安全字段，但不能暴露任意 CSS property/value 通道。

官方 DOM renderer 通过 CSS Custom Properties 接收 Host 主题：

```css
:host {
  --ekko-color-primary: #6366f1;
  --ekko-color-surface: #ffffff;
  --ekko-color-text: #111827;
  --ekko-space-md: 12px;
  --ekko-radius-md: 8px;
}
```

默认使用 Shadow DOM 隔离样式。Renderer API 可以允许 Host 明确关闭 Shadow DOM，
但组件不能依赖 Host 全局 CSS。

## Canvas

`canvas` 是标准组件，不是任意绘图脚本入口。

```ts
type EkkoCanvasObject =
  | EkkoCanvasRect
  | EkkoCanvasEllipse
  | EkkoCanvasLine
  | EkkoCanvasPath
  | EkkoCanvasText
  | EkkoCanvasImage
  | EkkoCanvasGroup

interface EkkoCanvasDocument {
  version: 1
  width: number
  height: number
  objects: EkkoCanvasObject[]
}
```

标准工具可以包括：

- `select`
- `pan`
- `zoom`
- `pen`
- `line`
- `rect`
- `ellipse`
- `text`
- `erase`

官方 renderer 使用 Canvas 2D 实现 scene graph、hit testing、选择、拖拽、缩放和序列化。
指针移动和绘图过程只更新本地状态。完成一次操作或用户点击确认时，才提交完整文档或
受控 patch。

图片对象只能引用 Host 已解析的资源 id。Renderer 通过 Host 提供的 resource resolver
取得安全 URL，Agent 不能直接读取文件系统路径。

## Surface 更新

Surface 使用单调递增的 revision 和乐观并发控制。Agent 更新旧 revision 时必须失败并
重新检查当前状态。

更新操作按稳定 node id 工作，不依赖可变化的 children 数组下标：

```ts
type EkkoUIPatch =
  | { op: 'set-props'; nodeId: string; props: Record<string, EkkoUIJSONValue> }
  | { op: 'set-style'; nodeId: string; style: EkkoUIStyle }
  | { op: 'replace-node'; nodeId: string; node: EkkoUINode }
  | { op: 'insert-child'; parentId: string; afterId?: string; node: EkkoUINode }
  | { op: 'remove-node'; nodeId: string }
  | { op: 'set-state'; path: string; value: EkkoUIJSONValue }

interface EkkoUIUpdate {
  surfaceId: string
  baseRevision: number
  patches: EkkoUIPatch[]
}
```

每次 patch 后重新校验受影响节点、节点 id 唯一性、状态大小和最终文档限制。

## Host Interface

Ekko Runtime 只依赖以下抽象：

```ts
interface EkkoUIHost {
  capabilities(context: EkkoUIContext): Promise<EkkoUICapabilities>

  present(
    request: EkkoUIPresentRequest,
    context: EkkoUIContext,
  ): Promise<EkkoUISubmission>

  update(
    request: EkkoUIUpdateRequest,
    context: EkkoUIContext,
  ): Promise<EkkoUISubmission>

  inspect(
    request: EkkoUIInspectRequest,
    context: EkkoUIContext,
  ): Promise<EkkoUIInspection>

  close(
    request: EkkoUICloseRequest,
    context: EkkoUIContext,
  ): Promise<void>
}
```

`AgentToolContext` 增加可选的 `uiHost?: EkkoUIHost`。默认工具注册表使用动态
`AgentToolProvider`：只有当前运行提供 `uiHost` 时，才向模型暴露 UI 工具。

Host 负责：

- surface id、revision 和幂等性。
- 用户身份、session、profile 和 group room 权限。
- 传输、持久化、超时、abort 和断线。
- capability catalog 和扩展组件。
- submit payload 的服务端复验。
- 资源引用和上传策略。

Ekko Core 不负责 Socket.IO、HTTP、数据库或具体 renderer。

## Agent 工具

第一版提供：

- `ui_catalog`：查询 Host 支持的组件、字段、事件、限制和示例。
- `ui_present`：创建 Surface，展示并等待一个 terminal action。
- `ui_update`：按 `surfaceId + baseRevision` 更新并继续等待。
- `ui_inspect`：读取当前 Surface 的精简结构、状态或指定节点。
- `ui_close`：关闭不再需要的 Surface。

第一版 `ui_present` 使用 blocking 模式。等待用户期间没有正在进行的模型请求，只保留
一个可 abort 的 Host Promise。后台 subagent、skill review 和其他 detached run 默认
不能创建 blocking Surface。

后续可以增加 persistent 模式。Persistent Surface 不长期占用一个 run；用户稍后提交时，
Host 启动一个带 Surface 结果的 continuation turn。

## 生命周期

```text
created
  -> presented
  -> updated -> presented
  -> submitted
  -> cancelled
  -> expired
  -> closed
```

`submitted`、`cancelled`、`expired` 和 `closed` 是 terminal 状态。重复 terminal action
必须幂等返回原结果或明确拒绝，不能再次恢复 Agent。

返回 Agent 的结果：

```ts
interface EkkoUISubmission {
  status: 'submitted' | 'cancelled' | 'expired' | 'closed'
  surfaceId: string
  revision: number
  actionId?: string
  payload?: EkkoUIJSONValue
}
```

用户提交的 payload 仍是不可信输入。Host 必须使用 Surface 的 `submitSchema` 复验，
Ekko 工具还要限制返回模型的大小和深度。

## 原生 DOM Renderer

官方 renderer 提供最小 API：

```ts
interface EkkoDOMSurfaceController {
  update(spec: EkkoUISpec): void
  getState(): Record<string, EkkoUIJSONValue>
  destroy(): void
}

function mountEkkoUI(
  container: HTMLElement,
  options: {
    spec: EkkoUISpec
    theme?: EkkoUITheme
    useShadowDOM?: boolean
    resolveResource?: EkkoUIResourceResolver
    onAction: (event: EkkoUIClientAction) => void
  },
): EkkoDOMSurfaceController
```

实现使用 `document.createElement`、`textContent`、`addEventListener`、
`DocumentFragment` 和 `AbortController` 清理事件。默认不使用自定义元素全局注册表，
避免同一页面加载多个 Ekko 版本时发生 custom element 名称冲突。

所有 URL、图片和链接都经过 resource resolver 和 scheme allowlist。Renderer 不发送
网络请求，除非 Host 明确为某类资源提供了已授权的解析结果。

## Hermes Studio Adapter

Hermes Studio 需要实现 `EkkoUIHost`，但这些代码不进入 Ekko Core。

建议文件：

```text
packages/server/src/services/ekko-agent/ui-surfaces.ts
packages/server/src/db/hermes/ekko-ui-surfaces.ts
packages/client/src/lib/ekko-ui-host.ts
packages/client/src/components/hermes/chat/EkkoUISurface.vue
```

Vue 组件只负责提供 mount 容器、调用 `mountEkkoUI()` 和转发 action，不实现组件树。

Socket 事件：

- Server -> Client：`ui.surface.presented`
- Server -> Client：`ui.surface.updated`
- Server -> Client：`ui.surface.closed`
- Client -> Server：`ui.surface.action`

每个 action 必须携带：

```ts
interface EkkoUIClientAction {
  sessionId: string
  surfaceId: string
  revision: number
  actionId: string
  payload?: EkkoUIJSONValue
}
```

Server 必须验证当前 socket user 能访问 profile/session，Surface 属于该 session，
revision 仍然有效，并且 action id 是当前 spec 允许的 terminal action。

现有 `clarify.requested/respond` 继续服务于 Hermes Agent 的简单字符串澄清，不扩展成
Ekko UI 协议。危险工具审批也保持独立，不能伪装成普通 Surface action。

## 持久化

Surface 是 Host 会话 UI 状态，不是 Ekko 长期记忆。Hermes Studio 应将它存入 Web UI
数据库，而不是 `.ekko/ekko.db`。

建议表：

```text
ekko_ui_surfaces
  id
  session_id
  profile_id
  user_id
  run_id
  revision
  spec_json
  state_json
  result_json
  status
  created_at
  updated_at
  submitted_at
```

聊天消息只保存 Surface 引用和 fallback text，用于确定时间线位置：

```json
{
  "type": "ekko_ui_surface",
  "surface_id": "surface-123",
  "revision": 1
}
```

完整 spec 不复制到普通聊天历史。模型历史只保留工具调用的精简 receipt：

```json
{
  "surfaceId": "surface-123",
  "revision": 1,
  "title": "Profile editor",
  "digest": "sha256:..."
}
```

大型表格和 Canvas 不能永久保留在 provider message history 中。Ekko Runtime 需要为 UI
工具增加历史压缩策略：工具执行后，用 receipt 替换后续模型请求中的大参数；Agent 需要
细节时调用 `ui_inspect`。

## 限制

Host capabilities 至少公布并强制执行：

```ts
interface EkkoUILimits {
  maxSpecBytes: number
  maxStateBytes: number
  maxSubmissionBytes: number
  maxNodes: number
  maxDepth: number
  maxChildrenPerNode: number
  maxOptionsPerInput: number
  maxCanvasObjects: number
  maxPatchOperations: number
  maxBlockingMs: number
}
```

限制必须同时在 Agent 工具、Server 和 renderer 边界执行。客户端限制只用于用户体验，
不能代替服务端校验。

## 安全要求

- 未知组件、属性、样式、事件和动作一律拒绝。
- 所有文本默认使用 `textContent`。
- 禁止原始 HTML 和可执行 URL。
- 状态路径防止 prototype pollution。
- 表达式和动作必须限制深度、节点数和执行步数。
- Surface、state、patch、submit 和 Canvas 文档都限制字节数。
- 文件和图片使用 Host resource id，不接受任意本地路径。
- 不提供 password/secret 输入组件。
- 用户提交重新执行 schema 校验。
- session、profile、user、surface 和 revision 都在服务端关联验证。
- background subagent 默认不能创建需要用户等待的 Surface。
- 导出和无 UI Host 必须始终有安全的 fallback text。

## 测试

### 协议和校验

- 每个内置组件的有效与无效 props。
- 未知组件、属性、事件和动作。
- 重复 node id 和无效 bind path。
- 原型污染路径。
- 节点、深度、字节和 Canvas object 限制。
- expression/action 确定性。
- patch revision 和节点引用。

### Agent 工具

- 没有 `uiHost` 时不暴露工具。
- capability catalog 查询。
- present -> submit -> 同一 run 继续。
- cancel、timeout 和 abort。
- Host 失败时返回可理解的工具错误。
- 后台和嵌套 Agent 限制。
- 大型工具参数压缩成 receipt。

### DOM Renderer

- 所有 catalog 组件都有 renderer，不能出现定义和实现漂移。
- state binding 和本地 action。
- terminal action 只发送一次。
- Shadow DOM 和主题 token。
- keyboard、label、focus 和基础 accessibility。
- destroy 后不保留事件监听器。
- URL 和资源策略。

### Hermes Studio

- Socket action 的 session/user/profile 所有权。
- 旧 revision、重复提交和跨 session 提交。
- 刷新与 resume 后重新显示 pending Surface。
- abort 和 server shutdown。
- Surface 时间线锚点和历史加载。
- 表单提交后 Ekko run 继续。
- Canvas 操作在本地执行，只提交最终文档或 patch。

## 实施阶段

### 第一阶段：协议核心

- 增加 `ekko-agent/ui` browser-safe 子路径。
- 完成协议类型、catalog、校验、表达式、动作和 limits。
- 完成 headless 单元测试。
- 不接 Server 和 Client。

验收：任何 JavaScript Host 可以构造和验证一个包含 input、select、radio 和 button 的
Surface，不加载 DOM 或 Node 特有模块。

### 第二阶段：Agent 工具和 Host

- 增加 `EkkoUIHost`。
- 动态注册 `ui_catalog/ui_present/ui_update/ui_inspect/ui_close`。
- 使用 fake Host 覆盖 submit、cancel、timeout、abort 和 revision。
- system prompt 只加入按需查询 catalog 的短说明。

验收：Fake Host 中用户提交结构化结果后，同一个 Agent run 能继续模型循环。

### 第三阶段：原生 DOM Renderer

- 实现布局、内容、表单、按钮、tabs/dialog 和内置主题。
- 实现本地 state/action reducer。
- 独立构建 `ekko-agent/ui/dom` 和 CSS。
- 增加 jsdom renderer 测试。

验收：纯 HTML 项目不使用任何 UI 框架即可 mount、update、submit 和 destroy Surface。

### 第四阶段：Hermes Studio 闭环

- 实现 Server broker、数据库、Socket 事件和权限检查。
- 实现 Vue mount wrapper 和聊天时间线锚点。
- 支持刷新恢复 pending Surface。
- 增加 Server 和浏览器 E2E 测试。

验收：Ekko 在单人聊天中生成表单，用户提交后，同一 run 继续并给出最终回答。

### 第五阶段：Canvas

- 实现 Canvas document、scene graph 和 renderer。
- 实现 select、pan、zoom、pen、shape、text、erase。
- 实现 hit testing、序列化、patch 和资源解析。
- 限制高频事件在客户端本地处理。

验收：Agent 能生成一块可编辑画布，用户完成操作后只提交结构化文档或 patch。

### 第六阶段：长期 Surface 和扩展

- Persistent Surface 和 continuation turn。
- Host 自定义组件及 capability negotiation。
- Group Chat 响应者和协作策略。
- 多次提交和事件审计。
- npm 构建产物、条件 exports 和跨框架集成示例。

## 第一版明确不做

- Agent 生成或运行任意 HTML、CSS、JavaScript。
- Agent 自定义浏览器网络请求。
- 密码和 access token 收集。
- background subagent 主动弹出 UI。
- 多用户同时编辑同一个 Surface。
- 任意第三方组件在运行时下载和执行。
- Server 将 Agent 内容拼接为不受控 HTML。

这些限制不妨碍以后扩展，但避免第一版把协议、权限和执行环境混成一个无法安全复用的
浏览器沙箱。
