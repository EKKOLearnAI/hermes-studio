# 桌面端 Agent 内置浏览器规划

日期：2026-07-22

## 一、结论

Hermes Studio 桌面端新增一个基于 Electron <code>WebContentsView</code> 的内置浏览器。
普通浏览器打开的 Web UI、VPS 部署的 Web UI 都不提供浏览器功能。

浏览器有两条控制链路，最终都汇入 Electron 主进程中的
<code>BrowserManager</code>：

~~~text
用户手动操作：
Vue 浏览器界面
  → 可信 Preload API
  → Electron IPC
  → BrowserManager
  → WebContentsView

Agent 操作：
Ekko / Hermes / Codex / Claude Code
  → MCP（stdio）
  → 本地 Browser Broker（私有 RPC）
  → BrowserManager / BrowserAutomation
  → 同一个 WebContentsView
~~~

MCP 只是 Agent 的统一工具协议，不直接控制 Electron。真正控制浏览器的是
Electron API 和 CDP：

- 标签页、导航、前进、后退、刷新：Electron <code>webContents</code> API；
- DOM 快照、点击、输入、滚动、截图：优先复用 <code>agent-browser</code>
  连接指定页面的 CDP Target；
- DOM 元素选择和任意区域框选：
  <code>executeJavaScriptInIsolatedWorld()</code>；
- 如果 <code>agent-browser</code> 无法严格锁定指定页面，则改用
  <code>webContents.debugger</code> 直接发送 CDP 命令。

## 二、目标

- 在 Hermes Studio 桌面端提供可见的内置浏览器。
- 支持多个标签页，并保留每个标签页独立的导航状态。
- 用户与 Agent 操作同一个可见页面，而不是另外启动隐藏浏览器。
- Ekko Agent、Hermes Agent、Codex、Claude Code 共用同一套浏览器工具。
- 复用现有 <code>agent-browser@0.26.0</code> 的可访问性树、元素引用和基础操作。
- 用户可以实时看到 Agent 的点击、输入、滚动和跳转。
- 用户可以随时停止 Agent 并接管当前标签页。
- 支持点击 DOM 元素进行批注。
- 支持从任意方向拖动，框选任意矩形区域进行批注。
- 截图要作为真实图片发送给支持视觉的模型，不能只返回本地路径。
- 浏览器登录状态保存在 Hermes 自己的独立 Profile 中。
- Profile 数据目录和下载目录可以由用户配置。
- 支持创建和切换多个完全隔离的 Profile。
- 远程网页不能访问 Node、Electron IPC、本地文件和 Web UI 登录凭据。

## 三、不做的内容

- 不做完整 Chrome 替代品。
- 不直接复用用户本机 Chrome 的 Profile 目录。
- 第一版不支持 Chrome 扩展、密码导入、书签同步和浏览历史同步。
- 普通 Web UI 和 VPS Web UI 永久不提供内置浏览器功能。
- 不把 CDP 地址、Electron 对象或原始 IPC 暴露给 Agent。
- 不允许 Agent 在没有确认机制的情况下执行购买、发布、删除数据、
  上传文件、输入敏感凭据等高风险操作。
- 不向局域网或互联网提供浏览器画面流。

## 四、现状

### 4.1 Ekko Agent

<code>packages/ekko-agent/src/tools/browser.ts</code> 已经提供：

~~~text
browser_navigate
browser_snapshot
browser_click
browser_type
browser_scroll
browser_back
browser_press
browser_get_images
browser_vision
browser_console
~~~

这些工具通过安全的参数数组启动 <code>agent-browser</code> CLI。
目前 <code>browser_vision</code> 只把截图路径作为文本返回，图片内容没有真正进入
模型请求。

### 4.2 MCP

仓库已有 <code>bin/hermes-studio-mcp.mjs</code>，当前按以下 toolset
向 Ekko 和 coding agent 注入工具：

~~~text
api
devices
use
~~~

本功能新增第四个仅桌面端可用的 toolset：

~~~text
browser
~~~

### 4.3 Electron

当前桌面端只有主 <code>BrowserWindow</code> 和宠物窗口，没有
<code>WebContentsView</code>，也没有浏览器标签页、Browser Broker 或浏览器 IPC。

## 五、平台边界

内置浏览器只存在于可信 Electron 环境：

- Electron 主进程拥有标签页、<code>WebContentsView</code>、Profile、权限、
  截图、DOM 注入、CDP 和生命周期。
- <code>packages/client</code> 可以放浏览器界面，因为桌面端复用同一个 Vue
  客户端。
- 浏览器界面必须检测完整且可信的 Desktop Browser Bridge，并采用懒加载。
- 普通 Web UI 不显示入口，不允许访问路由，也不初始化相关 Store。
- 普通 Web UI Server 不注册浏览器 Koa 路由、OpenAPI、Socket.IO namespace、
  CDP Relay 或截图流。
- 环境变量、URL 参数、Local Storage 和 User-Agent 都不能开启该功能。
- 没有可信 Preload Bridge 时，直接访问桌面浏览器路由必须跳回安全页面。

浏览器界面代码可以存在于共享 Client 包中，但浏览器能力本身不存在于普通 Web
环境。

## 六、MCP 工具设计

### 6.1 为什么使用 MCP

