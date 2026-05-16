# Armbian/Ubuntu 一键部署指南

本文档面向 `Armbian / Ubuntu 24.04` 这类 Linux 设备，目标是通过一个脚本完成：

- 自动安装系统依赖
- 自动安装 Docker 与 Docker Compose
- 自动部署 `hermes` 运行时
- 自动部署 `hermes-web-ui`
- 保留 `hermes-web-ui` 绑定码 / 首次配置为人工操作

## 适用环境

- Debian / Ubuntu / Armbian 系列系统
- 已联网，可访问 Docker 官方源与 GitHub Raw
- 推荐架构：
  - `arm64 / aarch64`
  - `amd64 / x86_64`

## 脚本位置

- 脚本：`scripts/deploy-armbian.sh`

## 推荐执行方式

### 方式一：仓库内执行

先把仓库拉到设备上，然后执行：

```bash
chmod +x scripts/deploy-armbian.sh
sudo ./scripts/deploy-armbian.sh
```

### 方式二：直接远程执行

```bash
curl -fsSL https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/main/scripts/deploy-armbian.sh -o deploy-armbian.sh
chmod +x deploy-armbian.sh
sudo ./deploy-armbian.sh
```

## 完整命令示例

以下命令适合一台全新、仅安装了基础系统的 Armbian / Ubuntu 设备。

### 1. 安装 Git

```bash
apt-get update -y
apt-get install -y git
```

### 2. 拉取仓库

```bash
cd /opt
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd /opt/hermes-web-ui
```

### 3. 执行一键部署脚本

```bash
chmod +x scripts/deploy-armbian.sh
sudo ./scripts/deploy-armbian.sh
```

如果你就是在仓库目录本身执行脚本，例如：

```bash
cd /opt/hermes-web-ui
sudo ./scripts/deploy-armbian.sh
```

脚本会直接复用当前目录下已有的 `docker-compose.yml`，不会再重复复制该文件。

### 4. 自定义端口部署

```bash
cd /opt/hermes-web-ui
sudo PORT=8080 ./scripts/deploy-armbian.sh
```

### 5. 自定义部署目录与数据目录

```bash
cd /opt/hermes-web-ui
sudo DEPLOY_DIR=/data/hermes-web-ui \
  HERMES_DATA_DIR=/data/hermes-web-ui/hermes_data \
  ./scripts/deploy-armbian.sh
```

### 6. 关闭登录认证

```bash
cd /opt/hermes-web-ui
sudo AUTH_DISABLED=true ./scripts/deploy-armbian.sh
```

### 7. 部署完成后手动执行 Hermes 绑定/配置

```bash
sudo docker exec -it hermes-webui /opt/hermes/.venv/bin/hermes setup
sudo docker exec -it hermes-webui /opt/hermes/.venv/bin/hermes config
```

### 8. 查看运行状态

```bash
cd /opt/hermes-web-ui
sudo docker compose ps
sudo docker compose logs -f hermes-webui
```

## 脚本默认行为

脚本默认会：

1. 检测当前系统是否为 Debian / Ubuntu / Armbian
2. 安装基础依赖：
   - `ca-certificates`
   - `curl`
   - `gnupg`
   - `lsb-release`
   - `apt-transport-https`
   - `software-properties-common`
3. 安装 Docker 与 Docker Compose 插件
4. 启用并启动 `docker` 服务
5. 创建部署目录：
   - `/opt/hermes-web-ui`
6. 创建数据目录：
   - `/opt/hermes-web-ui/hermes_data`
7. 写入部署 `.env`
8. 下载或复制 `docker-compose.yml`
9. 拉取 `ekkoye8888/hermes-web-ui` 预构建镜像
10. 启动 `hermes-webui` 容器
11. 等待 Web UI 健康检查通过
12. 如设备时间未同步，自动尝试 `timesyncd` 校时；若仍失败，则对 `apt update` 使用日期校验兜底
13. 如 Docker 官方源或 GPG key 下载失败，自动回退到系统仓库安装 `docker.io`
14. 自动探测并配置可用的 Docker daemon 国内镜像源，并在需要时重启 Docker 使其生效
15. 如镜像源不可解析或拉取失败，自动移除 `registry-mirrors` 并回退直连 `docker.io`
16. 如预构建镜像拉取失败，自动尝试本地构建 `hermes-webui`

