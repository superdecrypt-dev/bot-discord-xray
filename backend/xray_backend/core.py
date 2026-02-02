import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict
from uuid import uuid4

from .constants import VALID_PROTO, USERNAME_RE, QUOTA_DIR, DETAIL_BASE
from .xray_config import load_config, save_config_with_backup, email_exists, append_client, remove_client
from .system import restart_xray, svc_state
from .quota import write_quota, safe_int, quota_scan_protos, scan_quota_items
from .detail import write_detail_json, write_detail_txt

def final_user(proto: str, username: str) -> str:
    return f"{username}@{proto}"

def handle_action(req: Dict[str, Any]) -> Dict[str, Any]:
    action = (req.get("action") or "").strip().lower()

    if action not in ("add", "del", "ping", "status", "list"):
        return {"status": "error", "error": "unsupported action"}

    if action == "ping":
        return {"status": "ok"}

    if action == "status":
        return {"status": "ok", "xray": svc_state("xray"), "nginx": svc_state("nginx")}

    if action == "list":
        proto_filter = str(req.get("protocol") or "all").strip().lower()
        protos = quota_scan_protos(proto_filter)
        if not protos:
            return {"status": "error", "error": "invalid protocol"}

        limit = safe_int(req.get("limit"), 25)
        offset = safe_int(req.get("offset"), 0)

        if limit < 1: limit = 1
        if limit > 25: limit = 25
        if offset < 0: offset = 0

        items = scan_quota_items(proto_filter)
        total = len(items)
        page = items[offset: offset + limit]
        has_more = (offset + limit) < total

        return {
            "status": "ok",
            "protocol": proto_filter,
            "offset": offset,
            "limit": limit,
            "total": total,
            "has_more": has_more,
            "items": page,
        }

    proto = (req.get("protocol") or "").strip().lower()
    username = (req.get("username") or "").strip()

    if proto not in VALID_PROTO:
        return {"status": "error", "error": "invalid protocol"}
    if not USERNAME_RE.match(username):
        return {"status": "error", "error": "invalid username"}

    cfg = load_config()

    if action == "add":
        try:
            days = int(req.get("days", 0))
        except Exception:
            return {"status": "error", "error": "days must be integer"}

        try:
            quota_gb = float(req.get("quota_gb", 0))
        except Exception:
            return {"status": "error", "error": "quota_gb must be number"}

        if days <= 0 or days > 3650:
            return {"status": "error", "error": "days out of range (1..3650)"}
        if quota_gb < 0:
            return {"status": "error", "error": "quota_gb must be >= 0"}

        final_u = final_user(proto, username)
        if email_exists(cfg, final_u):
            return {"status": "error", "error": "duplicate email", "username": final_u}

        secret = str(uuid4())

        if proto == "allproto":
            n1 = append_client(cfg, "vless", final_u, secret)
            n2 = append_client(cfg, "vmess", final_u, secret)
            n3 = append_client(cfg, "trojan", final_u, secret)
            if min(n1, n2, n3) == 0:
                return {"status": "error", "error": "missing inbound for one of vless/vmess/trojan"}
        else:
            n = append_client(cfg, proto, final_u, secret)
            if n == 0:
                return {"status": "error", "error": "no matching inbound found"}

        backup_path = save_config_with_backup(cfg)
        restart_xray()

        created_at = date.today().isoformat()
        expired_at = (date.today() + timedelta(days=days)).isoformat()

        # quota metadata
        if proto == "allproto":
            write_quota("allproto", final_u, quota_gb, days, created_at, expired_at)

            # cleanup legacy/duplicate files from older versions
            def _rm_quota(p: Path):
                try:
                    if p.exists():
                        p.unlink()
                except Exception:
                    pass

            _rm_quota(QUOTA_DIR / "vless" / f"{final_u}.json")
            _rm_quota(QUOTA_DIR / "vmess" / f"{final_u}.json")
            _rm_quota(QUOTA_DIR / "trojan" / f"{final_u}.json")
        else:
            write_quota(proto, final_u, quota_gb, days, created_at, expired_at)

        detail_json_path = write_detail_json(proto, final_u, secret, days, quota_gb)
        detail_txt_path = write_detail_txt(cfg, proto, final_u, secret, days, quota_gb)

        return {
            "status": "ok",
            "username": final_u,
            "uuid": secret if proto != "trojan" else None,
            "password": secret if proto == "trojan" else None,
            "expired_at": expired_at,
            "detail_path": detail_txt_path,
            "detail_json_path": detail_json_path,
            "backup_path": backup_path,
        }

    # del
    final_u = final_user(proto, username)

    removed = 0
    if proto == "allproto":
        removed += remove_client(cfg, "vless", final_u)
        removed += remove_client(cfg, "vmess", final_u)
        removed += remove_client(cfg, "trojan", final_u)
    else:
        removed = remove_client(cfg, proto, final_u)

    if removed == 0:
        return {"status": "error", "error": "user not found", "username": final_u}

    backup_path = save_config_with_backup(cfg)
    restart_xray()

    def _rm(p: Path):
        try:
            if p.exists():
                p.unlink()
        except Exception:
            pass

    if proto == "allproto":
        _rm(QUOTA_DIR / "allproto" / f"{final_u}.json")
        _rm(DETAIL_BASE["allproto"] / f"{final_u}.json")
        _rm(DETAIL_BASE["allproto"] / f"{final_u}.txt")

        # legacy cleanup
        _rm(QUOTA_DIR / "vless" / f"{final_u}.json")
        _rm(QUOTA_DIR / "vmess" / f"{final_u}.json")
        _rm(QUOTA_DIR / "trojan" / f"{final_u}.json")

        _rm(DETAIL_BASE["vless"] / f"{final_u}.json")
        _rm(DETAIL_BASE["vmess"] / f"{final_u}.json")
        _rm(DETAIL_BASE["trojan"] / f"{final_u}.json")

        _rm(DETAIL_BASE["vless"] / f"{final_u}.txt")
        _rm(DETAIL_BASE["vmess"] / f"{final_u}.txt")
        _rm(DETAIL_BASE["trojan"] / f"{final_u}.txt")
    else:
        _rm(QUOTA_DIR / proto / f"{final_u}.json")
        _rm(DETAIL_BASE[proto] / f"{final_u}.json")
        _rm(DETAIL_BASE[proto] / f"{final_u}.txt")

    return {"status": "ok", "username": final_u, "removed": removed, "backup_path": backup_path}
