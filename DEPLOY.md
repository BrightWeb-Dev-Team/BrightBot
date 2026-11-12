# BrightBot 部署说明

## 环境要求

- macOS 或 Linux
- Node.js 20 或更高版本
- 可访问 npm、模型服务及已配置的机器人平台

## 一键启动

macOS：双击 `start.command`。

终端：

```bash
./start.sh
```

脚本会自动安装依赖、构建前端、启动服务并打开：

```text
http://127.0.0.1:8787
```

首次进入必须创建本机管理员账号。BrightWeb 统一认证可以在初始化页面配置，也可以稍后在“配置文件”中填写。

## BrightWeb 回调地址

本机部署：

```text
http://127.0.0.1:8787/api/auth/brightweb/callback
```

公网部署应改为实际 HTTPS 域名，例如：

```text
https://example.com/api/auth/brightweb/callback
```

BrightWeb 登录白名单支持邮箱、用户名或用户 `sub` ID，每行一个或使用逗号分隔。白名单为空时，统一认证用户全部禁止登录。

## 自定义端口

```bash
PORT=9000 ./start.sh
```

## Linux 内置远程桌面

BrightBot 已内置 noVNC 网页客户端和 VNC WebSocket 代理。Linux 主控可以把
`x11vnc` 安装到项目目录，不需要将 VNC 程序安装到系统路径：

```bash
cd /opt/brightbot
npm run vnc:install
```

程序会放到 `vendor/vnc/linux-x64` 或 `vendor/vnc/linux-arm64`。在 `.env` 中配置：

```env
BRIGHTBOT_VNC_PASSWORD=请设置独立的强密码
BRIGHTBOT_VNC_DISPLAY=:0
# 按桌面用户的实际路径填写；自动探测失败时需要设置
BRIGHTBOT_VNC_XAUTHORITY=/home/desktop-user/.Xauthority
BRIGHTBOT_VNC_AUTO_START=true
```

重启 BrightBot 后，项目内 VNC 默认只监听 `127.0.0.1:5900`，外部访问统一经过
BrightBot 登录认证和一次性 WebSocket 票据。远程桌面页面也可以手动启动内置 VNC。

内置服务共享现有 X11 桌面。使用 Wayland 的 Linux 桌面需要在登录界面选择 X11/Xorg
会话，或配置 `BRIGHTBOT_VNC_HOST`、`BRIGHTBOT_VNC_PORT` 指向本机已有的 VNC 服务。

## 数据目录

运行后配置、日志、Skills 和对话数据保存在 `data/`。备份部署时只需备份该目录。

## 一台主控管理多台服务器

主控端保存模型、机器人和登录配置，远程节点只负责执行状态查询、终端命令及系统操作。节点主动连接主控，因此节点侧无需开放控制端口。

远程桌面支持顶部设备选择器中的在线节点。浏览器连接主控后，节点会主动建立一次性
VNC 隧道并连接节点自己的 `127.0.0.1:5900`，防火墙无需开放 VNC 入站端口。

1. 生成共享令牌：

```bash
openssl rand -hex 32
```

2. 在主控端 `.env` 中配置并启动：

```bash
HOST=0.0.0.0
BRIGHTBOT_CONTROL_TOKEN=生成的令牌
```

建议通过 HTTPS 反向代理发布主控地址，只向可信网络开放。控制台顶部的设备选择器可在主控本机和所有在线节点之间切换。

3. 在第二、第三台服务器部署相同目录，并分别配置：

```bash
BRIGHTBOT_MODE=node
BRIGHTBOT_MASTER_URL=https://主控域名
BRIGHTBOT_CONTROL_TOKEN=与主控相同的令牌
BRIGHTBOT_NODE_ID=server-2
BRIGHTBOT_NODE_NAME=业务服务器-2
```

第三台服务器将 `BRIGHTBOT_NODE_ID` 和 `BRIGHTBOT_NODE_NAME` 改成唯一值，然后运行：

```bash
./start.sh
```

也可直接运行 `npm run start:node`。生产环境建议为主控和每个节点分别配置 systemd，使进程异常退出后自动重启。
