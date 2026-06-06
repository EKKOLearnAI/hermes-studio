# Armbian/Ubuntu 源码部署指南

本文档对应“本地源码打包后上传部署”的场景，不再以设备侧 `git clone` 作为默认流程。

目标机器会在宿主机上直接完成：

- 自动安装 `Hermes Agent`
- 自动安装 `Node.js 23`
- 自动配置 npm 镜像源
- 自动构建 `hermes-web-ui`
- 自动写入 `systemd` 服务并设置开机自启
- 保留 `Hermes` 首次绑定与模型配置为人工操作

## 适用环境

- Debian / Ubuntu / Armbian 系列系统
- 推荐架构：
  - `arm64 / aarch64`
  - `amd64 / x86_64`
- 目标机器可以访问：
  - `npmmirror` 或你自定义的 Node / npm 镜像
  - `Hermes Agent` 安装脚本地址或其镜像

## 适用场景

当以下任一条件成立时，推荐使用本地源码包部署：

- `docker.io` 无法稳定拉取镜像
- Docker 国内镜像源无法解析或频繁超时
- 你已经在本地改好了源码，希望原样部署到设备
- 你希望直接使用宿主机进程 + `systemd` 管理服务

## 相关文件

- 部署脚本：`scripts/deploy-source-armbian.sh`
- systemd 模板：`scripts/hermes-web-ui.service`
- 统一排障速查：[`docs/deploy-troubleshooting.md`](./deploy-troubleshooting.md)

## 重要说明

- `deploy-source-armbian.sh` 现在**不会自动 `git clone` 仓库**。
- 运行脚本前，你必须先把源码包上传并解压到目标目录，或者直接在源码目录内运行脚本。
- 脚本会检查以下任一位置是否存在 `package.json`：
  - 脚本所在目录的上一级
  - `DEPLOY_DIR`
- 如果这两个位置都没有源码目录，脚本会直接报错退出。
- 如果现场部署失败，优先按 [`docs/deploy-troubleshooting.md`](./deploy-troubleshooting.md) 的命令顺序排查。

## 默认主流程：压缩打包 + SCP 上传 + 解压部署

### 方案一：Windows PowerShell 本地打包

建议在仓库的上一级目录执行，这样压缩包里会保留顶层目录 `hermes-web-ui/`：

```powershell
cd G:\AIproject\longxia_keli
tar.exe `
  --exclude=.git `
  --exclude=node_modules `
  --exclude=dist `
  --exclude=.runtime-hermes `
  --exclude=hermes_data `
  -czf hermes-web-ui-src.tar.gz `
  hermes-web-ui
```

上传到目标机器：

```powershell
scp .\hermes-web-ui-src.tar.gz user@YOUR_DEVICE_IP:/tmp/
```

登录目标机器后解压并执行安装：

```bash
ssh user@YOUR_DEVICE_IP
sudo rm -rf /opt/hermes-web-ui
sudo mkdir -p /opt
sudo tar -xzf /tmp/hermes-web-ui-src.tar.gz -C /opt
cd /opt/hermes-web-ui
chmod +x scripts/deploy-source-armbian.sh
sudo ./scripts/deploy-source-armbian.sh
```

### 方案二：Linux/macOS 本地打包

```bash
cd /path/to/parent/of/hermes-web-ui
tar \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.runtime-hermes \
  --exclude=hermes_data \
  -czf hermes-web-ui-src.tar.gz \
  hermes-web-ui
scp hermes-web-ui-src.tar.gz user@YOUR_DEVICE_IP:/tmp/
ssh user@YOUR_DEVICE_IP
```

远端解压并执行安装：

```bash
sudo rm -rf /opt/hermes-web-ui
sudo mkdir -p /opt
sudo tar -xzf /tmp/hermes-web-ui-src.tar.gz -C /opt
cd /opt/hermes-web-ui
chmod +x scripts/deploy-source-armbian.sh
sudo ./scripts/deploy-source-armbian.sh
```

### 可选：自定义安装参数

如果你需要在解压后直接指定端口、运行用户或数据目录，可以这样执行：

```bash
cd /opt/hermes-web-ui
sudo PORT=8080 \
  APP_USER=hermesui \
  HERMES_HOME_DIR=/data/hermes \
  ./scripts/deploy-source-armbian.sh