## 默认部署参数

脚本默认使用以下参数：

```bash
DEPLOY_DIR=/opt/hermes-web-ui
HERMES_DATA_DIR=/opt/hermes-web-ui/hermes_data
PORT=6060
WEBUI_IMAGE=ekkoye8888/hermes-web-ui
WEBUI_CONTAINER_NAME=hermes-webui
AUTH_DISABLED=false
REPO_REF=main
```

## 自定义部署参数

你可以在运行脚本前覆盖环境变量。

### 示例：修改端口和部署目录

```bash
sudo PORT=8080 DEPLOY_DIR=/data/hermes-web-ui HERMES_DATA_DIR=/data/hermes-web-ui/hermes_data ./scripts/deploy-armbian.sh
```

### 示例：关闭认证

```bash
sudo AUTH_DISABLED=true ./scripts/deploy-armbian.sh
```

### 示例：指定镜像版本

```bash
sudo WEBUI_IMAGE=ekkoye8888/hermes-web-ui:latest ./scripts/deploy-armbian.sh
```

### 示例：自定义 Docker 国内镜像源

脚本会先探测你传入的镜像源是否可用；不可用的镜像源会被自动跳过。如果全部不可用，脚本会自动移除 `registry-mirrors` 并回退直连 `docker.io`。如果你想换成自己的镜像源，可在执行时覆盖：

```bash
sudo DOCKER_REGISTRY_MIRRORS="https://your-mirror-1,https://your-mirror-2" ./scripts/deploy-armbian.sh
```

## 部署后目录结构

典型目录结构如下：

```text
/opt/hermes-web-ui
├─ .env
├─ docker-compose.yml
└─ hermes_data
   ├─ hermes-web-ui
   └─ ...
```

其中：

- `hermes_data` 用于持久化 Hermes 运行数据
- `hermes_data/hermes-web-ui` 用于持久化 Web UI 认证 Token 等数据

## 启动后访问地址

默认端口为 `6060`，部署完成后可访问：

```text
http://设备IP:6060
```

如果你在设备本机查看：

```text
http://127.0.0.1:6060
```

## 手动绑定 / 配置 Hermes

脚本不会自动完成绑定码或账号配置，这部分保留人工操作。

部署完成后，进入容器执行：

```bash
sudo docker exec -it hermes-webui /opt/hermes/.venv/bin/hermes setup
```

如需查看当前配置：

```bash
sudo docker exec -it hermes-webui /opt/hermes/.venv/bin/hermes config
```

## 常用运维命令

### 查看容器状态

```bash
cd /opt/hermes-web-ui
sudo docker compose ps
```

### 查看日志

```bash
cd /opt/hermes-web-ui
sudo docker compose logs -f hermes-webui
```

### 重启服务

```bash
cd /opt/hermes-web-ui
sudo docker compose restart
```

### 停止服务

```bash
cd /opt/hermes-web-ui
sudo docker compose down
```

### 查看认证 Token

如果开启认证，Token 通常保存在：

```bash
cat /opt/hermes-web-ui/hermes_data/hermes-web-ui/.token
```

如果文件还没生成，也可以从日志里找：

```bash
cd /opt/hermes-web-ui
sudo docker compose logs hermes-webui | grep token
```

## 开机自启

当前 `docker-compose.yml` 已设置：

```yaml
restart: unless-stopped
```

只要 Docker 服务开机自动启动，容器会随系统恢复运行。

脚本也会执行：

```bash
systemctl enable --now docker
```

## 排障建议

### 1. Web UI 无法打开

先检查容器是否启动：

```bash
cd /opt/hermes-web-ui
sudo docker compose ps
```

再看日志：

```bash
cd /opt/hermes-web-ui
sudo docker compose logs -f hermes-webui
```

### 2. 端口被占用

改端口重新部署：

```bash
sudo PORT=8080 ./scripts/deploy-armbian.sh
```

### 3. 拉镜像失败

检查网络是否能访问 Docker Hub：

```bash
sudo docker pull ekkoye8888/hermes-web-ui
```

### 4. 系统时间未同步，`apt update` 报 `Release file ... is not valid yet`

脚本已内置以下处理顺序：

