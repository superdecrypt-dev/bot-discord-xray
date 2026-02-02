#!/usr/bin/env bash
set -euo pipefail
trap 'echo "[ERROR] Failed at line $LINENO: $BASH_COMMAND" >&2' ERR

# ============================================================
# XRAY DISCORD BOT INSTALLER (TAR.GZ from GitHub Releases)
# - Default asset: bot-discord-xray.tar.gz
# - Default URL   : https://github.com/superdecrypt-dev/bot-discord-xray/releases/latest/download/bot-discord-xray.tar.gz
# - No SHA256 verification (by request)
#
# Bundle tar.gz is expected to contain a root folder (recommended) like:
#   bot-discord-xray/
#     backend/  (backend.py + xray_backend/)
#     bot/      (bot.js + package.json + src/)
#
# Clean Architecture:
#   - Python backend runs as root (system access + Xray config edits)
#   - Node.js bot runs as non-root user 'discordbot' (UI only)
#
# Uninstall DOES NOT touch:
#   /opt/quota/*  and  /opt/{vless,vmess,trojan,allproto}/*
# ============================================================

SCRIPT_NAME="install-xray-bot.sh"

# -------- Default Release Asset URL (repo baru) --------
DEFAULT_TAR_URL="https://github.com/superdecrypt-dev/bot-discord-xray/releases/latest/download/bot-discord-xray.tar.gz"

# -------- Paths --------
BACKEND_DIR="/opt/xray-backend"
BOT_DIR="/opt/xray-discord-bot"

ENV_DIR="/etc/xray-discord-bot"
ENV_FILE="${ENV_DIR}/env"
SOURCE_FILE="${ENV_DIR}/source.conf"

XRAY_CONFIG="/usr/local/etc/xray/config.json"
XRAY_SERVICE="xray"

BOT_USER="discordbot"
CLI_BIN="/usr/local/bin/xray-userctl"

BACKEND_SERVICE_FILE="/etc/systemd/system/xray-backend.service"
BOT_SERVICE_FILE="/etc/systemd/system/xray-discord-bot.service"

# -------- Helpers --------
info(){ echo "[INFO]  $*"; }
ok(){   echo "[OK]    $*"; }
warn(){ echo "[WARN]  $*"; }
die(){  echo "[ERROR] $*" >&2; exit 1; }

pause(){
  echo
  read -r -p "Press Enter to continue..." _ || true
}

require_root(){
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Run as root: sudo bash ${SCRIPT_NAME}"
}

detect_os(){
  [[ -f /etc/os-release ]] || die "Cannot detect OS: /etc/os-release not found"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian)
      case "${VERSION_ID:-}" in
        11|12) ok "Detected OS: Debian ${VERSION_ID}" ;;
        *) die "Unsupported Debian version: ${VERSION_ID} (supported: 11/12)" ;;
      esac
      ;;
    ubuntu)
      case "${VERSION_ID:-}" in
        20.04|22.04|24.04) ok "Detected OS: Ubuntu ${VERSION_ID}" ;;
        *) die "Unsupported Ubuntu version: ${VERSION_ID} (supported: 20.04/22.04/24.04)" ;;
      esac
      ;;
    *)
      die "Unsupported OS: ${ID:-unknown} (supported: Debian 11/12, Ubuntu 20.04/22.04/24.04)"
      ;;
  esac
}

apt_install_base(){
  export DEBIAN_FRONTEND=noninteractive
  info "Installing base dependencies (python3, curl, ca-certificates, rsync, tar)..."
  apt-get update -y >/dev/null
  apt-get install -y python3 curl ca-certificates rsync tar >/dev/null
  ok "Base dependencies installed"
}

ensure_xray_present(){
  [[ -f "${XRAY_CONFIG}" ]] || die "Missing Xray config: ${XRAY_CONFIG}. Installer will NOT create it."
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (requires systemd)"
  systemctl cat "${XRAY_SERVICE}" >/dev/null 2>&1 || die "Missing systemd service: ${XRAY_SERVICE}.service"
  ok "Xray OK: config exists + systemd service exists"
}

