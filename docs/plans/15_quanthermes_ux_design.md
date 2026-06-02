# Quanta Hermes 用户体验改造方案

> 版本: 2.0 | 作者: 工程负责人 | 日期: 2026-05-31

---

## 一、改造范围总览

```
┌─────────────────────────────────────────────────────┐
│                   改造波及两个项目                     │
│                                                      │
│  ┌───────────────────────────┐  ┌───────────────┐   │
│  │ quantclaw_singup/         │  │ hermes-web-ui  │   │
│  │   quanthermes/            │  │                │   │
│  │                           │  │                │   │
│  │ ★ static/index.html 重写  │  │ ★ AppSidebar   │   │
│  │ ★ adapter.go 热点改名     │  │   加切换WiFi    │   │
│  │ ★ kiosk.sh 脚本微调       │  │   入口          │   │
│  └───────────────────────────┘  └───────────────┘   │
│                                                      │
│  不改: service.go / handler.go / agent.go            │
│        状态机和 API 已完备                            │
└─────────────────────────────────────────────────────┘
```

---

## 二、模块 A：quanthermes 配网程序

### A1 — 重写 `static/index.html`

**路径**: `quantclaw_singup/quanthermes/internal/static/index.html`

**改动类型**: 全新重写（约 400 行 → 约 450 行）

**改动内容**:

| 维度 | 旧 | 新 |
|------|----|----|
| 色系 | 浅色（`#eef4ff` 底 + 白色卡片） | 深色 Quanta 品牌（`#0f172a` 底 + 玻璃拟态卡片） |
| 标题 | `Quanthermes WiFi Provisioning` | `Quanta Hermes 配网` |
| 信息量 | 12 个状态卡片全部展示 | 核心 4 项展示，其余折叠到 "▸ 高级信息" |
| 视图 | 单一视图（状态面板 + 表单 + WiFi列表） | 三视图（A:AP配网 / B:WiFi已连接 / C:WiFi无公网） |
| 配网成功后 | 刷新状态面板，显示技术信息 | 显示 "去 keli.quantclaw.vip 开始使用" + 主按钮 |
| 移动端 | 响应式 grid | 移动端表单优先 + Kiosk 大屏双列布局 |

**JS 核心逻辑（保持现有 API，不改后端）**:

```javascript
// 视图切换 —— 前端根据现有 /api/status 返回值判定
function renderView(status) {
  if (status.apActive) {
    return renderViewA(status);      // AP 模式 — 配网表单
  }
  if (status.connected && status.internetAvailable) {
    return renderViewB(status);      // WiFi 正常 — 状态 + 跳转指引
  }
  if (status.connected && !status.internetAvailable) {
    return renderViewC(status);      // WiFi 无公网 — 警告 + 换网
  }
  return renderViewA(status);        // 兜底
}

// 配网提交后轮询（Hermes 热点不一定会断）
async function submitConfig(e) {
  e.preventDefault();
  const resp = await fetch('/api/config', { method: 'POST', ... });
  const data = await resp.json();
  
  if (data.status === 'accepted') {
    showLoading('正在连接 WiFi...');
    await pollUntilConnected();  // 每 2s 轮询 /api/status，最多 10 次
  }
}
```

**三种视图的 DOM 结构**:

```html
<!-- 视图 A: AP 配网 -->
<div id="viewA" class="view">
  <div class="brand-hero">
    <img src="logo.png" alt="Quanta Hermes">
    <h1>等待配网</h1>
    <p>请用手机连接 WiFi <strong>"Quanta Hermes Setup"</strong></p>
    <p>密码: quanta2024</p>
    <p class="muted">浏览器将自动弹出配网页面，或手动打开 http://192.168.4.1</p>
  </div>
  
  <form id="provisionForm" class="form-card">
    <input id="ssid" placeholder="WiFi 名称" required>
    <input id="password" type="password" placeholder="WiFi 密码">
    <input id="phone" placeholder="手机号（可选）">
    <button type="submit" class="btn-primary">保存并连接</button>
    <button type="button" class="btn-secondary" id="resetBtn">重置网络</button>
  </form>
  
  <div id="wifiList" class="wifi-grid"></div>
</div>

<!-- 视图 B: WiFi 已连接 -->
<div id="viewB" class="view" style="display:none">
  <div class="brand-hero">
    <img src="logo.png" alt="Quanta Hermes">
    <h1><span class="status-dot online"></span> 已连接</h1>
    <p>WiFi: <strong id="connectedSSID">-</strong></p>
    <p>IP: <code id="connectedIP">-</code></p>
    <p>公网: <span id="internetStatus">-</span></p>
  </div>
  
  <div class="actions-stack">
    <a class="btn-primary" href="http://keli.quantclaw.vip" target="_blank">
      去 keli.quantclaw.vip 开始使用
    </a>
    <button class="btn-outline" id="changeWiFiBtn">更换 WiFi</button>
  </div>
  
  <details class="advanced-info">
    <summary>高级信息</summary>
    <dl>
      <dt>设备 ID</dt><dd id="deviceId">-</dd>
      <dt>上报状态</dt><dd id="reportStatus">-</dd>
      <dt>驱动</dt><dd id="driver">-</dd>
    </dl>
  </details>
</div>

<!-- 视图 C: WiFi 无公网 -->
<div id="viewC" class="view" style="display:none">
  <div class="brand-hero state-warning">
    <h1><span class="status-dot warning"></span> 无法访问互联网</h1>
    <p>WiFi: <strong id="noNetSSID">-</strong></p>
    <p>设备已连接路由器，但路由器未接入外网</p>
  </div>
  <div class="help-card">
    <p>可能原因：</p>
    <ul>
      <li>路由器未连接互联网</li>
      <li>网络需要浏览器认证（如酒店/机场WiFi）</li>
    </ul>
  </div>
  <button class="btn-primary" id="changeWiFiBtnC">更换 WiFi</button>
</div>
```

