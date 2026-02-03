#!/usr/bin/env bash
set -euo pipefail
trap 'echo "[ERROR] Failed at line $LINENO: $BASH_COMMAND" >&2' ERR

# ============================================================
# XRAY DISCORD BOT INSTALLER (GitHub Release tar.gz)
#
# Bundle must contain:
#   bot-discord-xray/
#     backend/  (backend.py + xray_backend/)
#     bot/      (bot.js + package.json + src/)
#
# Clean Architecture:
#   - Python backend: root (system access + Xray config edits)
#   - Node.js bot   : non-root user 'discordbot' (Discord UI only)
#
# IMPORTANT:
# - Env keys follow tar.gz code (bot/src/config.js):
#     DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_ADMIN_ROLE_ID / DISCORD_CLIENT_ID
# - Install/Update automatically runs: node src/register.js
# - Uninstall does NOT delete:
#     /opt/quota/* and /opt/{vless,vmess,trojan,allproto}/*
# ============================================================

SCRIPT_NAME="install-xray-bot.sh"

# -------- Default Release Asset URL --------
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
BOT_HOME="/home/${BOT_USER}"

CLI_BIN="/usr/local/bin/xray-userctl"

SOCK_PATH="/run/xray-backend.sock"

BACKEND_UNIT="/etc/systemd/system/xray-backend.service"
BOT_UNIT="/etc/systemd/system/xray-discord-bot.service"

# -------- Helpers (LOG -> STDERR) --------
info(){ echo "[INFO]  $*" >&2; }
ok(){   echo "[OK]    $*" >&2; }
warn(){ echo "[WARN]  $*" >&2; }
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
    useradd -r -m -d "${BOT_HOME}" -s /bin/bash "${BOT_USER}"
    ok "Created user: ${BOT_USER}"
  else
    ok "User exists: ${BOT_USER}"
  fi
}

ensure_dirs(){
  mkdir -p "${BACKEND_DIR}" "${BOT_DIR}" "${ENV_DIR}"
  chmod 755 "${BACKEND_DIR}" "${BOT_DIR}"
  chmod 700 "${ENV_DIR}"

  # Runtime folders (MUST exist, but uninstall must NOT delete contents)
  mkdir -p /opt/quota/vless /opt/quota/vmess /opt/quota/trojan /opt/quota/allproto
  mkdir -p /opt/vless /opt/vmess /opt/trojan /opt/allproto

  chmod 755 /opt/quota /opt/quota/vless /opt/quota/vmess /opt/quota/trojan /opt/quota/allproto
  chmod 755 /opt/vless /opt/vmess /opt/trojan /opt/allproto

  # Bot state (notify.json etc.)
  mkdir -p "${BOT_DIR}/state"
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}/state"
  chmod 755 "${BOT_DIR}/state"

  ok "Directories ensured"
}

# -----------------------------
# TAR_URL config
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
  echo "Example:"
  echo "  ${DEFAULT_TAR_URL}"
  echo -n "TAR_URL: "
  read -r NEW_URL || true
  if [[ -n "${NEW_URL}" ]]; then
    TAR_URL="${NEW_URL%/}"
  fi
  save_source
}

# -----------------------------
# Discord credentials (matches tar.gz code)
# -----------------------------
env_has_discord_keys(){
  [[ -f "${ENV_FILE}" ]] || return 1
  # shellcheck disable=SC1090
  set -a; . "${ENV_FILE}" >/dev/null 2>&1 || true; set +a
  [[ -n "${DISCORD_BOT_TOKEN:-}" && -n "${DISCORD_GUILD_ID:-}" && -n "${DISCORD_ADMIN_ROLE_ID:-}" && -n "${DISCORD_CLIENT_ID:-}" ]]
}