```

### 建议保留在压缩包外的目录

为了减小体积并避免把本地环境带到目标机，建议不要把下面这些目录打进源码包：

- `.git`
- `node_modules`
- `dist`
- `.runtime-hermes`
- `hermes_data`

### 方案三：极速部署 (使用预编译包)

如果你发现 `git clone` 或 `npm install` 极慢且容易超时，可以使用脚本新支持的“极速模式”。

#### 1. 准备 Agent Wheel (推荐)
直接使用 Hermes 官方 Release 的 Wheel 包（当前统一版本：`v2026.5.29.2`），跳过源码拉取：

```bash
export HERMES_AGENT_WHEEL_URL="https://github.com/NousResearch/hermes-agent/releases/download/v2026.5.29.2/hermes_agent-0.15.2-py3-none-any.whl"
```

如果你要使用 `MiniMax / MiniMax CN` 这类 Anthropic 兼容 provider，建议同时固定 Anthropic SDK 版本。部署脚本现在默认会在 wheel venv 中预装 `anthropic==0.87.0`；如需覆盖，可显式传入：

```bash
export HERMES_ANTHROPIC_VERSION="0.87.0"
```

#### 2. 准备 Web UI Bundle (可选)
在高性能电脑上执行 `npm run build`，然后将 `dist` 目录打包：

```bash
# 在本地开发机
tar -czf hermes-webui-dist.tar.gz dist/
# 上传到你的服务器或 GitHub
```

#### 3. 执行安装
```bash
sudo HERMES_AGENT_WHEEL_URL="https://.../hermes_agent-0.15.2-py3-none-any.whl" \
     HERMES_ANTHROPIC_VERSION="0.87.0" \
     WEBUI_BUNDLE_URL="https://.../hermes-webui-dist.tar.gz" \
     ./scripts/deploy-source-armbian.sh