浏览器不只给 Ekko Agent 使用，还需要提供给 Hermes Agent 和 coding agent。
MCP 是这些 Agent 都能接入的统一协议，比为每一种 Agent 单独实现一套私有接口
更合适。

MCP 不负责创建 <code>WebContentsView</code>，也不持有 Electron 权限；
它只把经过校验的语义化操作转发给 Electron Browser Broker。

### 6.2 控制工具数量

不要为每一个按钮提供一个 MCP 工具。第一版只暴露 6 个聚合工具：

~~~text
browser_tabs
  action: list | create | activate | close

browser_navigate
  action: open | back | forward | reload | stop

browser_snapshot
  返回紧凑的可访问性树和稳定元素引用

browser_interact
  action: click | type | press | scroll

browser_screenshot
  返回视口或整页截图

browser_console
  action: read | clear | evaluate-safe-expression
~~~

选择 6 个工具的原因：

- 比十几个细粒度工具更节省上下文；
- 比一个巨型万能工具更容易让模型正确调用；
- Action 枚举较小，参数校验更明确；
- 后续容易单独限制高风险操作。

所有标签页相关操作都携带 <code>tab_id</code>，结果也必须返回
<code>tab_id</code>。第一次导航没有指定标签页时，Broker 可以为调用者创建或
绑定一个标签页，但以后不能跟随用户当前激活标签页自动切换。

### 6.3 MCP 只在桌面端注入

新增托管 MCP Server：

~~~text
hermes-studio-browser
command: hermes-studio-mcp
args: [browser]
~~~

只有满足以下条件时才注入：

- 当前是 Hermes Studio Desktop；
- Electron Browser Broker 描述文件有效；
- Browser Broker 健康检查通过。

普通 Web UI、VPS 或 Broker 已失效时不提供这 6 个工具。

桌面模式下 Ekko Agent 也使用这套 MCP 工具。原有 Ekko 浏览器工具只作为
非桌面环境或桌面 Browser Broker 不可用时的独立浏览器回退方案。工具注册器
必须显式选择其中一种，不能依赖同名工具覆盖顺序。

## 七、进程通信

### 7.1 Agent 到 MCP

Agent 的 MCP Client 启动：

~~~text
hermes-studio-mcp browser
~~~

Agent 和 MCP 进程之间使用 MCP 标准的 JSON-RPC，通过子进程
<code>stdin/stdout</code> 通信。

### 7.2 MCP 到 Electron

MCP 进程不能直接调用 Electron <code>ipcMain</code>，因此 Electron 主进程需要
启动一个很小的 Browser Broker RPC Server。

通信链路：

~~~text
Agent MCP Client
  -- MCP JSON-RPC / stdio -->
hermes-studio-mcp browser
  -- 私有 JSON-RPC / 127.0.0.1 随机端口 -->
Electron Browser Broker
  --> BrowserManager / BrowserAutomation
~~~

Broker 使用 Node 内置 HTTP 即可，不需要新增网络依赖，也不需要第二条
WebSocket。浏览器操作状态通过 Electron IPC 推送给 Vue 界面。

### 7.3 Broker 安全

Browser Broker：

- 只监听 <code>127.0.0.1</code> 随机端口；
- 每次桌面程序启动时生成新的高强度 Token；
- 所有请求必须携带 Token；
- 校验固定的 RPC Method 和严格参数 Schema；
- 拒绝浏览器页面 Origin 发起的请求；
- 不支持 CORS；
- 不返回 CDP 地址；
- Electron 退出时立即关闭；
- 不经过普通 Web UI Server。

Broker 描述文件：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/broker.json
~~~

示例：

~~~json
{
  "schema": 1,
  "desktopPid": 12345,
  "endpoint": "http://127.0.0.1:49152",
  "token": "<random-per-launch-token>",
  "createdAt": "2026-07-22T00:00:00.000Z",
  "expiresAt": "2026-07-23T00:00:00.000Z"
}
~~~

要求：

- 目录权限仅当前用户可访问；
- 文件权限为 owner-only；
- 启动时清理旧文件；
- 退出时删除；
- MCP 校验 PID、地址、有效期和文件权限；
- 文件内容不进入日志、聊天记录或模型上下文；
- 这是临时发现信息，不是用户配置。

### 7.4 调用者身份与控制租约

调用者 ID 由 Hermes Studio 启动 Agent 时注入，不能作为模型参数传入：

- Ekko：run/session ID；
- Hermes：worker/run ID；
- Codex/Claude Code：coding-agent run ID。

Browser Broker 使用 <code>caller_id + tab_id</code> 管理控制租约：

- 同一标签页同一时间只能有一个 Agent 控制；
- 用户点击“接管”时先中止当前 Agent 操作；
- 另一个 Agent 需要显式申请控制权；
- 用户切换 UI 标签页不会改变 Agent 绑定的标签页。

## 八、代码文件规划

### 8.1 MCP

~~~text
bin/hermes-studio-mcp.mjs
  现有 MCP stdio 入口；识别新的 browser toolset。

bin/mcp/browser-tools.mjs
  6 个 MCP 工具 Schema、参数规范化、Broker 描述文件读取、
  Broker RPC Client 和 MCP 图片结果转换。
  这里不包含 Electron 或 CDP 权限。
