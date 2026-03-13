#!/usr/bin/env bash

set -euo pipefail

ENABLE_SLACK_SETUP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slack)
      ENABLE_SLACK_SETUP=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Guard: ensure we run from repository root so relative paths work
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

USER_NAME="ubuntu"
USER_HOME="/home/ubuntu"
SYSTEMD_SYSTEM_DIR="/etc/systemd/system"
SYSTEMD_USER_DIR="${USER_HOME}/.config/systemd/user"
ENV_FILE="${USER_HOME}/nanoclaw/.env"
VNC_PASSWD="${USER_HOME}/.vnc/passwd"
REMOTE_DESKTOP_PASSWORD="password"
XRDP_CONFIG_DIR="/etc/xrdp"
XRDP_INI="${XRDP_CONFIG_DIR}/xrdp.ini"
XRUNTIME_DIR="/run/user/$(id -u "${USER_NAME}")"
NODE_MAJOR="22"

# SUDO for top-level privileged commands (empty if already root)
if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

# SUDO_U for user-switching (always required, even when root)
SUDO_U="sudo -u ${USER_NAME}"

${SUDO} apt-get update
${SUDO} apt-get install -y \
  ca-certificates \
  curl \
  dbus-x11 \
  gpg \
  python3 \
  python3-venv \
  xrdp \
  x11vnc \
  xserver-xorg-video-dummy \
  xfce4 \
  xfce4-goodies \
  xvfb

${SUDO} install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi

${SUDO} tee /etc/apt/sources.list.d/nodesource.list > /dev/null << EOF
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF

if [[ ! -f /etc/apt/keyrings/google-chrome.gpg ]]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
fi

${SUDO} tee /etc/apt/sources.list.d/google-chrome.list > /dev/null << 'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main
EOF

${SUDO} apt-get update
${SUDO} apt-get install -y google-chrome-stable nodejs

# Ensure ubuntu user is in docker group for nanoclaw.service
if getent group docker >/dev/null 2>&1; then
  if ! id -nG "${USER_NAME}" | grep -qw docker; then
    ${SUDO} usermod -aG docker "${USER_NAME}"
    echo "Added ${USER_NAME} to docker group. Note: A logout/login may be needed for this to take effect." >&2
  fi
fi

${SUDO} install -m 0644 scripts/systemd/persistent-desktop.service "${SYSTEMD_SYSTEM_DIR}/persistent-desktop.service"

# Install xfce-desktop.service with dynamic UID substitution
${SUDO} tee "${SYSTEMD_SYSTEM_DIR}/xfce-desktop.service" > /dev/null << EOF
[Unit]
Description=XFCE Desktop on Virtual Display
After=persistent-desktop.service
Requires=persistent-desktop.service

[Service]
Type=simple
User=ubuntu
Environment="DISPLAY=:1"
Environment="XAUTHORITY=/home/ubuntu/.Xauthority"
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Install x11vnc.service
${SUDO} tee "${SYSTEMD_SYSTEM_DIR}/x11vnc.service" > /dev/null << EOF
[Unit]
Description=X11VNC Server for Virtual Display
After=xfce-desktop.service
Requires=xfce-desktop.service

[Service]
Type=simple
User=ubuntu
Environment="DISPLAY=:1"
Environment="XAUTHORITY=/home/ubuntu/.Xauthority"
ExecStart=/usr/bin/x11vnc -display :1 -forever -shared -rfbport 5900 -rfbauth ${VNC_PASSWD}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Configure xrdp to proxy into the shared x11vnc desktop
${SUDO} install -d -m 0755 "${XRDP_CONFIG_DIR}"
${SUDO} tee "${XRDP_INI}" > /dev/null << EOF
[Globals]
ini_version=1
fork=true
port=3389
use_vsock=false
tcp_nodelay=true
tcp_keepalive=true
security_layer=negotiate
crypt_level=high
bitmap_cache=true
bitmap_compression=true
max_bpp=24
xserverbpp=24
new_cursors=false
autorun=shared-vnc

[Logging]
LogFile=xrdp.log
LogLevel=INFO
EnableSyslog=true
SyslogLevel=INFO

[Channels]
rdpdr=true
rdpsnd=true
drdynvc=true
cliprdr=true
rail=true
xrdpvr=true
tcutils=true

[shared-vnc]
name=Shared Desktop
lib=libvnc.so
ip=127.0.0.1
port=5900
username=na
password=${REMOTE_DESKTOP_PASSWORD}
xserverbpp=24
delay_ms=2000
enable_dynamic_resizing=false
EOF

${SUDO_U} mkdir -p "${SYSTEMD_USER_DIR}"
${SUDO_U} install -m 0644 scripts/systemd/chrome-cdp.service "${SYSTEMD_USER_DIR}/chrome-cdp.service"
${SUDO_U} install -m 0644 scripts/systemd/nanoclaw.service "${SYSTEMD_USER_DIR}/nanoclaw.service"

${SUDO_U} mkdir -p "${USER_HOME}/.vnc"
${SUDO_U} x11vnc -storepasswd "${REMOTE_DESKTOP_PASSWORD}" "${VNC_PASSWD}" > /dev/null
${SUDO_U} chmod 600 "${VNC_PASSWD}"

if [[ ! -f "${ENV_FILE}" ]]; then
  ${SUDO_U} mkdir -p "$(dirname "${ENV_FILE}")"
  ${SUDO_U} touch "${ENV_FILE}"
  echo "Warning: ${ENV_FILE} created empty. Add your secrets before starting nanoclaw." >&2
fi

${SUDO_U} npm install
if [[ "${ENABLE_SLACK_SETUP}" == "true" ]]; then
  ${SUDO} env LOG_LEVEL=debug ./node_modules/.bin/tsx scripts/setup-server/index.ts slack --env-file "${ENV_FILE}"
  ${SUDO} chown -R "${USER_NAME}:${USER_NAME}" "${REPO_ROOT}/logs"
  ${SUDO} chown "${USER_NAME}:${USER_NAME}" "${ENV_FILE}"
fi
${SUDO_U} npm run build

${SUDO} loginctl enable-linger "${USER_NAME}"

# Wait for user manager to start after enabling linger
USER_MANAGER_READY=false
for i in {1..30}; do
  if ${SUDO_U} XDG_RUNTIME_DIR="${XRUNTIME_DIR}" systemctl --user daemon-reload 2>/dev/null; then
    USER_MANAGER_READY=true
    break
  fi
  sleep 0.5
done

if [[ "${USER_MANAGER_READY}" != "true" ]]; then
  echo "Error: User manager for ${USER_NAME} failed to start after enabling linger. Check system logs." >&2
  exit 1
fi

${SUDO} systemctl daemon-reload
${SUDO} systemctl enable --now persistent-desktop.service xfce-desktop.service x11vnc.service xrdp.service xrdp-sesman.service

${SUDO_U} XDG_RUNTIME_DIR="${XRUNTIME_DIR}" systemctl --user daemon-reload
${SUDO_U} XDG_RUNTIME_DIR="${XRUNTIME_DIR}" systemctl --user enable --now chrome-cdp.service nanoclaw.service

echo "Setup complete."
