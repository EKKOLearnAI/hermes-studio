# 本 Fork 的自定义改动（stevenwang288/hermes-studio）

本仓库是 `EKKOLearnAI/hermes-studio` 的 fork。`main` 分支 = **上游最新 + 本 fork
的两个自定义改动**（消息队列、桌面字体缩放）。所有改动都固化在源码里、带清晰
`[zoom patch]` / `[preempt patch]` 标记，**上游更新后 merge 回来不会被覆盖**。

> ⚠️ **credits 点数系统已于 2026-08-13 从本仓库剥离**（`git revert 99718a54`）。
> 点数系统属于独立的收费 CDE 平台项目（见 vault「项目笔记-收费CDE平台.md」），
> 与本 Web 面板 fork 无关，代码不在此仓库维护。

**每次部署请优先使用本 fork，而不是上游原版。**

---

## 同步记录（2026-08-13）

- 上游已更新到 `0899f7eb`（v0.6.42 之后 1 个 hotfix：#2511 群聊滚动摘要游标安全）
- **merge 上游**：`git merge upstream/main`（自动合并，零冲突）+ `git revert 99718a54`（剥离 credits）
- **消息队列 bug 修复**（3 处改动，已在 36号 实测验证通过）：
  - 后端 `abort.ts`：`markAbortCompleted` 发出的 `run.queued` 补上 `queued_messages` 字段，前端用服务器权威队列替换
  - 前端 `chat.ts`：`handleRunQueuedEvent` 找不到 `dequeued` 消息时强制 `dropQueuedUserMessage` 移除 UI 队列
  - 前端 `MessageList.vue`：隐藏上游 #2477 的「安全排队插入」按钮（`v-if="false"`），避免与本 fork 的「↑ 立即发送」图标重复，同时移除未使用的 `canInsertQueuedMessages` 计算属性
- 当前版本：**0.6.42 + hotfix + 消息队列修复**；本 fork 两个自定义改动已验证保留

---

## 改动一：消息队列（发新消息排队，ESC / ↑ / Ctrl+Enter 逐条放行）

### 问题背景
默认行为：当前回复还在流式生成（`isWorking`）时，用户再发一条消息会**直接打断
当前回复**，立刻生成新回复。长回复场景下用户想连续追问只能排队等，或者发一条
就把上一条掐断。

### 解决方案（本 fork 已实现）
- **普通发送不打断，只排队**：`isWorking` 时新消息进入队尾（`state.queue.push`），
  当前回复完成后由 `dequeueNextQueuedRun` 自动按序拾取。
- **三种显式放行方式**，每次只放行队首一条、并打断当前回复立即执行：
  - 队列项的「↑ 立即发送」按钮
  - 输入框按 **ESC**
  - 输入框按 **Ctrl+Enter**（macOS 上为 Cmd+Enter）
- 后端新增 `run.promote` 事件：把指定排队消息提升到队首并打断当前 run。
- abort 幂等保护（`abortFinalized`）：`handleAbort` 与 bridge terminal chunk 会
  并发触发 `markAbortCompleted`，不加保护会清掉刚启动的下一条 run 的状态。

### 涉及文件
| 文件 | 改动 |
|---|---|
| `packages/server/src/services/hermes/run-chat/index.ts` | `preempt?: boolean` 分流（true=插队打断 / 缺省=队尾排队）；新增 `run.promote` 事件 |
| `packages/server/src/services/hermes/run-chat/abort.ts` | `abortFinalized` 幂等保护；出队队首时带 `dequeued_queue_id` |
| `packages/server/src/services/hermes/run-chat/types.ts` | `SessionState.abortFinalized?: boolean` |
| `packages/client/src/stores/hermes/chat.ts` | 发送带 `preempt:false`；新增 `promoteQueuedMessage` action 走 `run.promote` |
| `packages/client/src/components/hermes/chat/ChatInput.vue` | ESC / Ctrl+Enter 放行队首一条 |
| `packages/client/src/components/hermes/chat/MessageList.vue` | 队列项「↑ 立即发送」按钮 + 样式 |
| `packages/client/src/api/hermes/chat.ts` | `StartRunRequest.preempt?: boolean` |

### 效果
- 回复生成中发送新消息 → 显示为「排队中」，不打断当前回复。
- ESC / ↑ / Ctrl+Enter → 每次放行一条排队消息，立即执行。
- 当前回复正常完成后，排队消息自动按序执行。

---

## 改动二：Windows 桌面版字体缩放快捷键（Ctrl+加号 / Ctrl+减号）

### 问题背景
Hermes Studio 桌面版（`packages/desktop`，Electron）在 Windows/Linux 上执行了：

```ts
if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
```

即**整个原生菜单栏被移除**（Web UI 自带页面内控件，不需要原生菜单）。
但副作用是：Electron 默认的「缩放」快捷键（View 菜单里的
`Ctrl+=` / `Ctrl+-` / `Ctrl+0`）**也随菜单一起失效了**。
用户在 Windows 桌面上按 Ctrl+加号/减号完全没反应，界面字体无法放大缩小。
作者多次收到反馈但未处理。