~~~

### 8.2 Electron

~~~text
packages/desktop/src/main/browser/browser-manager.ts
  管理标签页、WebContentsView、Session、导航、Bounds 和状态。

packages/desktop/src/main/browser/browser-broker.ts
  启停本地 RPC、认证、参数校验、调用者身份和控制租约。

packages/desktop/src/main/browser/browser-automation.ts
  通过 agent-browser 或 webContents.debugger 执行快照、交互、截图和 Console。

packages/desktop/src/main/browser/browser-annotation.ts
  隔离世界 JS 注入、DOM 选择、区域框选和清理。

packages/desktop/src/main/browser/browser-profile-store.ts
  Profile 元数据、Session 目录、下载目录、切换和清理。

packages/desktop/src/main/browser/browser-types.ts
  标签页、Broker、租约、选择结果和浏览器状态类型。
~~~

### 8.3 Client

~~~text
packages/client/src/components/desktop-browser/
  标签栏、地址栏、控制按钮、批注编辑和错误状态。

packages/client/src/views/hermes/DesktopBrowserView.vue
  “工具 → 浏览器”独立页面；包含浏览器工作台和配置管理。

packages/client/src/components/desktop-browser/BrowserProfilesPanel.vue
  Profile、存储目录和切换管理。

packages/client/src/components/desktop-browser/BrowserDownloadsPanel.vue
  下载目录、策略、任务和进度。

packages/client/src/components/desktop-browser/BrowserPrivacyPanel.vue
  数据清理和站点权限。

packages/client/src/stores/desktop-browser.ts
  浏览器 UI 状态；只在 Desktop Bridge 存在时创建。

packages/client/src/router/
  桌面浏览器路由守卫；普通 Web UI 不能进入。
~~~

具体文件名实现时可根据现有 Client 目录结构调整，但职责边界不能改变。

## 九、BrowserManager

### 9.1 职责

- 每个标签页创建一个 <code>WebContentsView</code>；
- 把活动标签页挂载到主窗口；
- 隐藏非活动 View，但保留页面状态；
- 同步 Vue 占位区域的 Bounds；
- 管理 URL、标题、图标、加载状态、前进和后退状态；
- 管理多个 Hermes Browser Profile 和对应 Session；
- 管理权限、弹窗、下载和崩溃；
- 发现每个标签页准确的 CDP Target；
- 保存仅 Electron 内部可见的 Target Record；
- 向 Vue 和 Browser Broker 发布状态。

### 9.2 WebContentsView 安全配置

~~~ts
const browserSession = session.fromPath(profile.sessionPath)
browserSession.setDownloadPath(profile.downloadPath)

new WebContentsView({
  webPreferences: {
    session: browserSession,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  },
})
~~~

远程网页 View 不加载 Preload。所有高权限操作只能从 Hermes Studio 主 Renderer
经过可信 Preload IPC 到 Electron 主进程。

### 9.3 标签页模型

~~~ts
interface DesktopBrowserTab {
  id: string
  profileId: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: 'idle' | 'active' | 'waiting-for-user'
}
~~~

第一版最多 8 个标签页。关闭标签页时：

- 销毁对应 <code>WebContentsView</code>；
- 删除内部 Target Record；
- 中止绑定该标签页的 Agent 操作；
- 释放租约；
- 删除临时截图和未完成批注；
- 不影响其他标签页。

## 十、Web UI 与桌面端 IPC

浏览器的工具栏和标签栏在 Vue 中，网页内容是 Electron 原生
<code>WebContentsView</code>，不是 Vue DOM 子节点。

### 10.1 Typed Preload Bridge

~~~ts
interface DesktopBrowserBridge {
  open(): Promise<DesktopBrowserState>
  listProfiles(): Promise<DesktopBrowserProfile[]>
  createProfile(name: string): Promise<DesktopBrowserProfile>
  inspectProfileSwitch(profileId: string): Promise<BrowserProfileSwitchImpact>
  switchProfile(
    profileId: string,
    confirmationId?: string,
  ): Promise<DesktopBrowserState>
  renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile>
  chooseProfileDirectory(profileId: string): Promise<DesktopBrowserProfile>
  chooseDownloadDirectory(profileId: string): Promise<DesktopBrowserProfile>
  setDownloadPreferences(
    profileId: string,
    preferences: BrowserDownloadPreferences,
  ): Promise<DesktopBrowserProfile>
  listDownloads(profileId: string): Promise<DesktopBrowserDownload[]>
  openProfileDirectory(profileId: string): Promise<void>
  openDownloadDirectory(profileId: string): Promise<void>
  clearProfileData(
    profileId: string,
    dataTypes: BrowserDataType[],
  ): Promise<void>
  listSitePermissions(profileId: string): Promise<BrowserSitePermission[]>
  revokeSitePermission(profileId: string, permissionId: string): Promise<void>
  deleteProfile(profileId: string): Promise<void>
  createTab(url?: string): Promise<DesktopBrowserTab>
  activateTab(tabId: string): Promise<DesktopBrowserState>
  closeTab(tabId: string): Promise<DesktopBrowserState>
  navigate(tabId: string, url: string): Promise<DesktopBrowserTab>
  back(tabId: string): Promise<DesktopBrowserTab>
  forward(tabId: string): Promise<DesktopBrowserTab>
  reload(tabId: string): Promise<void>
  stop(tabId: string): Promise<void>
  setBounds(bounds: BrowserBounds): Promise<void>
  setVisible(visible: boolean): Promise<void>
  startAnnotation(
    tabId: string,
    mode: 'element' | 'region',
  ): Promise<BrowserSelection>
  cancelAnnotation(tabId: string): Promise<void>
  clearData(): Promise<void>
  stopAgentControl(tabId: string): Promise<void>
  onStateChanged(
    listener: (state: DesktopBrowserState) => void,
  ): () => void
}
~~~