**CSS 变量系统**（Quanta 品牌统一）:

```css
:root {
  --quanta-bg: #0f172a;
  --quanta-card: rgba(255,255,255,0.03);
  --quanta-border: rgba(255,255,255,0.07);
  --quanta-text: #f1f5f9;
  --quanta-muted: #94a3b8;
  --quanta-accent: #06b6d4;
  --quanta-success: #10b981;
  --quanta-warning: #f59e0b;
  --quanta-error: #ef4444;
  --quanta-font: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  --radius-lg: 24px;
  --radius-md: 14px;
}

body {
  background: linear-gradient(135deg, #040810, #0f172a);
  color: var(--quanta-text);
  font-family: var(--quanta-font);
  min-height: 100vh;
}

/* HDMI 大屏适配 */
@media (min-width: 1400px) {
  body { font-size: 20px; }
  .wifi-grid { grid-template-columns: repeat(2, 1fr); }
  .form-card { max-width: 600px; margin: 0 auto; }
}
```

---

### A2 — 修改 AP 热点名称

**路径**: `quantclaw_singup/quanthermes/internal/platform/linuxwifi/adapter.go`

**改动类型**: 两行替换

```go
// 旧 (L20-21)
const apSSID = "Quanthermes-Hotspot"
const apPassword = "12345678"

// 新
const apSSID = "Quanta Hermes Setup"
const apPassword = "quanta2024"
```

**影响**: `ensureAPProfile()` 创建热点时使用新名称和密码。对现有功能零影响。

---

### A3 — 微调 Kiosk 脚本

**路径**: `quantclaw_singup/quanthermes/scripts/quanthermes-kiosk.sh`

**改动类型**: 逻辑不变，换一个解析方式（当前 `grep` 太脆弱）

```bash
# 旧 (L36-40)
if echo "$P" | grep -q '"displayMode":"business"'; then
  T="http://127.0.0.1:6060/"
else
  T="http://127.0.0.1/"
fi

# 新 —— 同时检查 displayMode 和 internetAvailable
DISPLAY_MODE=$(echo "$P" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('displayMode',''))" 2>/dev/null || echo "")
INTERNET=$(echo "$P" | python3 -c "import sys,json;d=json.load(sys.stdin);print('1' if d.get('internetAvailable') else '0')" 2>/dev/null || echo "0")

if [ "$DISPLAY_MODE" = "business" ] && [ "$INTERNET" = "1" ]; then
  T="http://127.0.0.1:6060/"
else
  T="http://127.0.0.1/"
fi
```

> 如果设备上没有 python3，改用更可靠的 jq 或保持 grep 但加 `internetAvailable` 双重检查。

---

## 三、模块 B：hermes-web-ui

### B1 — AppSidebar 底部加 "切换WiFi" 入口

**路径**: `hermes-web-ui/packages/client/src/components/layout/AppSidebar.vue`

**改动类型**: 在侧边栏底部品牌标识旁边增加一个入口按钮

**改动位置**: 侧边栏底部（通常有品牌名称区域，如 `Quanta Hermes`）

```vue
<!-- 在侧边栏底部添加 -->
<div class="sidebar-footer">
  <div class="brand-name">Quanta Hermes</div>
  <a 
    :href="provisioningUrl" 
    target="_blank"
    class="wifi-switch-btn"
    title="切换 WiFi 网络"
  >
    <WifiIcon />
    <span>切换 WiFi</span>
  </a>
</div>

<script setup>
import { computed } from 'vue';

const provisioningUrl = computed(() => {
  // 从当前地址推断配网页地址（同 IP，端口 80）
  const host = window.location.hostname;
  return `http://${host}:80/`;
});
</script>
```

**改动量**: ~15 行 Vue template + ~8 行 script

---

### B2 — 品牌标题统一

**路径**: `hermes-web-ui/packages/client/index.html`

```html
<!-- 旧 -->
<title>Quanthermes</title>