ensure_bot_user(){
  if ! id "${BOT_USER}" >/dev/null 2>&1; then
    useradd -r -m -d "/home/${BOT_USER}" -s /bin/bash "${BOT_USER}"
    ok "Created user: ${BOT_USER}"
  else
    ok "User exists: ${BOT_USER}"
  fi

  # Ensure group exists
  if ! getent group "${BOT_USER}" >/dev/null 2>&1; then
    groupadd "${BOT_USER}" || true
  fi

  usermod -aG "${BOT_USER}" "${BOT_USER}" >/dev/null 2>&1 || true
  ok "Group ensured: ${BOT_USER}"
}

ensure_dirs(){
  mkdir -p "${BACKEND_DIR}" "${BOT_DIR}" "${ENV_DIR}"
  chmod 755 "${BACKEND_DIR}" "${BOT_DIR}"
  chmod 700 "${ENV_DIR}"

  # Required folders for runtime artifacts (DO NOT delete on uninstall)
  mkdir -p /opt/quota/vless /opt/quota/vmess /opt/quota/trojan /opt/quota/allproto
  chmod 755 /opt/quota /opt/quota/vless /opt/quota/vmess /opt/quota/trojan /opt/quota/allproto
  chown -R root:root /opt/quota

  mkdir -p /opt/vless /opt/vmess /opt/trojan /opt/allproto
  chmod 755 /opt/vless /opt/vmess /opt/trojan /opt/allproto
  chown -R root:root /opt/vless /opt/vmess /opt/trojan /opt/allproto

  ok "Directories ensured"
}

# -----------------------------
# Config: TAR_URL
# -----------------------------
load_source(){
  TAR_URL=""
  if [[ -f "${SOURCE_FILE}" ]]; then
    # shellcheck disable=SC1090
    . "${SOURCE_FILE}" || true
  fi
  if [[ -z "${TAR_URL:-}" ]]; then
    TAR_URL="${DEFAULT_TAR_URL}"
  fi
  TAR_URL="${TAR_URL%/}"
}

save_source(){
  mkdir -p "${ENV_DIR}"
  chmod 700 "${ENV_DIR}"
  cat > "${SOURCE_FILE}" <<EOF
TAR_URL=${TAR_URL}
EOF
  chmod 600 "${SOURCE_FILE}"
  chown root:root "${SOURCE_FILE}"
  ok "Source saved: ${SOURCE_FILE}"
}

prompt_source(){
  load_source
  echo
  echo "Current TAR_URL:"
  echo "  ${TAR_URL}"
  echo
  echo "Enter new TAR_URL (press Enter to keep current)."
  echo "Example (latest):"
  echo "  https://github.com/superdecrypt-dev/bot-discord-xray/releases/latest/download/bot-discord-xray.tar.gz"
  echo -n "TAR_URL: "
  read -r NEW_URL || true
  if [[ -n "${NEW_URL}" ]]; then
    TAR_URL="${NEW_URL%/}"
  fi
  save_source
}

# -----------------------------
# Discord credentials
# -----------------------------
prompt_secrets(){
  mkdir -p "${ENV_DIR}"
  chmod 700 "${ENV_DIR}"

  echo
  echo "Input Discord credentials (stored in ${ENV_FILE} with chmod 600)"
  echo -n "DISCORD_BOT_TOKEN: "
  read -rs TOKEN; echo
  [[ -n "${TOKEN}" ]] || die "Token cannot be empty"

  echo -n "DISCORD_GUILD_ID (SERVER ID): "
  read -r GUILD
  [[ "${GUILD}" =~ ^[0-9]+$ ]] || die "DISCORD_GUILD_ID must be numeric"

  echo -n "DISCORD_ADMIN_ROLE_ID: "
  read -r ROLE
  [[ "${ROLE}" =~ ^[0-9]+$ ]] || die "DISCORD_ADMIN_ROLE_ID must be numeric"

  echo -n "DISCORD_CLIENT_ID (Application ID): "
  read -r CID
  [[ "${CID}" =~ ^[0-9]+$ ]] || die "DISCORD_CLIENT_ID must be numeric"

  cat > "${ENV_FILE}" <<EOF
DISCORD_BOT_TOKEN=${TOKEN}
DISCORD_GUILD_ID=${GUILD}
DISCORD_ADMIN_ROLE_ID=${ROLE}
DISCORD_CLIENT_ID=${CID}
EOF

  chmod 600 "${ENV_FILE}"
  chown root:root "${ENV_FILE}"
  ok "Credentials saved: ${ENV_FILE}"
}