不能暴露：

- 原始 <code>ipcRenderer</code>；
- CDP 命令；
- CDP 地址；
- Electron 对象；
- 任意 JavaScript；
- 任意文件路径读写。

Profile 和下载目录必须由 Electron 原生目录选择器选择。Renderer 只能请求打开
选择器，不能直接提交任意路径让主进程读写。

每个 <code>ipcMain</code> Handler 都必须验证 Sender 是可信 Hermes Studio
Renderer。

### 10.2 Bounds

Vue 页面提供一个布局占位容器，通过 <code>ResizeObserver</code> 把位置和大小
发送给 Electron，Electron 调用 <code>WebContentsView.setBounds()</code>。

以下情况必须隐藏原生 View：

- 浏览器页面或面板关闭；
- 主窗口隐藏或最小化；
- 显示批注截图编辑器；
- 全局 Modal 覆盖浏览器区域。

原生 View 会盖住 Vue 的 Popover 和 Modal，不能只依赖 CSS
<code>z-index</code>。

### 10.3 “工具 → 浏览器”独立页面

不放在 <code>/hermes/settings</code> 中。在现有侧边栏“工具”分组下新增：

~~~vue
<RouteLinkItem
  v-if="hasRoute('hermes.browser') && hasDesktopBrowserBridge"
  :to="{ name: 'hermes.browser' }"
>
  {{ t('sidebar.browser') }}
</RouteLinkItem>
~~~

桌面启动时，只有完整可信的 Desktop Browser Bridge 存在，才动态注册路由：

~~~ts
{
  path: '/hermes/browser',
  name: 'hermes.browser',
  component: () => import('@/views/hermes/DesktopBrowserView.vue'),
}
~~~

不要把该路由静态写入所有环境的 Router。普通 Web UI 中：

- <code>router.hasRoute('hermes.browser')</code> 为 <code>false</code>；
- “工具”分组不显示浏览器入口；
- 直接访问 <code>#/hermes/browser</code> 命中安全的 Not Found/默认跳转；
- 不加载 <code>DesktopBrowserView</code> Chunk；
- 不创建 Browser Store；
- 不调用 Profile、下载或浏览器 Bridge。

<code>DesktopBrowserView</code> 是浏览器工作台和配置中心，页面内分四个 Tab：

1. **浏览器**
   - 标签栏、地址栏和页面控制；
   - 原生 <code>WebContentsView</code> 布局占位；
   - 当前 Profile 选择；
   - Agent 操作状态、停止和接管；
   - DOM/区域批注入口。
2. **Profile**
   - Profile 列表、当前活动标记和存储占用；
   - 新建、重命名、切换和删除；
   - 显示规范化后的 Profile 目录；
   - 新建时选择默认目录或自定义目录；
   - 已有 Profile 迁移目录；
   - 打开 Profile 目录。
3. **下载**
   - 当前 Profile 下载目录；
   - 选择目录；
   - 下载前始终询问；
   - 重名处理策略；
   - 当前下载任务和进度；
   - 打开下载目录。
4. **隐私与权限**
   - 清除 Cookie；
   - 清除 Cache；
   - 清除站点数据；
   - 重置当前 Profile；
   - 重置所有 Profile。
   - 查看当前 Profile 已授权站点；
   - 单项撤销；
   - 全部撤销；
   - 第一版没有允许列表时保持默认拒绝。

切换到 Profile、下载或隐私 Tab 时隐藏原生 <code>WebContentsView</code>，
避免它盖住 Vue 管理界面。切回浏览器 Tab 后重新同步 Bounds 并显示当前活动 View。

该页面不使用普通 <code>settingsStore.saveSection()</code>，也不调用 Web UI
Server。所有数据来自 Typed Preload Bridge，并由 Electron 主进程落盘。

新建 Profile 使用 Electron 生成的 UUID，用户只输入显示名称。所有目录选择都由
主进程打开原生目录选择器，不能使用普通文本框直接编辑路径。

切换 Profile 前，界面展示 BrowserManager 返回的影响摘要：

~~~ts
interface BrowserProfileSwitchImpact {
  activeAgentRuns: number
  activeDownloads: number
  pendingAnnotations: number
  openTabs: number
  requiresConfirmation: boolean
}
~~~

如果存在 Agent 操作、下载或未完成批注，必须先确认或处理，不能直接强制切换。
主进程负责最终判断，Renderer 中的确认状态不能绕过 Broker 租约和下载检查。

已有 Profile 更换存储位置不是简单修改字符串。第一版采用“安排迁移并重启”：

