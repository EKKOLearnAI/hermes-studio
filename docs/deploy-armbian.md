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

如果你想手动验证系统仓库安装，也可以执行：

```bash
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
docker version
docker compose version
```

### 6. 想重置部署

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