# -----------------------------
# Download + extract bundle
# -----------------------------
download_bundle_to_tmp(){
  local url="$1"
  local out="/tmp/bot-discord-xray.$$.tar.gz"
  info "Downloading bundle: ${url}"
  curl -fL --retry 3 --retry-delay 1 -o "${out}" "${url}"
  ok "Bundle downloaded: ${out}"
  echo "${out}"
}

extract_bundle(){
  local tarfile="$1"
  local tmpdir="/tmp/bot_discord_xray_extract.$$"
  mkdir -p "${tmpdir}"

  info "Extracting bundle..."
  tar -xzf "${tarfile}" -C "${tmpdir}"
  ok "Extracted to: ${tmpdir}"

  # Detect root folder from tar first entry
  local root
  root="$(tar -tzf "${tarfile}" | head -n1 | cut -d/ -f1)"
  [[ -n "${root}" ]] || die "Cannot detect root dir from tarball"
  local stage="${tmpdir}/${root}"

  # If tar is flat (backend/, bot/ at top-level), fall back to tmpdir itself
  if [[ -d "${tmpdir}/backend" && -d "${tmpdir}/bot" ]]; then
    stage="${tmpdir}"
    warn "Tar appears flat (backend/ + bot/ at top). Using stage=${stage}"
  fi

  # Validate expected structure
  [[ -f "${stage}/backend/backend.py" ]] || die "Invalid bundle: missing backend/backend.py"
  [[ -d "${stage}/backend/xray_backend" ]] || die "Invalid bundle: missing backend/xray_backend/"
  [[ -f "${stage}/bot/bot.js" ]] || die "Invalid bundle: missing bot/bot.js"
  [[ -f "${stage}/bot/package.json" ]] || die "Invalid bundle: missing bot/package.json"

  echo "${stage}"
}

deploy_from_stage(){
  local stage="$1"

  info "Deploying backend to ${BACKEND_DIR} ..."
  mkdir -p "${BACKEND_DIR}"
  rsync -a --delete \
    --exclude '__pycache__' --exclude '*.pyc' \
    "${stage}/backend/" "${BACKEND_DIR}/"
  chown -R root:root "${BACKEND_DIR}"
  chmod 755 "${BACKEND_DIR}/backend.py" || true
  ok "Backend deployed"

  info "Deploying bot to ${BOT_DIR} ..."
  mkdir -p "${BOT_DIR}"
  rsync -a --delete \
    --exclude 'node_modules' \
    "${stage}/bot/" "${BOT_DIR}/"
  # Allow bot user to manage node_modules
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}"
  ok "Bot deployed"
}

