# BrightBot

<p align="center">
  <img src="public/brightbot-favicon.png" width="112" alt="BrightBot Logo" />
</p>

<p align="center">
  面向个人设备与服务器集群的 Web Agent 控制台。
</p>

<p align="center">
  <a href="https://github.com/BrightWeb-Dev-Team/BrightBot">源代码</a> ·
  <a href="https://blog.brightweb.top">官方论坛</a> ·
  <a href="https://github.com/BrightWeb-Dev-Team">BrightWeb Dev Team</a>
</p>

BrightBot 将 AI 对话、机器人渠道、网页终端、设备控制、远程桌面和多节点管理整合在同一个控制台中。主控负责认证、配置和任务调度，远程节点主动连接主控执行操作，无需向公网开放节点控制端口。

当前版本：`v1.1.0`

## 功能

- AI 对话：连接 OpenAI Chat Completions 兼容接口。
- 多机器人渠道：支持 QQ、微信 iLink 和飞书长连接。
- 设备控制：执行截图、命令、应用启动及常用系统操作。
- 网页终端：保留会话工作目录并提供命令历史。
- 远程桌面：使用 noVNC，通过 BrightBot 登录会话和一次性票据代理 VNC 流量。
- 多节点管理：一台主控管理多台 macOS 或 Linux 设备。
- Skills：导入或创建 Markdown 工作流，供 Agent 自动或手动调用。
- 定时任务：在控制台中管理周期性 Agent 任务。
- 统一认证：支持 BrightWeb OpenID Connect 和本机管理员账号。

## 技术栈

- React 19 + Vite
- Node.js + Express
- WebSocket
- noVNC
- OpenID Connect
- QQ、微信与飞书机器人 SDK

## 系统要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- macOS 或 Linux
- 可访问所配置的模型及机器人平台

Linux VNC 模式还需要 X11/Xorg。纯终端服务器可以只启用命令工具，不安装桌面环境。

## 快速开始

```bash
git clone https://github.com/BrightWeb-Dev-Team/BrightBot.git
cd BrightBot
cp .env.example .env
npm install
npm run build
npm start
```

默认访问地址：

```text
http://127.0.0.1:8787
```

首次打开时，页面会引导创建本机管理员账号。macOS 用户也可以直接运行：

```bash
./start.sh
```

或双击 `start.command`。

## 基础配置

编辑 `.env`：

```env
PORT=8787
HOST=127.0.0.1

LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=YOUR_API_KEY
LLM_MODEL=gpt-4o-mini

# 主控与远程节点共享的随机令牌
BRIGHTBOT_CONTROL_TOKEN=YOUR_RANDOM_CONTROL_TOKEN
```

生成控制令牌：

```bash
openssl rand -hex 32
```

模型、机器人和 BrightWeb OIDC 配置也可以在控制台中完成。运行数据保存在 `data/`，该目录不会提交到 Git。

## 生产部署

生产环境建议：

1. 将 `HOST` 设置为 `0.0.0.0`。
2. 使用 Caddy、Nginx 等反向代理提供 HTTPS。
3. 为 `.env` 设置 `600` 权限。
4. 使用 systemd 或其他进程管理器运行 BrightBot。
5. 只向可信网络开放控制台。

仓库提供以下服务模板：

- `release/brightbot.service`：标准主控服务。
- `release/brightbot-cli.service`：Linux 纯终端服务。
- `release/brightbot-node.service`：Linux 远程节点。
- `release/com.brightbot.node.plist`：macOS 远程节点模板。

完整说明参见 [DEPLOY.md](DEPLOY.md)。

## 接入远程节点

在主控 `.env` 中设置：

```env
HOST=0.0.0.0
BRIGHTBOT_CONTROL_TOKEN=YOUR_RANDOM_CONTROL_TOKEN
```

在远程节点部署同一仓库，并设置：

```env
BRIGHTBOT_MODE=node
BRIGHTBOT_MASTER_URL=https://YOUR_BRIGHTBOT_SERVER
BRIGHTBOT_CONTROL_TOKEN=YOUR_RANDOM_CONTROL_TOKEN
BRIGHTBOT_NODE_ID=server-2
BRIGHTBOT_NODE_NAME=业务服务器-2
```

启动节点：

```bash
npm install --omit=dev
npm run start:node
```

每台设备的 `BRIGHTBOT_NODE_ID` 必须唯一。节点通过出站请求连接主控，通常不需要开放节点入站端口。

详细步骤参见 [BrightBot 子节点接入文档](docs/BrightBot子节点接入文档.md)。

## 远程桌面

BrightBot 内置 noVNC 客户端和 WebSocket-to-VNC 代理。VNC 服务应仅监听节点本机：

```env
BRIGHTBOT_VNC_HOST=127.0.0.1
BRIGHTBOT_VNC_PORT=5900
```

### macOS

在“系统设置 → 通用 → 共享”中开启“屏幕共享”，然后在 BrightBot 的远程桌面页面输入 macOS 屏幕共享凭据。

### Linux 图形桌面

安装项目内 VNC：

```bash
sudo npm run vnc:install
```

安装脚本会配置 `x11vnc`，并在未指定密码时生成随机 VNC 密码。也可以预先设置：

```bash
sudo BRIGHTBOT_VNC_PASSWORD='YOUR_STRONG_PASSWORD' npm run vnc:install
```

Wayland 环境应切换到 X11/Xorg 会话，或将 BrightBot 指向现有 VNC 服务。

### Linux 纯终端

不需要桌面和 VNC 时，按 [Linux 纯终端部署说明](INSTALL-LINUX-CLI.md) 安装，通过“命令工具”管理服务器。

## 开发

安装依赖并启动前后端开发服务：

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

运行测试：

```bash
node --test tests/*.test.js
```

## 目录结构

```text
src/                 React 控制台
server/              API、节点客户端和 VNC 代理
scripts/             安装脚本
release/             systemd 与 LaunchAgent 模板
docs/                接入文档
tests/               自动化测试
public/              品牌静态资源
vendor/              随项目分发的第三方适配代码
```

## 安全提示

- 不要提交 `.env`、`data/`、访问令牌或机器人密钥。
- 主控和节点应使用同一个高强度随机控制令牌。
- VNC 端口应保持在 `127.0.0.1`，远程访问统一经过 BrightBot。
- 公网部署必须启用 HTTPS。
- 定期备份 `data/` 并限制其文件权限。

## 社区与支持

- 官方论坛：[blog.brightweb.top](https://blog.brightweb.top)
- 问题反馈：[GitHub Issues](https://github.com/BrightWeb-Dev-Team/BrightBot/issues)
- 开发团队：[BrightWeb Dev Team](https://github.com/BrightWeb-Dev-Team)

## 许可证

BrightBot 使用 [BrightWeb Community License 1.0](LICENSE)。允许使用、修改、发布及分发，但必须保留许可证、版权声明和用户界面中的可见署名。

第三方组件继续遵循各自的许可证。

---

Powered By [BrightWeb Dev Team](https://github.com/BrightWeb-Dev-Team) [BrightBot-v1.1.0](https://github.com/BrightWeb-Dev-Team/BrightBot)