prompt_secrets(){
  mkdir -p "${ENV_DIR}"
  chmod 700 "${ENV_DIR}"

  echo
  echo "Input Discord credentials (stored in ${ENV_FILE} with chmod 600)"
  echo -n "DISCORD_BOT_TOKEN: "
  read -rs TOKEN; echo
  [[ -n "${TOKEN}" ]] || die "DISCORD_BOT_TOKEN cannot be empty"

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
# NVM + Node install (discordbot user)
# -----------------------------
install_node_via_nvm(){
  info "Installing NVM + Node.js 25 for user '${BOT_USER}' (idempotent)..."

  local tmp="/tmp/install_nvm_node25_${BOT_USER}.sh"
  cat > "${tmp}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ ! -d "$NVM_DIR" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# Load nvm explicitly (do NOT rely on .bashrc)
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"

nvm install 25
nvm alias default 25

node -v
npm -v
EOS

  chmod 755 "${tmp}"
  chown root:root "${tmp}"

  su - "${BOT_USER}" -c "bash '${tmp}'"
  rm -f "${tmp}"

  NODE_BIN="$(su - "${BOT_USER}" -c "bash -lc 'export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; command -v node'")"
  NPM_BIN="$(su - "${BOT_USER}" -c "bash -lc 'export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; command -v npm'")"

  [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || die "Failed to locate node after nvm install"
  [[ -n "${NPM_BIN}" && -x "${NPM_BIN}" ]] || die "Failed to locate npm after nvm install"

  ok "Node installed: ${NODE_BIN}"
  ok "NPM installed : ${NPM_BIN}"
}

# -----------------------------
# Download + extract bundle
# -----------------------------
download_bundle_to_tmp(){
  local url="$1"
  local out
  out="$(mktemp -p /tmp bot-discord-xray.XXXXXX.tar.gz)"
  info "Downloading bundle: ${url}"
  curl -fL --retry 3 --retry-delay 1 -o "${out}" "${url}"
  ok "Bundle downloaded: ${out}"
  echo "${out}"
}

detect_tar_root(){
  local tarfile="$1"
  local first
  first="$(tar -tzf "${tarfile}" | sed 's|^\./||' | awk -F/ 'NF>1 && $1!=""{print $1; exit}')"
  [[ -n "${first}" ]] || return 1
  [[ "${first}" != "." ]] || return 1
  echo "${first}"
}

extract_bundle(){
  local tarfile="$1"
  local tmpdir
  tmpdir="$(mktemp -d -p /tmp bot_discord_xray_extract.XXXXXX)"

  info "Extracting bundle..."
  tar -xzf "${tarfile}" -C "${tmpdir}"
  ok "Extracted to: ${tmpdir}"

  local root
  root="$(detect_tar_root "${tarfile}")" || die "Cannot detect root dir from tarball"
  local stage="${tmpdir}/${root}"

  [[ -d "${stage}/backend" ]] || die "Tarball missing: ${root}/backend"
  [[ -d "${stage}/bot" ]] || die "Tarball missing: ${root}/bot"

  echo "${stage}"
}

deploy_bundle(){
  local stage="$1"

  info "Deploying backend -> ${BACKEND_DIR}"
  rsync -a --delete "${stage}/backend/" "${BACKEND_DIR}/"
  chmod 755 "${BACKEND_DIR}"
  chown -R root:root "${BACKEND_DIR}"
  chmod +x "${BACKEND_DIR}/backend.py" || true

  info "Deploying bot -> ${BOT_DIR}"
  rsync -a --delete "${stage}/bot/" "${BOT_DIR}/"
  chmod 755 "${BOT_DIR}"
  chown -R root:root "${BOT_DIR}"
  # Node modules should be owned by BOT_USER after npm install; for now set base ownership for source:
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}" || true
  chmod +x "${BOT_DIR}/bot.js" || true

  ok "Deploy complete"
}

# -----------------------------
# Bot deps install
# -----------------------------
npm_install_bot(){
  info "Installing bot dependencies (npm install) as ${BOT_USER}..."
  su - "${BOT_USER}" -c "bash -lc '
    export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"
    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
    cd \"${BOT_DIR}\"
    npm install --omit=dev
  '"
  ok "Bot dependencies installed"
}

# -----------------------------
# CLI link
# -----------------------------
install_cli_link(){
  info "Installing CLI: ${CLI_BIN}"
  ln -sf "${BACKEND_DIR}/backend.py" "${CLI_BIN}"
  chmod +x "${CLI_BIN}" || true
  chown root:root "${CLI_BIN}"
  ok "CLI ready: ${CLI_BIN}"
}

# -----------------------------
# Systemd units
# -----------------------------
write_systemd_units(){
  info "Writing systemd units..."

  cat > "${BACKEND_UNIT}" <<EOF
[Unit]
Description=Xray Backend (Python IPC Service)
After=network.target ${XRAY_SERVICE}.service
Wants=${XRAY_SERVICE}.service

[Service]
Type=simple
User=root
Group=root
ExecStartPre=/bin/rm -f ${SOCK_PATH}
ExecStart=/usr/bin/python3 ${BACKEND_DIR}/backend.py --serve
Restart=on-failure
RestartSec=2
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
EOF

  cat > "${BOT_UNIT}" <<EOF
[Unit]
Description=Xray Discord Bot (Node.js)
After=network.target xray-backend.service
Requires=xray-backend.service

[Service]
Type=simple
User=${BOT_USER}
Group=${BOT_USER}
WorkingDirectory=${BOT_DIR}
EnvironmentFile=${ENV_FILE}
NoNewPrivileges=true
ExecStart=/bin/bash -lc 'export NVM_DIR="${BOT_HOME}/.nvm"; [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"; cd "${BOT_DIR}"; exec node bot.js'
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  chmod 644 "${BACKEND_UNIT}" "${BOT_UNIT}"
  systemctl daemon-reload
  ok "Systemd units written"
}

enable_start_services(){
  info "Enabling + starting services..."
  systemctl enable --now xray-backend.service
  systemctl enable --now xray-discord-bot.service
  ok "Services enabled + started"
}

# -----------------------------
# Register slash commands (auto after update)
# -----------------------------
register_commands(){
  info "Registering Discord slash commands (node src/register.js)..."

  [[ -f "${ENV_FILE}" ]] || die "Env missing: ${ENV_FILE}. Run Reconfigure first."
  # shellcheck disable=SC1090
  set -a; . "${ENV_FILE}"; set +a

  [[ -n "${DISCORD_BOT_TOKEN:-}" ]] || die "DISCORD_BOT_TOKEN is empty in ${ENV_FILE}"
  [[ -n "${DISCORD_GUILD_ID:-}" ]] || die "DISCORD_GUILD_ID is empty in ${ENV_FILE}"
  [[ -n "${DISCORD_ADMIN_ROLE_ID:-}" ]] || die "DISCORD_ADMIN_ROLE_ID is empty in ${ENV_FILE}"
  [[ -n "${DISCORD_CLIENT_ID:-}" ]] || die "DISCORD_CLIENT_ID is empty in ${ENV_FILE}"

  su - "${BOT_USER}" -c "bash -lc '
    export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"
    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
    cd \"${BOT_DIR}\"
    DISCORD_BOT_TOKEN=\"${DISCORD_BOT_TOKEN}\" \
    DISCORD_GUILD_ID=\"${DISCORD_GUILD_ID}\" \
    DISCORD_ADMIN_ROLE_ID=\"${DISCORD_ADMIN_ROLE_ID}\" \
    DISCORD_CLIENT_ID=\"${DISCORD_CLIENT_ID}\" \
    node src/register.js
  '"

  ok "Register commands OK"
}

# -----------------------------
# Reconfigure menu
# -----------------------------
reconfigure(){
  require_root
  echo
  echo "Reconfigure:"
  echo "1) Discord credentials (TOKEN/GUILD/ROLE/CLIENT)"
  echo "2) TAR_URL source (release URL)"
  echo "0) Back"
  echo -n "Choose [0-2]: "
  read -r c || true
  case "${c:-}" in
    1) prompt_secrets ;;
    2) prompt_source ;;
    0) return 0 ;;
    *) warn "Invalid choice." ;;
  esac
}