1. 用户选择新目录。
2. 主进程验证目录和冲突。
3. 写入 <code>pendingSessionPath</code>，提示需要重启。
4. 下次 Electron 启动且 Session 尚未创建时复制到临时目录。
5. 校验后原子切换 Profile 元数据。
6. 迁移成功前保留旧目录，以便恢复。

这样避免移动仍被 Chromium 占用的 Cookie、Cache 和数据库文件。

侧边栏名称、页面标题、4 个 Tab 和所有操作文案必须补齐
<code>en/zh/zh-TW/ja/ko/pt/es/ru/de/fr</code> 等全部现有 Locale。

## 十一、Agent 自动化

### 11.1 CDP Target 隔离验证

完整开发前必须先做 Spike：

1. Electron 使用仅 loopback 的随机远程调试端口启动。
2. 创建多个 <code>WebContentsView</code> 测试标签页。
3. 获取每个标签页准确的 Page WebSocket URL。
4. 由桌面自动化执行器运行 <code>agent-browser --cdp &lt;page-url&gt;</code>。
5. 验证 snapshot、click、fill、press、scroll、screenshot、console 和导航。
6. 用户切换活动标签页后，Agent 仍然控制原标签页。
7. Agent 不能切换到其他标签页或 Hermes Studio 主 Renderer。
8. 验证导航、崩溃、关闭标签页、重启后的 Target 重建行为。

如果 <code>agent-browser</code> 需要 Browser 级 CDP Endpoint，或者能逃离指定
Page Target，则不能按此方案发布，必须改用
<code>webContents.debugger.sendCommand()</code>。

### 11.2 CDP 凭据

每个标签页的 Target ID 和 Page WebSocket URL 只保存在 Electron 内存中。
它们不能写入 <code>broker.json</code>，也不能返回给：

- Web UI Server；
- MCP 进程；
- Ekko Agent；
- Hermes Agent；
- coding agent；
- 模型。

Browser Broker 先校验调用者和标签页租约，再由桌面自动化执行器把准确 Page URL
传给 <code>agent-browser</code> 子进程。

## 十二、实时查看和接管

Agent 操作的是当前可见 <code>WebContentsView</code>，所以桌面预览不需要
<code>agent-browser</code> JPEG Stream。

界面显示：

- 当前 Agent；
- 当前动作，例如“正在点击登录”；
- 被控制的标签页；
- Agent/用户控制权；
- 停止并接管按钮；
- Target 断开、超时和页面崩溃状态。

第一版采用明确接管：

1. 用户点击“接管”；
2. Broker 中止当前 Agent 操作；
3. 释放 Agent 租约；
4. 用户输入恢复为权威输入。

不允许 Agent 输入和用户输入静默竞争。

## 十三、DOM 选择与区域框选

### 13.1 代码归属

- Electron Desktop：注入脚本、页面选择、清理、截图和坐标转换；
- Client：批注按钮、冻结截图、评论编辑和 Composer Attachment；
- Preload：只提供 start/cancel/result Typed IPC；
- Agent/MCP：只负责截图和模型图片输入，不负责用户批注交互。

注入实现不能放进普通 Web UI Bundle，也不能接受 Renderer 传入的 JavaScript
源码。

### 13.2 DOM 元素选择

使用 <code>executeJavaScriptInIsolatedWorld()</code> 注入固定脚本：

- Capture Phase 监听 Pointer Move；
- 使用 <code>document.elementsFromPoint()</code> 找到候选元素；
- 忽略注入的 Overlay；
- 使用 <code>getBoundingClientRect()</code> 绘制高亮；
- Capture Phase 拦截最终点击，避免触发网页真实操作；
- 返回标准化坐标和安全元素元数据。

### 13.3 任意区域框选

- Capture Phase 监听 Pointer Down/Move/Up；
- 支持任意方向拖动；
- 坐标限制在当前 Viewport；
- 对反向拖动结果进行标准化；
- 小于最小尺寸时视为误操作；
- 返回 Viewport 坐标和页面滚动位置。

### 13.4 Overlay 与清理

- 使用唯一 Overlay Host；
- 使用隔离的 Shadow Root；
- 不提供 Node、IPC、文件、Cookie、Storage 或 Clipboard 能力；
- 选择完成、取消、超时、导航、切换标签页、关闭标签页、页面崩溃时都要清理；
- 同一个标签页重复开始批注时，先取消上一轮；
- 清理 Pointer Listener、Animation Frame、Overlay DOM 和隔离世界状态。

第一版只选择顶层 Document。跨域 iframe 可以作为一个矩形元素选择，但不能读取
iframe 内部 DOM。

### 13.5 批注流程

1. 在当前标签页注入元素或区域选择器。
2. 用户点击元素或拖动矩形。
3. 保留高亮并由 Electron 截取当前 Viewport。
4. 保存 URL、标题、Tab ID、Viewport、缩放、滚动位置和安全元数据。
5. 清理选择器并隐藏原生 View。
6. 在 Vue Canvas 中显示冻结截图。
7. 用户输入或修改评论。
8. 把图片和结构化批注添加到当前 Composer，但不自动发送。
9. 关闭批注或发送消息后恢复原生 View。