# -----------------------------------------
# Install NVM + Node 25 as discordbot
# -----------------------------------------
install_node_via_nvm(){
  info "Installing NVM + Node.js 25 for user '${BOT_USER}' (idempotent)..."

  local tmp="/tmp/install_nvm_node25_${BOT_USER}.$$.sh"
  cat > "${tmp}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
export NVM_DIR="${HOME}/.nvm"

if [[ ! -d "${NVM_DIR}" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# Load nvm explicitly (do NOT rely on .bashrc/.profile)
# shellcheck disable=SC1091
[[ -s "${NVM_DIR}/nvm.sh" ]] && . "${NVM_DIR}/nvm.sh"

nvm install 25
nvm alias default 25

node -v
npm -v
EOS

  chmod 755 "${tmp}"
  chown root:root "${tmp}"

  su - "${BOT_USER}" -c "bash '${tmp}'"
  rm -f "${tmp}"

  ok "NVM + Node installed for ${BOT_USER}"
}

node_bin_for_bot(){
  su - "${BOT_USER}" -c "bash -lc 'export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; command -v node'"
}

npm_bin_for_bot(){
  su - "${BOT_USER}" -c "bash -lc 'export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; command -v npm'"
}

install_bot_deps(){
  info "Installing Node dependencies in ${BOT_DIR} (as ${BOT_USER})..."
  su - "${BOT_USER}" -c "bash -lc '
    export NVM_DIR=\"\$HOME/.nvm\"
    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
    command -v npm >/dev/null 2>&1 || { echo \"[ERROR] npm not found in bot user env\"; exit 1; }
    cd \"${BOT_DIR}\"
    npm install --omit=dev
  '"
  ok "Node dependencies installed"
}

write_systemd_units(){
  info "Writing systemd units..."

  # Backend (root)
  cat > "${BACKEND_SERVICE_FILE}" <<EOF
[Unit]
Description=Xray Backend (Python, root) - IPC via UNIX socket
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${BACKEND_DIR}
ExecStart=/usr/bin/python3 ${BACKEND_DIR}/backend.py --serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  # Bot (non-root)
  local node_bin
  node_bin="$(node_bin_for_bot)"
  [[ -n "${node_bin}" && -x "${node_bin}" ]] || die "Node binary not found for ${BOT_USER}. Install node first."

  cat > "${BOT_SERVICE_FILE}" <<EOF
[Unit]
Description=Xray Discord Bot (Node.js, non-root) - UI only
After=network.target xray-backend.service
Requires=xray-backend.service

[Service]
Type=simple
User=${BOT_USER}
Group=${BOT_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${BOT_DIR}
ExecStart=${node_bin} ${BOT_DIR}/bot.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  ok "systemd units installed"
}

restart_services(){
  require_root
  info "Restarting services..."
  systemctl enable --now xray-backend.service
  systemctl enable --now xray-discord-bot.service
  systemctl restart xray-backend.service || true
  systemctl restart xray-discord-bot.service || true
  ok "Services restarted"
}

post_install_checks(){
  info "Post-install checks..."

  "${CLI_BIN}" --help >/dev/null 2>&1 || die "xray-userctl --help failed"

  python3 - <<PY
import json
p="${XRAY_CONFIG}"
with open(p,"r",encoding="utf-8") as f:
  json.load(f)
print("OK: JSON valid:", p)
PY

  systemctl is-active xray-backend.service >/dev/null || warn "xray-backend not active"
  systemctl is-active xray-discord-bot.service >/dev/null || warn "xray-discord-bot not active"

  ok "Post-install checks done"

  echo
  echo "================ INSTALL SUMMARY ================"
  echo "TAR_URL     : ${TAR_URL}"
  echo "Backend dir : ${BACKEND_DIR}"
  echo "Bot dir     : ${BOT_DIR}"
  echo "Env file    : ${ENV_FILE}"
  echo "Source conf : ${SOURCE_FILE}"
  echo "CLI         : ${CLI_BIN}"
  echo "Python      : $(python3 -V 2>/dev/null || true)"
  echo "Node        : $(node_bin_for_bot 2>/dev/null || true)"
  echo "NPM         : $(npm_bin_for_bot 2>/dev/null || true)"
  echo "Xray svc    : $(systemctl is-active ${XRAY_SERVICE} 2>/dev/null || true)"
  echo "Backend svc : $(systemctl is-active xray-backend.service 2>/dev/null || true)"
  echo "Bot svc     : $(systemctl is-active xray-discord-bot.service 2>/dev/null || true)"
  echo "================================================="
}

install_update(){
  require_root
  detect_os
  apt_install_base
  ensure_xray_present
  ensure_bot_user
  ensure_dirs

  load_source
  ok "Using TAR_URL: ${TAR_URL}"

  if [[ ! -f "${ENV_FILE}" ]]; then
    warn "Discord env not found. Please configure first."
    prompt_secrets
  fi

  install_node_via_nvm

  local tarfile stage
  tarfile="$(download_bundle_to_tmp "${TAR_URL}")"
  stage="$(extract_bundle "${tarfile}")"
  deploy_from_stage "${stage}"

  # CLI symlink: backend.py provides CLI interface
  ln -sf "${BACKEND_DIR}/backend.py" "${CLI_BIN}"
  chmod 755 "${CLI_BIN}"
  chown root:root "${CLI_BIN}"
  ok "CLI ready: ${CLI_BIN}"

  install_bot_deps
  write_systemd_units
  restart_services
  post_install_checks

  # cleanup tar only (stage dir auto-cleaned by /tmp cleanup policy)
  rm -f "${tarfile}" >/dev/null 2>&1 || true
  ok "Install/Update done."
}

reconfigure(){
  require_root
  detect_os
  ensure_bot_user

  echo
  echo "Reconfigure menu:"
  echo "  1) Discord credentials (TOKEN/GUILD/ROLE/CLIENT)"
  echo "  2) TAR_URL (release tar.gz source)"
  echo "  3) Both"
  echo -n "Choose [1-3]: "
  read -r ch
  case "$ch" in
    1) prompt_secrets ;;
    2) prompt_source ;;
    3) prompt_secrets; prompt_source ;;
    *) die "Invalid choice" ;;
  esac

  restart_services
  ok "Reconfigure done."
}

