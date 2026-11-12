# Bundled Linux VNC

Run `npm run vnc:install` as root on the target Linux host. The installer adds
Xvfb, Openbox and a full-screen xterm command-line desktop, extracts `x11vnc`
into `vendor/vnc/linux-x64` or `vendor/vnc/linux-arm64`, and registers the
virtual desktop as a system service. BrightBot starts VNC on `127.0.0.1:5900`.

Configure `.env`:

```env
BRIGHTBOT_VNC_PASSWORD=change-this-password
BRIGHTBOT_VNC_DISPLAY=:0
BRIGHTBOT_VNC_XAUTHORITY=/home/user/.Xauthority
```

The bundled server shares an X11 desktop. On Wayland, log in with an X11
session or point `BRIGHTBOT_VNC_HOST` and `BRIGHTBOT_VNC_PORT` at another local
VNC server.