~~~ts
interface BrowserAnnotation {
  tabId: string
  mode: 'element' | 'region'
  url: string
  title: string
  comment: string
  viewport: {
    width: number
    height: number
    scaleFactor: number
  }
  region: {
    x: number
    y: number
    width: number
    height: number
  }
  element?: {
    role?: string
    name?: string
    tag?: string
    id?: string
    classNames?: string[]
    selectorHint?: string
  }
}
~~~

元素元数据不能包含：

- Input Value 或密码；
- 隐藏文本；
- Dataset；
- Script；
- Event Handler 源码；
- Cookie、Header 或 Storage；
- 无长度限制的页面文本。

## 十四、截图与模型视觉输入

<code>browser_screenshot</code> MCP 工具返回：

- 标准 MCP Image Content；
- 小型 JSON/Text 摘要；
- Tab ID、URL、Viewport 等非敏感信息。

Ekko 的 MCP Client 和模型 Provider Adapter 必须保留图片内容，不能把图片降级为
本地路径文本。

内部可以使用：

~~~ts
interface AgentToolAsset {
  type: 'image'
  path: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  purpose: 'browser_screenshot' | 'browser_annotation'
}
~~~

要求：

- OpenAI Responses、OpenAI-compatible Chat、Anthropic、Gemini 分别测试；
- 不支持视觉的模型回退到可访问性快照；
- Base64 图片不能写入消息正文、日志、Socket.IO Event 或工具摘要；
- 临时图片使用 owner-only 目录；
- 超过 TTL 或 Session 结束后删除。

## 十五、浏览器 Profile

### 15.1 Profile 存储位置

Electron 支持两种持久化 Session：

~~~text
session.fromPartition('persist:hermes-browser:<profile-id>')
session.fromPath('<absolute-profile-path>')
~~~

如果只需要 Hermes 管理默认位置，可以使用 <code>fromPartition()</code>。
如果要允许用户明确配置 Profile 目录，应使用
<code>session.fromPath(absolutePath)</code>，然后创建
<code>WebContentsView</code> 时通过 <code>webPreferences.session</code>
传入该 Session。

默认 Profile 目录：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/profiles/<profile-id>/session
~~~

用户可以通过 Electron 原生目录选择器修改某个 Profile 的存储位置。要求：

- 必须是绝对路径；
- 创建 Session 前完成路径解析和权限检查；
- 使用 <code>realpath</code> 防止符号链接绕过；
- 不允许选择 Web UI 数据库、Hermes Agent Home、应用安装目录或其他
  Profile 的子目录；
- 不能直接选择系统 Chrome 的 <code>User Data</code> 或
  <code>Default</code>；
- 路径变更后不能继续复用旧 Session 对象。

~~~ts
interface DesktopBrowserProfile {
  id: string
  name: string
  sessionPath: string
  pendingSessionPath?: string
  downloadPath: string
  askBeforeDownload: boolean
  downloadConflictPolicy: 'ask' | 'uniquify'
  createdAt: string
  lastUsedAt: string
}
~~~

Profile 配置元数据保存在：

~~~text
$HERMES_WEB_UI_HOME/desktop-browser/profiles.json
~~~

它只保存 Profile ID、名称和规范化后的目录，不保存 Cookie、密码或 Broker
Token。Session 数据保存在各自的 <code>sessionPath</code> 中。

### 15.2 多 Profile 切换

支持多 Profile，但一个已经创建的 <code>WebContentsView</code> 不能原地更换
Session。Session 必须在创建 View 时确定。

第一版采用“一个活动 Profile 对应一组标签页”：

1. 用户选择另一个 Profile。
2. 中止当前 Profile 的 Agent 操作并释放所有租约。
3. 如果存在下载或未完成批注，要求用户先处理。
4. 记录当前 Profile 的标签页 URL 和恢复信息。
5. 销毁当前 Profile 的全部 <code>WebContentsView</code> 和内部 Target。
6. 通过目标 Profile 的绝对路径创建/获取 Electron Session。
7. 使用新 Session 重建该 Profile 的标签页。
8. 恢复该 Profile 自己的标签页状态。

不要为了快速切换而长期保留多个 Profile 的全部隐藏 View，避免内存占用和
Agent 误操作。所有 Tab、Target、截图、下载和租约都必须带
<code>profileId</code>。

Profile 切换、创建、删除和路径修改只能由用户在桌面 UI 中执行，不作为 MCP
工具暴露给 Agent。

### 15.3 下载位置

下载目录属于 Profile，可以独立配置。默认建议：

~~~text
<系统 Downloads>/Hermes Studio/<profile-name>
~~~

创建 Session 后调用：

~~~ts
browserSession.setDownloadPath(profile.downloadPath)
~~~

同时监听 Session 的 <code>will-download</code>：

- 第一版默认下载前确认；
- 可使用 <code>DownloadItem.setSavePath()</code> 设置单个文件位置；
- 处理重名、非法文件名、目录逃逸和覆盖；
- 显示来源域名、文件名、类型和大小；
- Agent 发起的下载必须获得用户确认；
- Profile 切换或删除前处理进行中的下载。

下载目录也必须通过 Electron 原生目录选择器配置，远程网页和 Agent 不能指定
任意本地路径。

### 15.4 隔离与清理

每个 Profile 与 Web UI Session、Hermes Agent 状态、其他 Browser Profile 和
系统 Chrome Profile 完全隔离。