```

**极速模式优势**：
- **Agent**: 跳过 `git clone`，直接 `pip install` 二进制包，速度提升 5-10 倍。
- **Anthropic 兼容 provider**: wheel 模式会额外固定安装 `anthropic==0.87.0`，避免 MiniMax 等 Anthropic 兼容端点因为手工执行 `pip install anthropic` 拉到过新 SDK 而出现兼容问题。
- **Web UI**: 跳过 `npm install` (100MB+) 和 `npm build` (极耗 CPU)，直接解压产物，速度提升 20 倍以上，且彻底解决超时问题。

## 部署完成后的首次配置

默认运行用户是 `hermesui`，默认 `HERMES_HOME` 是 `/opt/hermes-web-ui/hermes_data`。

部署完成后，手工执行：

```bash
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes setup
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes model
```

完成后重启服务：

```bash
sudo systemctl restart hermes-web-ui.service
```

部署脚本还会自动完成两项 CLI 入口配置：

- 为 `root` 安装安全包装命令 `/usr/local/bin/hermes`
- 为 `hermesui` 的登录 shell 写入 `~/.local/bin` PATH

部署完成后，推荐这样使用：

```bash
hermes version
su - hermesui
hermes version
```

不要用下面这种方式验证：

```bash
su hermesui
hermes version
```

`su hermesui` 是非登录 shell，可能不会加载 `~/.profile`，从而导致 `hermes: command not found`。

## 脚本默认行为

脚本默认会按顺序执行：

1. 检测系统是否为 Debian / Ubuntu / Armbian
2. 检测 CPU 架构并匹配 Node 二进制包
3. 自动校时；如失败则对 `apt update` 使用日期校验兜底
4. 安装基础依赖：
   - `git`
   - `curl`
   - `python3`
   - `python3-venv`
   - `python3-pip`
   - `build-essential`
   - `ffmpeg`
   - `xz-utils`
5. 创建运行用户 `hermesui`
6. 使用 `npmmirror` 下载并安装 `Node.js 23`
7. 自动执行官方 `Hermes Agent` 安装脚本
   - 默认附带 `--skip-setup --skip-browser`
8. 为运行用户写入 `~/.npmrc` 国内镜像配置
9. 执行 `npm install --include=dev`
   - 显式设置 `HERMES_WEB_UI_SKIP_PREPARE=1`，避免安装阶段被根目录 `prepare` 提前触发构建
10. 检查关键构建依赖和类型文件是否完整：
   - `node_modules/naive-ui/es/index.d.ts`
   - `node_modules/typescript/package.json`
   - `node_modules/vue-tsc/package.json`
   - `node_modules/vite/package.json`
11. 执行 `npm run build`
12. 为 `hermesui` 的登录 shell 配置 `~/.local/bin` PATH
13. 安装 `root` 可直接使用的 `/usr/local/bin/hermes` 包装命令
14. 生成 `/etc/default/hermes-web-ui`
15. 根据模板生成 `/etc/systemd/system/hermes-web-ui.service`
16. 启动并设置 `hermes-web-ui.service` 开机自启

## 默认参数

```bash
DEPLOY_DIR=/opt/hermes-web-ui
HERMES_HOME_DIR=/opt/hermes-web-ui/hermes_data
APP_USER=hermesui
PORT=6060
BIND_HOST=0.0.0.0
NODE_REQUIRED_MAJOR=23
NODE_VERSION=23.11.1
NODE_INSTALL_DIR=/opt/node-v23
NPM_REGISTRY=https://registry.npmmirror.com
NODE_MIRROR_URL=https://npmmirror.com/mirrors/node
HERMES_INSTALL_FLAGS="--skip-setup --skip-browser"
HERMES_AGENT_WHEEL_URL="https://github.com/NousResearch/hermes-agent/releases/download/v2026.5.29.2/hermes_agent-0.15.2-py3-none-any.whl"
HERMES_ANTHROPIC_VERSION="0.87.0"
```

## 自定义参数

你可以在运行脚本时覆盖这些变量。

### 修改端口

```bash
sudo PORT=8080 ./scripts/deploy-source-armbian.sh
```

### 修改运行用户

```bash
sudo APP_USER=quantui ./scripts/deploy-source-armbian.sh
```

### 修改 Hermes 数据目录

```bash
sudo HERMES_HOME_DIR=/data/hermes ./scripts/deploy-source-armbian.sh
```

### 修改 Node 版本

```bash
sudo NODE_VERSION=23.12.0 ./scripts/deploy-source-armbian.sh
```

### 修改监听地址

```bash
sudo BIND_HOST=127.0.0.1 ./scripts/deploy-source-armbian.sh
```

## 部署后目录说明

典型目录结构如下：

```text
/opt/hermes-web-ui
├─ dist
├─ node_modules
├─ packages
├─ scripts
└─ hermes_data
```

额外运行资产：

```text
/opt/node-v23
└─ bin/node

/etc/default/hermes-web-ui
/etc/systemd/system/hermes-web-ui.service
/home/hermesui/.local/bin/hermes
/home/hermesui/.npmrc
```

## 服务管理

### 查看状态

```bash
sudo systemctl status hermes-web-ui.service
```

### 查看日志

```bash
sudo journalctl -u hermes-web-ui.service -f
```

### 重启服务

```bash
sudo systemctl restart hermes-web-ui.service
```

### 停止服务

```bash
sudo systemctl stop hermes-web-ui.service
```

### 禁用开机自启

```bash
sudo systemctl disable --now hermes-web-ui.service
```

## 访问地址

默认端口是 `6060`：

```text
http://设备IP:6060
http://127.0.0.1:6060
```

## 手动验证

如果你是在 Armbian / Ubuntu 设备上首次走源码部署，建议先看 [`docs/deploy-troubleshooting.md`](./deploy-troubleshooting.md) 的“源码部署排查”，再做下面这些检查。

### 检查 Node 版本

```bash
/opt/node-v23/bin/node -v
/opt/node-v23/bin/npm -v
```

### 检查 Hermes 是否安装成功

```bash
sudo -u hermesui -H /home/hermesui/.local/bin/hermes version
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes doctor
```

### 检查 Web UI 构建产物

```bash
ls -lah /opt/hermes-web-ui/dist
ls -lah /opt/hermes-web-ui/dist/server
```

### 检查服务环境变量

```bash
cat /etc/default/hermes-web-ui
systemctl cat hermes-web-ui.service
```

## 部署后快速自检

如果页面能打开，但聊天报错、模型请求异常或页面提示无法连接 Hermes agent bridge，优先执行下面这组检查：

```bash
sudo systemctl status hermes-web-ui.service --no-pager -l
sudo journalctl -u hermes-web-ui.service -n 120 --no-pager
sudo -u hermesui -H ls -lah /home/hermesui/.local/bin/hermes
sudo -u hermesui -H head -n 1 /home/hermesui/.local/bin/hermes
sudo -u hermesui -H ls -lah /tmp/hermes-agent-bridge.sock
```

预期结果：

- `hermes-web-ui.service` 为 `active (running)`
- 日志里没有 `agent bridge exited before ready` 或 `run_agent.py not found`
- `/home/hermesui/.local/bin/hermes` 归属 `hermesui`
- `/home/hermesui/.local/bin/hermes` 不应链接到 `/root/.local/...`
- `/tmp/hermes-agent-bridge.sock` 存在

## 排障建议

### 1. `apt update` 报 `Release file ... is not valid yet`

脚本会自动：

1. 尝试 `timedatectl set-ntp true`
2. 尝试重启 `systemd-timesyncd`
3. 如果仍失败，则使用：

```bash
apt-get -o Acquire::Check-Date=false update
```

### 2. Node 下载失败

脚本默认先尝试：

- `https://npmmirror.com/mirrors/node`