### 解决方案（本 fork 已实现）
在主进程 `packages/desktop/src/main/index.ts` 中：

1. **新增缩放工具函数**（`[zoom patch]` 标记段）：
   - `loadDesktopZoomLevel()` / `saveDesktopZoomLevel()` —— 缩放级别持久化到
     `userData/desktop-zoom.json`，**重启应用后保留上次的缩放级别**。
   - `installDesktopZoomShortcuts(window)` —— 用 `webContents.on('before-input-event')`
     拦截键盘事件，重新注册缩放快捷键。
2. **快捷键绑定**：
   - `Ctrl +` / `Ctrl =` / 小键盘 `Ctrl+Add` → 放大（步进 0.5）
   - `Ctrl -` / 小键盘 `Ctrl+Subtract` → 缩小（步进 0.5）
   - `Ctrl 0` → 重置为 100%
   - 范围限制：`ZOOM_MIN = -3`（约 12.5%）～ `ZOOM_MAX = 4`（约 400%）
3. **挂载位置**：
   - 主窗口 `createWindow()` 内调用 `installDesktopZoomShortcuts(mainWindow)`
   - 独立聊天窗口 `openChatWindow()` 内调用 `installDesktopZoomShortcuts(chatWindow)`
4. **平台限定**：`if (process.platform !== 'win32') return` —— 只影响 Windows；
   macOS 保留系统默认菜单缩放，互不干扰。

### 效果
- Windows 桌面版：`Ctrl+加号` 放大字体/UI，`Ctrl+减号` 缩小，`Ctrl+0` 还原。
- 设置记住，重启不丢。
- 无需任何设置界面（按用户要求）。

### 文件清单
| 文件 | 改动 |
|---|---|
| `packages/desktop/src/main/index.ts` | 新增 `[zoom patch]` 函数块（约 60 行）+ 2 处挂载调用 + `node:fs` import 扩展 |

---

## 如何跟上上游更新（保留本 fork 改动）

> 前提：两个改动都在**少量文件、带清晰标记**（`[zoom patch]` / `[preempt patch]`
> / `[user-controlled patch]`），合并时能快速识别。

### 完整 SOP（2026-08-13 实操验证）

```bash
# 1. 拉取上游最新
git fetch upstream main

# 2. 查看差距（确认上游改了什么、我们有多少领先）
git rev-list --left-right --count upstream/main...main
git log --oneline main..upstream/main   # 上游新提交
git log --oneline upstream/main..main   # 我们领先的提交

# 3. 检查上游是否也实现了类似功能（如排队消息 #2477 就是上游独立的实现）
#    如果上游有同名/同功能，决定保留谁的版本

# 4. 合入上游（自动合并一般成功）
git merge upstream/main --no-edit
# 若有冲突：
#   - 带 [zoom patch] / [preempt patch] / [user-controlled patch] 标记的代码块 → 保留我们自己的
#   - 其余代码 → 以上游为准
#   - CUSTOM_CHANGES.md 保留 fork 版本

# 5. 剥离无关功能（如 credits 点数系统归属另一个项目）
git revert <要剥离的提交SHA> --no-edit
# 检查上游是否有同类功能需要剥离：
#   curl -s "https://api.github.com/search/code?q=credits+repo:EKKOLearnAI/hermes-studio"
#   （上游 0 结果，见 2026-08-13 实操）

# 6. 编译验证
npm run build

# 7. 更新 CUSTOM_CHANGES.md 中的同步记录

# 8. 推送
git push origin main
```

### GitHub 网页一键同步（仅限零冲突）
1. 打开本 fork 仓库页 → **Sync fork** → **Update branch**。
2. 无冲突则直接完成；有冲突时回到上面的本地方式解决。

### 冲突时的铁律
- 我们的改动只出现在：
  - `packages/desktop/src/main/index.ts` 的 `[zoom patch]` 标记段 + import 行 + 2 行调用
  - `run-chat/{index,abort,types}.ts`、`client/.../chat*.{vue,ts}` 的队列功能块
- 合并冲突时：**带上面标记的代码块一律保留我们自己的版本**；其余以上游为准。

---

## 部署说明

### 网页版（在线安装 / 手动部署）
从本 fork 构建前端+后端产物：
```bash
git clone https://github.com/stevenwang288/hermes-studio.git
cd hermes-studio
npm install
npm run build
# 产物在 dist/ 下，按上游部署文档发布
```

### Windows 桌面版
```bash
cd hermes-studio/packages/desktop
npm install
npm run build
```
构建出的安装包/主进程产物即包含两个改动。详见上游 `packages/desktop/README.md`。

> 注意：`packages/desktop/dist/main/index.js` 中的 `[zoom patch]` 是本 fork 编译产物，
> **不要**用上游的 dist 覆盖，构建请从本 fork 源码进行。