不能直接使用 Chrome 的 <code>User Data</code> 或 <code>Default</code>：

- Chrome 和 Electron Chromium 版本可能不同；
- Chrome 会锁定正在使用的 Profile；
- 密码和 Cookie 可能使用安装相关加密；
- 直接复用有数据损坏风险。

“工具 → 浏览器”的 Profile、下载和隐私 Tab 提供：

- Profile 创建、重命名、切换和删除；
- Profile 目录选择；
- 每个 Profile 的下载目录选择；
- 清除 Cookie 和站点数据；
- 清除缓存；
- 重置当前 Profile；
- 重置所有 Hermes Browser Profile；
- 下载前确认；
- 站点权限查看。

删除 Profile 属于破坏性操作，必须二次确认。优先移动到系统废纸篓或先创建可恢复
备份，不能直接静默删除目录。

## 十六、安全要求

- 每个远程 View 使用
  <code>sandbox: true</code>、
  <code>nodeIntegration: false</code>、
  <code>contextIsolation: true</code>、
  <code>webSecurity: true</code>。
- 远程 View 不加载 Hermes Desktop Preload。
- 顶层导航只允许规范化后的 HTTP/HTTPS 和明确的内部 Blank/Error Page。
- 开发环境允许 localhost，但继续拦截云 Metadata 地址和疑似 Token URL。
- 默认拒绝摄像头、麦克风、定位、通知、MIDI、USB、Serial、Bluetooth、
  Clipboard、屏幕捕获和文件权限。
- 显式处理 Popup、新窗口、协议处理和下载。
- Browser Broker 不支持 CORS，拒绝网页 Origin，所有请求必须认证。
- MCP 只能调用固定 6 个语义工具。
- MCP 和模型不能看到 Broker Token、CDP URL、Cookie、Storage、IndexedDB、
  Authorization Header 或密码。
- 注入脚本固定在 Desktop 代码中，IPC 只允许 element/region 枚举。
- 页面文本属于不可信 Agent Context。
- 提交敏感表单、删除、发布、购买和权限修改必须由用户确认。
- 日志中隐藏输入秘密、CDP 地址、Broker Token 和状态文件路径。

## 十七、失败处理

- View 崩溃：显示可恢复错误，用户确认后重建。
- CDP Target 变化：先作废内部 Target Record，再接受新操作。
- Broker 描述文件过期：MCP 返回明确的桌面浏览器不可用错误。
- <code>agent-browser</code> 断开：保留页面，控制权返回用户。
- 单个工具超时：只中止本次操作，不破坏页面。
- 截图失败：返回可访问性快照和本地化说明。
- 关闭被控制标签页：中止该标签页操作，不影响其他标签页。
- Profile 切换：先中止该 Profile 的全部 Agent 操作，处理下载和批注，再重建
  View。
- Profile 目录不可用：保留配置并显示修复入口，不能自动回退到另一个目录造成
  用户误以为数据丢失。
- 应用重启：保留 Profile，不恢复旧租约、Broker Token 或 CDP Target。

## 十八、测试

### 18.1 单元测试

- URL 规范化和危险 Scheme 拒绝；
- Metadata 地址和疑似 Token URL 拦截；
- Preload 只暴露文档中的 Browser API；
- IPC Sender 校验；
- 普通 Web UI 无浏览器路由、Store 和 Lazy Import 激活；
- 标签页创建、切换、关闭、状态保留和 8 个上限；
- Profile 创建、重命名、切换、删除和目录冲突校验；
- 浏览器路由只在完整 Desktop Browser Bridge 存在时动态注册；
- 普通 Web UI 没有浏览器路由和侧边栏入口；
- Profile 列表、切换影响摘要、下载进度和数据清理状态正确；
- Profile 迁移使用 pending 状态、重启执行、失败回滚并保留旧目录；
- Profile 切换会销毁旧 View，并使用新 Session 重建；
- 不同 Profile 的 Cookie、Cache、Tab、Target 和下载目录完全隔离；
- Renderer 不能直接提交任意 Profile 或下载路径；
- Bounds 限制；
- 权限默认拒绝；
- Broker 文件 PID、Token、地址、过期时间和权限校验；
- Broker 拒绝非法 Origin 和未认证请求；
- MCP 仅在有效 Desktop Broker 存在时暴露 6 个工具；
- 模型参数不能覆盖 Launcher 注入的 Caller ID；
- MCP 结果不包含 Token 和 CDP 地址；
- 同一标签页并发租约冲突；
- Agent 操作不跟随 UI 标签页切换；
- Annotation IPC 拒绝任意脚本和 Selector；
- 元素元数据敏感信息过滤；
- 反向区域拖动标准化和边界限制；
- 所有取消和异常路径都清理注入状态；
- 图片 TTL 清理；
- 各 Provider 的图片 Payload 转换。

### 18.2 桌面集成测试

