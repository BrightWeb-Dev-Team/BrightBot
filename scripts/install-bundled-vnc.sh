#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VNC_PASSWORD="${BRIGHTBOT_VNC_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) TARGET_ARCH="x64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *) echo "Unsupported Linux architecture: $ARCH"; exit 1 ;;
esac

DEST="$ROOT_DIR/vendor/vnc/linux-$TARGET_ARCH"
PACKAGES="$DEST/packages"
mkdir -p "$PACKAGES"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Run this installer on the target Linux machine."
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root so it can install desktop dependencies and services."
  exit 1
fi

if command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y x11vnc xvfb openbox xterm dbus-x11
  cd "$PACKAGES"
  apt-get download x11vnc
  for package in ./*.deb; do dpkg-deb -x "$package" "$DEST"; done
elif command -v dnf >/dev/null 2>&1 && command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then
  dnf install -y x11vnc xorg-x11-server-Xvfb openbox xterm dbus-x11
  cd "$PACKAGES"
  dnf download --resolve --alldeps --destdir "$PACKAGES" x11vnc
  for package in ./*.rpm; do (cd "$DEST" && rpm2cpio "$package" | cpio -idm --quiet); done
else
  echo "Supported installers: apt/dpkg-deb or dnf/rpm2cpio/cpio."
  exit 1
fi

BINARY="$(find "$DEST" -type f -path '*/bin/x11vnc' -print -quit)"
if [[ -z "$BINARY" ]]; then
  echo "x11vnc binary was not found after extraction."
  exit 1
fi
chmod +x "$BINARY"

ENV_FILE="$ROOT_DIR/.env"
touch "$ENV_FILE"
sed -i '/^BRIGHTBOT_VNC_/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF

BRIGHTBOT_VNC_PASSWORD=$VNC_PASSWORD
BRIGHTBOT_VNC_DISPLAY=:0
BRIGHTBOT_VNC_XAUTHORITY=/dev/null
BRIGHTBOT_VNC_AUTO_START=true
EOF
chmod 600 "$ENV_FILE"

if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/brightbot-desktop.service <<EOF
[Unit]
Description=BrightBot Command Line Desktop
After=network.target
Before=brightbot.service

[Service]
Type=simple
Environment=DISPLAY=:0
ExecStart=/usr/bin/Xvfb :0 -screen 0 1280x720x16 -nolisten tcp -ac
ExecStartPost=/bin/sh -c "sleep 1; DISPLAY=:0 dbus-launch --exit-with-session openbox-session >/var/log/brightbot-openbox.log 2>&1 & sleep 2; DISPLAY=:0 xterm -maximized -fa Monospace -fs 16 -bg black -fg white -title BrightBot-Terminal -e /bin/bash -l >/var/log/brightbot-xterm.log 2>&1 &"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now brightbot-desktop.service
fi

echo "Bundled VNC installed: $BINARY"
echo "Command-line desktop installed on DISPLAY=:0."
echo "VNC password: $VNC_PASSWORD"
echo "Restart BrightBot to start VNC on 127.0.0.1:5900."

