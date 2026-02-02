# bot-discord-xray (bundle)

Bundle source untuk:
- **Python backend** (root privileged) via UNIX socket: `/run/xray-backend.sock`
- **Node.js Discord bot** (non-root) sebagai UI (slash + buttons)

Struktur:
- `backend/` → Python backend service + package `xray_backend`
- `bot/` → Node.js Discord bot (discord.js)
- `installer/` → tempat menyimpan installer (opsional)

Catatan:
- Bundle ini dibuat untuk memudahkan distribusi sebagai **1 file tar.gz**.
- Installer kamu nantinya cukup download tar.gz ini, verify SHA256, lalu extract ke `/opt/xray-backend` dan `/opt/xray-discord-bot`.