<!-- 新 -->
<title>Quanta Hermes</title>
```

同级 `packages/website/index.html` 同样替换。

---

### B3 — Favicon 与 Logo 统一

四个位置的 favicon 替换为统一 Quanta 图标（如果已有统一图标文件则直接覆盖）：

| 文件 | 改动 |
|------|------|
| `hermes-web-ui/packages/client/public/favicon.ico` | 替换为 Quanta 统一图标 |
| `hermes-web-ui/packages/website/public/favicon.ico` | 同上 |
| `hermes-web-ui/packages/client/src/assets/logo.png` | 替换为 Quanta Hermes Logo |
| `hermes-web-ui/packages/website/public/logo.png` | 同上 |
| `quantclaw_singup/quanthermes/internal/static/` 下 logo | 新增同款 Logo 文件 |

---

## 四、改造不改的内容（明确边界）

| 不改的文件 | 原因 |
|-----------|------|
| `provisioning/service.go` | 状态机已完善：Phase/Mode/DisplayMode 字段都够用 |
| `httpapi/handler.go` + `routes.go` | API 端点 `GET /api/status` `POST /api/config` `GET /api/wifi/scan` `POST /api/reset` 已完备 |
| `config/device_state.go` + `config/config.go` | 状态字段 `DisplayMode` `NetworkState` `InternetAvailable` 全部已有 |
| `report/agent.go` | 设备上报逻辑无需改动 |
| `hermes-web-ui` 的聊天功能 | 配网页和业务页各司其职 |

---

## 五、改造工作量

| 编号 | 文件 | 模块 | 改动 | 工时 |
|------|------|------|------|------|
| A1 | `quanthermes/static/index.html` | 配网 | 重写（~450行） | 2 天 |
| A2 | `linuxwifi/adapter.go` | 配网 | 2 行替换 | 10 分钟 |
| A3 | `quanthermes-kiosk.sh` | 配网 | 微调解析逻辑 | 0.5 天 |
| B1 | `hermes-web-ui/.../AppSidebar.vue` | 业务 | 加切换WiFi入口 | 0.5 天 |
| B2 | `hermes-web-ui/.../index.html` ×2 | 业务 | title 替换 | 5 分钟 |
| B3 | favicon/logo 文件 ×4 | 全局 | 文件替换 | 15 分钟 |
| — | 联调测试 | 全局 | 全流程走通 | 1 天 |
| **合计** | | | | **4 天** |

---

## 六、状态转换表（前端实现参考）

```
/api/status 返回值决定前端渲染哪个视图：

{ apActive: true }
  → 视图 A（AP 配网模式）

{ connected: true, internetAvailable: true }
  → 视图 B（WiFi 正常模式）

{ connected: true, internetAvailable: false }
  → 视图 C（无公网模式）

其余情况
  → 视图 A（兜底）
```

Kiosk 脚本根据同样的 `/api/status` 决定开哪个 URL：

```
displayMode == "business" && internetAvailable == true
  → http://127.0.0.1:6060/（业务页）

其余
  → http://127.0.0.1/（配网页）
```

---

## 七、完整用户旅程

```
用户收到 Hermes 设备
  │
  ▼
插电 + HDMI → 开机自启
  │
  ▼
无 WiFi 配置 → 创建热点 "Quanta Hermes Setup"（密码 quanta2024）
  │
  ▼
HDMI Kiosk 自动打开配网页 → 显示视图 A
  ┌─────────────────────────────────────┐
  │  [Quanta Hermes Logo]               │
  │  等待配网                            │
  │  请用手机连接 "Quanta Hermes Setup"  │
  └─────────────────────────────────────┘
  │
  ▼
手机连热点 → captive portal 弹出 → 看到同一个配网页（视图 A）
  │
  ▼
选 WiFi → 填密码 → 填手机号 → 点「保存并连接」
  │
  ▼
前端轮询 /api/status
  │
  ├─ 连接成功 + 公网可达
  │   手机侧 → 切到视图 B: "✓ 已连接 MyHomeWiFi"
  │           主按钮「去 keli.quantclaw.vip 开始使用」
  │   HDMI侧 → Kiosk 自动切到 http://127.0.0.1:6060/（业务页）
  │
  └─ 连接失败
      显示错误提示 + "请检查密码后重试"
        │
        ▼
用户打开 keli.quantclaw.vip → 手机号登录
        │
        ▼
设备主页 → 点「开始 AI 对话」→ ✓
```

---

## 八、后续在业务页切换 WiFi 的流程

```
用户在 hermes-web-ui 聊天界面
  │
  ▼
侧边栏底部点「切换 WiFi」
  │
  ▼
新标签页打开 http://{设备IP}:80/
  │
  ▼
配网页显示视图 B（当前WiFi信息）
  │
  ▼
点「更换 WiFi」→ 回到视图 A（重新选网）
  │
  ▼
配网完成后 HDMI Kiosk 自动切回业务页
```
