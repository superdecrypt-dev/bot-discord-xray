import json
from pathlib import Path
from typing import Any, Dict, List

from .constants import CONFIG, ROLLING_BACKUP
from .io_utils import atomic_write

def load_config() -> Dict[str, Any]:
    if not CONFIG.exists():
        raise FileNotFoundError(str(CONFIG))
    raw = CONFIG.read_text(encoding="utf-8")
    return json.loads(raw)

def ensure_client_list(ib: Dict[str, Any]) -> List[Dict[str, Any]]:
    settings = ib.get("settings")
    if not isinstance(settings, dict):
        settings = {}
        ib["settings"] = settings

    clients = settings.get("clients")
    if not isinstance(clients, list):
        clients = []
        settings["clients"] = clients
    return clients

def email_exists(cfg: Dict[str, Any], email: str) -> bool:
    inbounds = cfg.get("inbounds", [])
    if not isinstance(inbounds, list):
        return False
    for ib in inbounds:
        if not isinstance(ib, dict):
            continue
        proto = ib.get("protocol")
        if proto not in ("vless", "vmess", "trojan"):
            continue
        clients = ensure_client_list(ib)
        for c in clients:
            if isinstance(c, dict) and c.get("email") == email:
                return True
    return False

def append_client(cfg: Dict[str, Any], proto: str, email: str, secret: str) -> int:
    inbounds = cfg.get("inbounds", [])
    if not isinstance(inbounds, list):
        return 0

    n = 0
    for ib in inbounds:
        if not isinstance(ib, dict):
            continue
        if ib.get("protocol") != proto:
            continue

        clients = ensure_client_list(ib)

        if proto in ("vless", "vmess"):
            clients.append({"id": secret, "email": email})
            n += 1
        elif proto == "trojan":
            clients.append({"password": secret, "email": email})
            n += 1

    return n

def remove_client(cfg: Dict[str, Any], proto: str, email: str) -> int:
    inbounds = cfg.get("inbounds", [])
    if not isinstance(inbounds, list):
        return 0

    removed = 0
    for ib in inbounds:
        if not isinstance(ib, dict):
            continue
        if ib.get("protocol") != proto:
            continue

        clients = ensure_client_list(ib)
        before = len(clients)
        clients[:] = [c for c in clients if not (isinstance(c, dict) and c.get("email") == email)]
        removed += (before - len(clients))

    return removed

def save_config_with_backup(cfg: Dict[str, Any]) -> str:
    # rolling backup (single file)
    try:
        if CONFIG.exists():
            atomic_write(
                ROLLING_BACKUP,
                CONFIG.read_bytes(),
                mode=0o600,
                uid=0,
                gid=0
            )
    except Exception:
        # best effort backup
        pass

    # ✅ Preserve original permission/owner/group of CONFIG
    if CONFIG.exists():
        st = CONFIG.stat()
        mode = st.st_mode & 0o777
        uid = st.st_uid
        gid = st.st_gid
    else:
        mode, uid, gid = 0o644, 0, 0

    data = (json.dumps(cfg, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    atomic_write(CONFIG, data, mode=mode, uid=uid, gid=gid)
    return str(ROLLING_BACKUP)