# -----------------------------
# Install / Update
# -----------------------------
install_update(){
  require_root
  detect_os
  apt_install_base
  ensure_xray_present
  ensure_bot_user
  ensure_dirs

  load_source

  if ! env_has_discord_keys; then
    warn "Discord env not configured yet."
    prompt_secrets
  else
    ok "Env exists + keys OK: ${ENV_FILE}"
  fi

  install_node_via_nvm

  local tarfile stage
  tarfile="$(download_bundle_to_tmp "${TAR_URL}")"
  stage="$(extract_bundle "${tarfile}")"
  deploy_bundle "${stage}"

  # Ensure bot state dir ownership after rsync
  mkdir -p "${BOT_DIR}/state"
  chown -R "${BOT_USER}:${BOT_USER}" "${BOT_DIR}"
  chmod 755 "${BOT_DIR}" "${BOT_DIR}/state"

  npm_install_bot
  install_cli_link
  write_systemd_units

  # Start backend first so bot can connect
  systemctl enable --now xray-backend.service

  # Register commands BEFORE starting bot (so new commands appear immediately)
  register_commands

  systemctl enable --now xray-discord-bot.service
  systemctl restart xray-discord-bot.service

  info "Sanity checks:"
  /usr/bin/python3 -c "import json; json.load(open('${XRAY_CONFIG}','r',encoding='utf-8')); print('JSON OK: ${XRAY_CONFIG}')"
  "${CLI_BIN}" -h >/dev/null && ok "xray-userctl -h OK"

  rm -f "${tarfile}" || true
  ok "Install/Update done."
}

