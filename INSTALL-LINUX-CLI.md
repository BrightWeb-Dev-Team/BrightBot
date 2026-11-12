# BrightBot Linux 纯终端部署

此部署模式不安装 X11、桌面环境、VNC 或图形终端。服务器操作通过 BrightBot
控制台中的“命令工具”完成。

```bash
tar -xzf BrightBot-1.1.0-linux-terminal.tar.gz
sudo mkdir -p /opt/brightbot
sudo cp -a brightbot/. /opt/brightbot/
cd /opt/brightbot
sudo npm install --omit=dev
sudo cp release/brightbot-cli.service /etc/systemd/system/brightbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now brightbot.service
```

服务默认监听 `0.0.0.0:8787`。生产环境应通过 HTTPS 反向代理访问。