失败后回退：

- `https://nodejs.org/dist`

如果你所在网络只能访问其他镜像，可手工覆盖：

```bash
sudo NODE_MIRROR_URL=https://your-node-mirror.example.com ./scripts/deploy-source-armbian.sh
```

### 3. Hermes 官方安装脚本下载失败

脚本默认先尝试：

- `https://cdn.jsdelivr.net/gh/NousResearch/hermes-agent@main/scripts/install.sh`

失败后回退：

- `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh`

如果你本地已有更稳定的镜像，也可以覆盖：

```bash
sudo HERMES_INSTALLER_MIRROR=https://your-mirror/install.sh ./scripts/deploy-source-armbian.sh
```

### 4. `npm install` 很慢或失败

源码部署脚本会在安装阶段显式设置 `HERMES_WEB_UI_SKIP_PREPARE=1`，避免根目录 `prepare` 在 `npm install` 过程中提前触发 `npm run build`。安装完成后，脚本会先检查 `naive-ui`、`typescript`、`vue-tsc`、`vite` 的关键文件是否存在，再单独执行构建。

当前仓库未提交 `package-lock.json`，因此源码部署脚本使用 `npm install` 而不是 `npm ci`。脚本会为运行用户写入 `~/.npmrc`，默认使用：

- `https://registry.npmmirror.com`
- `https://cdn.npmmirror.com/binaries`

如果你要手工验证：

```bash
sudo -u hermesui -H cat /home/hermesui/.npmrc
sudo -u hermesui -H env PATH=/opt/node-v23/bin:$PATH npm config get registry
sudo -u hermesui -H test -f /opt/hermes-web-ui/node_modules/naive-ui/es/index.d.ts && echo naive-ui-types-ok
sudo -u hermesui -H test -f /opt/hermes-web-ui/node_modules/typescript/package.json && echo typescript-ok
sudo -u hermesui -H test -f /opt/hermes-web-ui/node_modules/vue-tsc/package.json && echo vue-tsc-ok
```

### 5. Hermes 已安装但还未配置

源码部署脚本默认会给 Hermes 安装命令附带：

```bash
--skip-setup --skip-browser
```

这样可以避免一键部署过程中卡在交互式配置，也能减少 Playwright/Chromium 下载对网络的要求。

部署完成后，请手工执行：

```bash
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes setup
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes model
```

### 6. `systemd` 已启动但页面打不开

先看服务状态：

```bash
sudo systemctl status hermes-web-ui.service
```

再看日志：

```bash
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
```

常见排查点：

- `dist/server/index.js` 是否存在
- `HERMES_BIN` 是否指向 `/home/hermesui/.local/bin/hermes`
- `HERMES_HOME` 是否指向 `/opt/hermes-web-ui/hermes_data`
- `hermes setup` / `hermes model` 是否已经完成

### 7. 页面能打开，但聊天报 `ENOENT /tmp/hermes-agent-bridge.sock`

