# 部署排障速查

这份文档用于现场快速定位 `hermes-web-ui` 部署问题，优先提供可直接复制执行的命令。

适用范围：

- `scripts/deploy-source-armbian.sh`
- `scripts/deploy-armbian.sh`

## 快速分流

先判断你走的是哪条部署路径：

- 源码部署：`systemd` 托管 `hermes-web-ui.service`
- Docker 部署：`docker compose` 托管 `hermes-webui` 容器

如果你不确定，先执行：

```bash
sudo systemctl status hermes-web-ui.service --no-pager -l || true
cd /opt/hermes-web-ui && sudo docker compose ps || true
```

## 通用快速检查

### 系统时间、磁盘、端口

```bash
date
timedatectl status || true
df -h
free -h
ss -lntp | grep 6060 || true
```

### 基础网络

```bash
ip a
ip route
ping -c 1 1.1.1.1 || true
curl -I http://127.0.0.1:6060/health || true
```

### 最近失败日志

```bash
sudo journalctl -n 200 --no-pager | tail -n 80
```

## 源码部署排查

源码部署由 `systemd` 管理，关键对象是：

- `hermes-web-ui.service`
- `/etc/default/hermes-web-ui`
- `/home/hermesui/.local/bin/hermes`
- `/tmp/hermes-agent-bridge.sock`

### 1. 检查服务状态

```bash
sudo systemctl status hermes-web-ui.service --no-pager -l
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager
```

### 2. 检查运行环境

```bash
cat /etc/default/hermes-web-ui
systemctl cat hermes-web-ui.service
ls -lah /opt/hermes-web-ui/dist
ls -lah /opt/hermes-web-ui/dist/server
```

### 3. 检查 Hermes 安装归属

```bash
sudo -u hermesui -H ls -lah /home/hermesui/.local/bin/hermes
sudo -u hermesui -H head -n 1 /home/hermesui/.local/bin/hermes
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes version
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data /home/hermesui/.local/bin/hermes doctor
```

### 4. 检查 agent bridge

```bash
sudo -u hermesui -H ls -lah /tmp/hermes-agent-bridge.sock
sudo journalctl -u hermes-web-ui.service -n 200 --no-pager | grep -E "agent bridge|run_agent|ENOENT" || true
```

### 5. 页面能开但聊天失败

如果你看到以下任一现象：

- `agent bridge exited before ready`
- `RuntimeError: hermes-agent run_agent.py not found`
- `ENOENT /tmp/hermes-agent-bridge.sock`
- `/home/hermesui/.local/bin/hermes` 指向 `/root/.local/...`

优先按下面顺序修复：

```bash
sudo systemctl stop hermes-web-ui.service
sudo rm -rf /home/hermesui/.hermes/hermes-agent
sudo rm -rf /home/hermesui/.local/share/uv/tools/hermes-agent
sudo rm -f /home/hermesui/.local/bin/hermes
sudo rm -rf /root/.local/share/uv/tools/hermes-agent
sudo rm -f /root/.local/bin/hermes
sudo apt-get update -y
sudo apt-get install -y ripgrep ffmpeg build-essential python3-dev libffi-dev
sudo -u hermesui -H env HERMES_HOME=/opt/hermes-web-ui/hermes_data sh -c 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | sh -s -- --skip-setup --skip-browser'
sudo systemctl restart hermes-web-ui.service
```

## Docker 部署排查

Docker 部署的关键对象是：

- `/opt/hermes-web-ui/.env`
- `/opt/hermes-web-ui/docker-compose.yml`
- `hermes-webui` 容器

### 1. 检查容器状态

```bash
cd /opt/hermes-web-ui
sudo docker compose ps
sudo docker compose logs --tail=200 hermes-webui
```

### 2. 检查 Docker 服务

```bash
sudo systemctl status docker --no-pager -l
sudo docker version
sudo docker compose version
```

### 3. 检查镜像源与拉取能力

```bash
cat /etc/docker/daemon.json || true
sudo docker info | grep -A5 "Registry Mirrors" || true
sudo docker pull ekkoye8888/hermes-web-ui || true
```

### 4. 手动回退直连 docker.io

```bash
sudo python3 - <<'PY'
import json
from pathlib import Path

path = Path("/etc/docker/daemon.json")
data = {}
if path.exists():
    data = json.loads(path.read_text(encoding="utf-8"))
data.pop("registry-mirrors", None)
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
sudo systemctl restart docker
sudo docker info | grep -A5 "Registry Mirrors" || true
```

### 5. 健康检查

```bash
curl -I http://127.0.0.1:6060/health || true
cd /opt/hermes-web-ui
sudo docker compose logs hermes-webui | grep -i "health\\|token\\|error" || true
```

## 常见失败模式

### `apt update` 提示 `Release file ... is not valid yet`

```bash
date
timedatectl status || true
sudo timedatectl set-ntp true || true
sudo systemctl restart systemd-timesyncd || true
sudo apt-get -o Acquire::Check-Date=false update
```

### Node 下载失败

```bash
sudo NODE_MIRROR_URL=https://npmmirror.com/mirrors/node ./scripts/deploy-source-armbian.sh
```

### Hermes 安装脚本下载失败

```bash
sudo HERMES_INSTALLER_MIRROR=https://your-mirror/install.sh ./scripts/deploy-source-armbian.sh
```

### npm 安装慢或失败

```bash
sudo -u hermesui -H cat /home/hermesui/.npmrc
sudo -u hermesui -H env PATH=/opt/node-v23/bin:$PATH npm config get registry
```

## 重部署命令

### 源码部署重跑

如果你是本地源码包部署，不要使用 `git pull`。标准流程是重新打包、重新上传、重新解压，再执行脚本。

远端最小重跑命令：

```bash
sudo systemctl stop hermes-web-ui.service || true
sudo rm -rf /opt/hermes-web-ui
sudo mkdir -p /opt
sudo tar -xzf /tmp/hermes-web-ui-src.tar.gz -C /opt
cd /opt/hermes-web-ui
chmod +x scripts/deploy-source-armbian.sh
sudo ./scripts/deploy-source-armbian.sh
```

### Docker 部署重跑

```bash
cd /opt/hermes-web-ui
sudo docker compose down
sudo ./scripts/deploy-armbian.sh
```

## 相关文档

- [源码部署指南](./deploy-source-armbian.md)
- [Docker 部署指南](./deploy-armbian.md)
- [历史排障记录](./work-log.md)
