# Desktop Environment Startup (XFCE + VNC + Chrome CDP)

This setup recreates the current EC2 desktop environment using systemd.

## What This Installs

- Xvfb virtual display on :1
- XFCE session on that display
- x11vnc server on port 5900
- Google Chrome with persistent CDP on port 9222
- nanoclaw systemd user service

## Install

Run the setup script from the repo root:

```bash
sudo bash scripts/setup-desktop.sh
```

The script creates an empty `/home/ubuntu/nanoclaw/.env` if it does not exist.
Add your secrets there before starting nanoclaw.

## VNC Password

Create a VNC password for x11vnc:

```bash
sudo -u ubuntu vncpasswd
```

The password is stored in `/home/ubuntu/.vnc/passwd`.

## Verify Services

System services:

```bash
systemctl status persistent-desktop.service xfce-desktop.service x11vnc.service
```

User services:

```bash
sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/$(id -u ubuntu) systemctl --user status chrome-cdp.service nanoclaw.service
```

Check Chrome CDP:

```bash
curl http://localhost:9222/json/version
```

## Notes

- VNC: connect to `<server-ip>:5900`.
- CDP: available on port 9222.
- If the user services do not start, verify linger is enabled:

```bash
loginctl show-user ubuntu | grep Linger
```