- 打开本地 Fixture；
- 测试地址栏、前进、后退、刷新、标题和 Loading；
- 创建、切换、关闭多个标签页；
- 第九个标签页返回本地化错误；
- Ekko、Hermes、一个 coding agent 分别操作同一个可见页面；
- UI 切换标签页后，Agent 仍绑定原标签页；
- Agent 不能访问 Hermes Studio 主 Renderer；
- Profile Cookie 持久化且与 Web UI 隔离；
- 创建两个 Profile，验证登录状态、标签页和下载目录互不共享；
- 切换 Profile 时验证 Agent 操作、租约、批注和下载处理；
- 修改 Profile 目录后验证 Session 使用新路径；
- 下载前确认、重名处理、目录限制和进度状态正确；
- “工具 → 浏览器”的所有操作只经过 Preload IPC，不产生 Koa 或
  Socket.IO 浏览器请求；
- 所有 Locale 都包含新增 Browser Page 文案；
- 窗口缩放、最大化、恢复后 Bounds 对齐；
- 全局 Modal 能正确隐藏原生 View；
- DOM 元素选择正确；
- 四个方向的矩形拖动正确；
- 跨域 iframe 只能选择外框；
- 取消批注后无残留 Overlay 和 Listener；
- Composer 收到真实图片和结构化批注；
- “接管”能中止当前 Agent 操作。

### 18.3 手动安全检查

- 测试 <code>javascript:</code>、<code>file:</code>、<code>data:</code>；
- 测试 Metadata 地址和带 Token URL；
- 测试摄像头、麦克风、定位、通知、Clipboard、下载和 Popup；
- 检查日志和进程参数是否泄漏 Broker/CDP/秘密；
- 从未认证本地进程请求 Broker；
- 确认重置 Browser Data 不影响 Web UI 和系统 Chrome；
- 浏览器直接打开普通 Web UI，确认没有入口、路由、Bridge、API、Stream 或
  MCP Browser Toolset。

## 十九、实施阶段

### Phase 0：CDP Target 隔离 Spike

- 创建最小 <code>WebContentsView</code>；
- 验证 <code>agent-browser</code> 连接准确 Page Target；
- 验证多标签页隔离；
- 决定使用 <code>agent-browser</code> 还是
  <code>webContents.debugger</code>。

### Phase 1：可见浏览器 MVP

- 实现 BrowserManager；
- 实现标签页和导航；
- 实现 Vue 浏览器界面；
- 实现 Typed Preload IPC；
- 实现 Bounds 同步；
- 实现独立 Profile 和权限策略；
- 实现可配置 Profile/下载目录和多 Profile 切换；
- 动态注册桌面专属 Browser Route，并在侧边栏“工具”分组增加入口；
- 实现包含浏览器、Profile、下载、隐私与权限的独立页面；
- 完成桌面端专属 Gate；
- 先支持用户手动浏览。

### Phase 2：多 Agent 控制

- 实现 Browser Broker；
- 实现 Broker 描述文件和认证；
- 实现 6 个 Browser MCP 工具；
- 向 Ekko、Hermes、Codex、Claude Code 仅桌面注入；
- 实现 Caller ID、Tab Binding、Lease、Abort 和 Action Status；
- Agent 操作同一个可见 View。

### Phase 3：批注和视觉

- 实现隔离世界 DOM 元素选择；
- 实现任意区域框选；
- 实现清理机制；
- 实现截图冻结和评论编辑；
- 接入 Composer；
- 实现标准 MCP Image Content；
- 修复非桌面 <code>browser_vision</code> 只返回路径的问题。

### Phase 4：加固

- 权限管理；
- Browser Data 设置；
- 下载策略；
- 崩溃恢复；
- 跨平台桌面测试；
- 评估标签页按 Chat 分组或恢复。

## 二十、验收标准

- 桌面用户可以在 Hermes Studio 内打开多个本地或 HTTPS 页面。
- 标签页切换后各自状态保持。
- Ekko、Hermes、Codex、Claude Code 使用同一套 MCP 工具。
- 所有 Agent 操作的是同一个可见页面，不启动第二个 Chrome。
- Agent 操作始终绑定指定标签页。
- Agent 不能访问 Hermes Studio 主 Renderer。
- 用户能看到操作并随时接管。
- 浏览器登录状态只保存在 Hermes Browser Profile。
- 用户可以创建和切换多个 Profile，各 Profile 的登录状态和下载目录隔离。
- 用户可以通过桌面原生目录选择器配置 Profile 数据目录和下载目录。
- 用户可以在“工具 → 浏览器”中浏览网页并管理 Profile、下载、数据和站点权限。
- 用户能点击 DOM 元素或任意拖动矩形进行批注。
- 批注以图片和安全结构化信息进入 Composer，且不自动发送。
- Screenshot 向视觉模型提供真实图片。
- 普通 Web UI 和 VPS 没有入口、路由、Bridge、API、Stream、Broker 或浏览器
  MCP Toolset。
- macOS、Windows、Linux 的安全和集成测试通过。

## 二十一、待确认问题

- <code>agent-browser@0.26.0</code> 使用 Page WebSocket URL 时是否始终严格
  限定 Target？
- 标签页是否永久独立于 Chat，还是后续按 Chat 分组？
- 用户手动点击时自动暂停 Agent，还是必须点击“接管”？
- 第一版是否完全禁用下载？
- 哪些高风险站点或操作必须二次确认？
- 各模型 Provider 对 MCP Image Content 的兼容方式是什么？
- 随机 loopback CDP 暴露是否可以接受，还是应直接使用
  <code>webContents.debugger</code>？