这通常不是前端问题，而是 `hermes-web-ui.service` 虽然启动了，但 Hermes agent bridge 没有真正起来。

优先检查：

```bash
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
sudo -u hermesui -H ls -lah /home/hermesui/.local/bin/hermes
sudo -u hermesui -H head -n 1 /home/hermesui/.local/bin/hermes
sudo -u hermesui -H ls -lah /tmp/hermes-agent-bridge.sock
```

如果你看到下面任一现象：

- 日志里出现 `agent bridge exited before ready`
- 日志里出现 `RuntimeError: hermes-agent run_agent.py not found`
- `/home/hermesui/.local/bin/hermes` 链接到了 `/root/.local/bin/hermes`
- `/tmp/hermes-agent-bridge.sock` 不存在

基本可以判定为 Hermes 安装归属错误，常见于：

- 服务以 `hermesui` 用户运行
- 但 Hermes 实际被装到了 `root` 用户目录
- 或 `hermesui` 目录下存在不完整的旧安装残留

建议修复方式：

1. 停掉 `hermes-web-ui.service`
2. 清理 `hermesui` 和 `root` 下冲突的 Hermes 安装残留
3. 预先以 `root` 安装 `ripgrep`、`ffmpeg`、`build-essential`、`python3-dev`、`libffi-dev`
4. 重新以 `hermesui` 用户安装 Hermes
5. 重启 `hermes-web-ui.service`

详细过程见 [`docs/work-log.md`](./work-log.md) 中 `2026-05-19 - Armbian 源码部署排障补充`。

补充说明：

- 新版本部署脚本会安装 `/usr/local/bin/hermes` 包装命令，因此 `root` shell 里可以直接执行 `hermes`；实际运行身份仍然是 `hermesui`，不会把 Hermes 状态目录污染成 `root` 所有。
- 如果你手工切换用户，请使用 `su - hermesui`，不要用 `su hermesui`。前者会加载登录环境，后者可能导致 `hermes: command not found`。
- 如果使用 `HERMES_AGENT_WHEEL_URL` 的 wheel/venv 安装模式，旧版本 Web UI 可能给 agent bridge 或其 profile worker 传入默认源码目录 `~/.hermes/hermes-agent`，导致日志出现：
  - `agent bridge exited before ready`
  - `profile worker default exited before ready`
  - `RuntimeError: hermes-agent run_agent.py not found`
- 这类情况下，可先临时在 `/etc/default/hermes-web-ui` 增加下面两行再重启服务：

```bash
HERMES_AGENT_ROOT=
HERMES_AGENT_BRIDGE_PYTHON=/home/hermesui/.hermes/hermes-agent-venv/bin/python3
```

- 修复后的仓库版本会自动兼容 wheel/venv 安装，不再要求存在源码目录 `run_agent.py`。
- 包装命令不会保存、推导或依赖任何默认 root 密码；不要把设备默认密码写入部署脚本。

### 8. 想重新部署

如果你只是重新部署本地源码包，推荐：

```bash
sudo systemctl stop hermes-web-ui.service || true
sudo rm -rf /opt/hermes-web-ui
sudo mkdir -p /opt
sudo tar -xzf /tmp/hermes-web-ui-src.tar.gz -C /opt
cd /opt/hermes-web-ui
chmod +x scripts/deploy-source-armbian.sh
sudo ./scripts/deploy-source-armbian.sh
```

如果你要彻底重置源码部署：

```bash
sudo systemctl disable --now hermes-web-ui.service
sudo rm -f /etc/systemd/system/hermes-web-ui.service
sudo rm -f /etc/default/hermes-web-ui
sudo rm -rf /opt/node-v23
sudo rm -rf /opt/hermes-web-ui
sudo userdel -r hermesui
sudo systemctl daemon-reload
```

## 为什么这里不用 Docker

这个部署路径主要用于以下网络条件：

- Docker Hub 直连超时
- Docker 国内镜像源不可解析
- 容器基础镜像和构建依赖拉取链路不稳定

源码部署仍然需要网络，但它拆分成了：

- 本地源码包上传
- `Hermes` 官方安装脚本
- `Node.js` 二进制镜像
- `npm` 包镜像

相比单纯依赖 Docker Hub，这条链路在国内网络环境里通常更容易逐段兜底。
