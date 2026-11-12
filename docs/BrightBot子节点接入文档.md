# BrightBot 子节点接入文档

本文用于将一台 Linux 服务器作为子节点接入 BrightBot 主控。接入后，主控端的 AI、网页终端和状态面板可以操作该服务器。

## 1. 接入信息

```text
主控地址：https://server.brightweb.top
节点 ID：server-3
节点名称：A区服务器
运行模式：node
```

注意：每台子节点的 `BRIGHTBOT_NODE_ID` 必须唯一。当前 `server-2` 已被其他设备使用，因此本文使用 `server-3`。

## 2. 环境要求

- Linux 服务器，推荐 Ubuntu 22.04 或更高版本
- Node.js 20 或更高版本
- 可以访问 `https://server.brightweb.top`
- 具备 root 或 sudo 权限
- 已取得 `BrightBot-1.1.0-deploy.tar.gz` 部署包

检查 Node.js：

```bash
node -v
npm -v
```

## 3. 安装程序

将部署包上传到服务器后执行：

```bash
mkdir -p /opt/brightbot
tar -xzf BrightBot-1.1.0-deploy.tar.gz -C /opt/brightbot
cd /opt/brightbot

npm install --allow-remote=all --dangerously-allow-all-scripts
```

## 4. 配置子节点

创建配置文件：

```bash
nano /opt/brightbot/.env
```

写入以下内容：

```env
BRIGHTBOT_MODE=node
BRIGHTBOT_MASTER_URL=https://server.brightweb.top
BRIGHTBOT_CONTROL_TOKEN=CHANGE_ME_TO_THE_SHARED_CONTROL_TOKEN
BRIGHTBOT_NODE_ID=server-3
BRIGHTBOT_NODE_NAME=A区服务器
```

保存后限制配置文件权限：

```bash
chmod 600 /opt/brightbot/.env
```

共享令牌相当于节点接入凭据，不应发布到公开仓库、群聊或公开网页。

## 5. 测试连接

在前台启动子节点：

```bash
cd /opt/brightbot
npm run start:node
```

出现以下日志表示客户端已启动：

```text
[BrightBot Node] A区服务器 (server-3) -> https://server.brightweb.top
```

保持进程运行，然后登录主控控制台：

```text
https://server.brightweb.top
```

进入“设备 → 设备节点”，确认“A区服务器”显示为在线。

测试完成后按 `Ctrl+C` 结束前台进程，再配置后台服务。

## 6. 配置 systemd 后台服务

复制服务文件：

```bash
cp /opt/brightbot/release/brightbot-node.service \
  /etc/systemd/system/brightbot-node.service
```

加载并启动服务：

```bash
systemctl daemon-reload
systemctl enable --now brightbot-node
```

查看服务状态：

```bash
systemctl status brightbot-node
```

查看实时日志：

```bash
journalctl -u brightbot-node -f
```

重启服务：

```bash
systemctl restart brightbot-node
```

## 7. 在主控端使用

1. 打开 `https://server.brightweb.top`。
2. 登录 BrightBot 控制台。
3. 进入“设备 → 设备节点”。
4. 确认“A区服务器”处于在线状态。
5. 使用顶部设备选择器选中“A区服务器”。
6. 进入“命令工具”执行 `hostname` 或 `uname -a` 验证远程执行。
7. 进入 AI 对话后，Agent 操作会发送到当前选中的服务器。

## 8. 修改节点名称

编辑 `/opt/brightbot/.env`：

```env
BRIGHTBOT_NODE_NAME=新的服务器名称
```

然后重启：

```bash
systemctl restart brightbot-node
```

主控会在下一次心跳后显示新名称。

## 9. 升级子节点

先备份配置：

```bash
cp /opt/brightbot/.env /root/brightbot-node.env.backup
```

停止服务并解压新版本：

```bash
systemctl stop brightbot-node
tar -xzf BrightBot-新版本-deploy.tar.gz -C /opt/brightbot
cd /opt/brightbot
npm install --allow-remote=all --dangerously-allow-all-scripts
systemctl restart brightbot-node
```

## 10. 常见问题

### 节点没有出现在控制台

检查服务日志：

```bash
journalctl -u brightbot-node -n 100 --no-pager
```

检查主控连通性：

```bash
curl -fsS https://server.brightweb.top/api/health
```

正常情况下会返回：

```json
{"ok":true,"time":"..."}
```

### 提示节点令牌无效

检查 `.env` 中的令牌是否完整，并确认没有多余空格：

```env
BRIGHTBOT_CONTROL_TOKEN=CHANGE_ME_TO_THE_SHARED_CONTROL_TOKEN
```

修改后执行：

```bash
systemctl restart brightbot-node
```

### 节点 ID 冲突

每台设备必须使用不同的 ID，例如：

```text
server-3
server-4
server-5
```

修改 `BRIGHTBOT_NODE_ID` 后重启服务。

### 服务不断重启

确认 Node.js 路径和版本：

```bash
command -v node
node -v
journalctl -u brightbot-node -n 100 --no-pager
```

### 防火墙要求

子节点采用主动连接主控的方式，通常只需要允许出站 HTTPS 访问 `server.brightweb.top:443`，不需要为 BrightBot 开放子节点入站端口。

## 11. 停用子节点

停止并关闭自动启动：

```bash
systemctl disable --now brightbot-node
```

如需清理离线记录，可在主控端“设备节点”页面移除该节点。