restart_services(){
  require_root
  info "Restarting services..."
  systemctl restart xray-backend.service || true
  systemctl restart xray-discord-bot.service || true
  ok "Restart done."
}

status_logs(){
  require_root
  echo
  info "===== STATUS ====="
  systemctl --no-pager --full status xray-backend.service || true
  echo
  systemctl --no-pager --full status xray-discord-bot.service || true

  echo
  info "===== LOGS (last 120 lines) ====="
  echo "--- xray-backend.service ---"
  journalctl -u xray-backend.service -n 120 --no-pager || true
  echo
  echo "--- xray-discord-bot.service ---"
  journalctl -u xray-discord-bot.service -n 120 --no-pager || true

  echo
  info "Socket:"
  if [[ -S "${SOCK_PATH}" ]]; then
    ls -l "${SOCK_PATH}" || true
  else
    warn "Socket not found."
  fi
}

uninstall_all(){
  require_root
  echo
  warn "UNINSTALL will remove ONLY bot/backend deployment + services + env:"
  echo " - ${BACKEND_DIR}"
  echo " - ${BOT_DIR}"
  echo " - ${ENV_DIR}"
  echo " - ${CLI_BIN}"
  echo " - systemd units: ${BACKEND_UNIT}, ${BOT_UNIT}"
  echo " - services disable/stop"
  echo " - user home nvm: ${BOT_HOME}/.nvm (optional remove)"
  echo
  warn "It will NOT delete:"
  echo " - /opt/quota/*"
  echo " - /opt/vless/* /opt/vmess/* /opt/trojan/* /opt/allproto/*"
  echo
  read -r -p "Type UNINSTALL to confirm: " c
  [[ "${c}" == "UNINSTALL" ]] || { warn "Cancelled."; return 0; }

  info "Stopping services..."
  systemctl stop xray-discord-bot.service 2>/dev/null || true
  systemctl stop xray-backend.service 2>/dev/null || true
  systemctl disable xray-discord-bot.service 2>/dev/null || true
  systemctl disable xray-backend.service 2>/dev/null || true

  info "Removing systemd unit files..."
  rm -f "${BOT_UNIT}" "${BACKEND_UNIT}"
  systemctl daemon-reload || true

  info "Removing deployed files..."
  rm -f "${CLI_BIN}"
  rm -rf "${BACKEND_DIR}" "${BOT_DIR}" "${ENV_DIR}"
  rm -f "${SOCK_PATH}" 2>/dev/null || true

  # Optional: remove bot user (kept by default for safety; comment out if you want)
  # info "Removing bot user (and home)..."
  # if id "${BOT_USER}" >/dev/null 2>&1; then
  #   userdel -r "${BOT_USER}" 2>/dev/null || true
  # fi

  ok "Uninstall complete."
}

menu(){
  require_root
  while true; do
    clear || true
    echo "=================================================="
    echo "          XRAY DISCORD BOT INSTALLER"
    echo "=================================================="
    echo "1) Install / Update (download release + deploy + register + run)"
    echo "2) Reconfigure (Discord creds / TAR_URL)"
    echo "3) Restart service"
    echo "4) Status (service + logs)"
    echo "5) Uninstall (remove bot/backend only)"
    echo "0) Exit"
    echo "--------------------------------------------------"
    echo -n "Choose [0-5]: "
    read -r choice || true
    case "${choice:-}" in
      1) install_update; pause ;;
      2) reconfigure; pause ;;
      3) restart_services; pause ;;
      4) status_logs; pause ;;
      5) uninstall_all; pause ;;
      0) exit 0 ;;
      *) warn "Invalid choice."; pause ;;
    esac
  done
}

menu "$@"