1. 先正常执行 `apt-get update`
2. 失败后自动尝试：
   - `timedatectl set-ntp true`
   - `systemctl restart systemd-timesyncd`
3. 若系统时间仍未同步，则自动使用：

```bash
apt-get -o Acquire::Check-Date=false update
```

如果你想手动验证，可以执行：

```bash
date
timedatectl status
apt-get -o Acquire::Check-Date=false update
```

### 5. Docker 官方源 / GPG key 下载失败

如果设备访问 `download.docker.com` 不稳定，脚本会自动回退到系统仓库安装 Docker。

典型报错包括：

```text
curl: (35) Recv failure: Connection reset by peer
gpg: no valid OpenPGP data found.
```

脚本会自动尝试：

1. 官方 Docker 源安装
2. 若失败，则回退到系统仓库安装：
   - `docker.io`
   - `docker-compose-v2`
   - 或兼容的 `docker-compose-plugin` / `docker-compose`
3. 在回退前自动清理失败残留：
   - `/etc/apt/sources.list.d/docker.list`
   - `/etc/apt/keyrings/docker.asc`

如果你想手动验证系统仓库安装，也可以执行：

```bash
rm -f /etc/apt/sources.list.d/docker.list
rm -f /etc/apt/keyrings/docker.asc
apt-get -o Acquire::Check-Date=false update -y
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
docker version
docker compose version
```

### 6. Docker Hub 拉镜像超时

如果设备访问 `docker.io` 或 `registry-1.docker.io` 超时，脚本会自动尝试为 Docker daemon 写入国内镜像源：

- `https://hub-mirror.c.163.com`

脚本会：

1. 检查并创建 `/etc/docker/daemon.json`
2. 先探测镜像源是否可解析、可访问
3. 仅写入可用的 `registry-mirrors`
4. 自动重启 Docker
5. 再继续执行 `docker compose pull`

如果当前镜像源出现类似下面的错误：

```text
lookup hub-mirror.c.163.com: device or resource busy
```

脚本会自动：

1. 移除 `/etc/docker/daemon.json` 里的 `registry-mirrors`
2. 重启 Docker
3. 回退直连 `docker.io`
4. 重新尝试 `docker compose pull`
5. 如仍失败，再尝试 `docker compose build hermes-webui`

如果你想手动验证当前配置，可执行：

```bash
cat /etc/docker/daemon.json
systemctl restart docker
docker info | grep -A5 "Registry Mirrors"
```

如果你想手动移除坏掉的镜像源并回退直连，也可以执行：

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path("/etc/docker/daemon.json")
data = {}
if path.exists():
    data = json.loads(path.read_text(encoding="utf-8"))
data.pop("registry-mirrors", None)
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
systemctl restart docker
docker info | grep -A5 "Registry Mirrors"
```

当前默认没有使用 `daocloud`，因为在本项目镜像 `ekkoye8888/hermes-web-ui:latest` 的拉取链路上，已验证可能返回 `403 Forbidden`。

### 7. 预构建镜像拉取失败

如果 `docker compose pull` 失败，脚本会按以下顺序自动尝试：

1. 摘除可能失效的 Docker 镜像源并重试拉取
2. 若拉取仍失败，则尝试本地构建
3. 若本地构建仍因基础镜像拉取失败，则在直连 `docker.io` 模式下再次重试构建

自动执行的大致流程如下：

```bash
docker compose pull
# pull 失败时：
systemctl restart docker
docker compose pull
# 仍失败时：
docker compose build hermes-webui
docker compose up -d
```

如果你想手动执行，也可以运行：

```bash
cd /opt/hermes-web-ui
sudo docker compose build hermes-webui
sudo docker compose up -d
```

### 8. 想重置部署

```bash
cd /opt/hermes-web-ui
sudo docker compose down
sudo rm -rf /opt/hermes-web-ui
```

然后重新运行脚本。

## 设计说明

这套方案优先使用仓库当前已有的 `Docker Compose` 部署链路，而不是在板子上源码编译 Node/Python 环境，原因是：

- 对 ARM 设备更稳
- 依赖更少
- 更适合一键部署
- 便于后续重装、迁移和开机自启

对于需要人工完成的 Hermes 绑定码、账号接入或 Provider 配置，统一保留到容器内的 `hermes setup` 步骤处理。