status_logs(){
  require_root
  echo
  echo "---- systemctl status ----"
  systemctl --no-pager --full status xray-backend.service || true
  echo
  systemctl --no-pager --full status xray-discord-bot.service || true

  echo
  echo "---- last logs (journalctl) ----"
  echo "--- xray-backend.service ---"
  journalctl -u xray-backend.service -n 120 --no-pager || true
  echo
  echo "--- xray-discord-bot.service ---"
  journalctl -u xray-discord-bot.service -n 120 --no-pager || true
}

uninstall_all(){
  require_root
  info "Uninstalling bot/backend (will NOT touch /opt/quota/* or /opt/{vless,vmess,trojan,allproto}/*)..."

  systemctl stop xray-discord-bot.service 2>/dev/null || true
  systemctl stop xray-backend.service 2>/dev/null || true
  systemctl disable xray-discord-bot.service 2>/dev/null || true
  systemctl disable xray-backend.service 2>/dev/null || true

  rm -f "${BOT_SERVICE_FILE}" "${BACKEND_SERVICE_FILE}" || true
  systemctl daemon-reload || true

  rm -f "${CLI_BIN}" || true
  rm -rf "${BOT_DIR}" "${BACKEND_DIR}" || true
  rm -rf "${ENV_DIR}" || true

  if id "${BOT_USER}" >/dev/null 2>&1; then
    userdel -r "${BOT_USER}" 2>/dev/null || true
  fi
  if getent group "${BOT_USER}" >/dev/null 2>&1; then
    groupdel "${BOT_USER}" 2>/dev/null || true
  fi

  ok "Uninstall completed."
}

menu(){
  while true; do
    echo
    echo "=============================="
    echo " XRAY DISCORD BOT INSTALLER"
    echo "=============================="
    echo "1) Install / Update (deploy + service + run)"
    echo "2) Reconfigure (Discord creds / TAR_URL)"
    echo "3) Restart service"
    echo "4) Status (service + logs)"
    echo "5) Uninstall (remove bot/backend only)"
    echo "0) Exit"
    echo "------------------------------"
    echo -n "Choose: "
    read -r opt

    case "$opt" in
      1) install_update; pause ;;
      2) reconfigure; pause ;;
      3) restart_services; pause ;;
      4) status_logs; pause ;;
      5) uninstall_all; pause ;;
      0) exit 0 ;;
      *) warn "Invalid option"; pause ;;
    esac
  done
}

menu