import json
import re
import subprocess
from datetime import date, timedelta, datetime
from pathlib import Path
from typing import Any, Dict, List
from uuid import uuid4

from .constants import VALID_PROTO, USERNAME_RE, QUOTA_DIR, DETAIL_BASE
from .xray_config import load_config, save_config_with_backup, email_exists, append_client, remove_client
from .system import restart_xray, svc_state
from .quota import write_quota, safe_int, quota_scan_protos, scan_quota_items


def final_user(proto: str, username: str) -> str:
    return f"{username}@{proto}"


def _quota_path(proto: str, final_u: str) -> Path:
    return QUOTA_DIR / proto / f"{final_u}.json"


def _read_json_file(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


def _write_json_atomic(p: Path, obj: Dict[str, Any]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def _quota_bytes_from_gb(quota_gb: float) -> int:
    if quota_gb <= 0:
        return 0
    return int(round(quota_gb * 1073741824))


def _quota_gb_from_bytes(quota_bytes: Any) -> float:
    try:
        qb = int(quota_bytes or 0)
    except Exception:
        qb = 0
    if qb <= 0:
        return 0.0
    return qb / 1073741824.0


def _detail_txt_path(proto: str, final_u: str) -> Path:
    base = DETAIL_BASE["allproto"] if proto == "allproto" else DETAIL_BASE[proto]
    return base / f"{final_u}.txt"


def _extract_secret_from_detail_txt(p: Path) -> str:
    """
    Ambil UUID/Pass dari file XRAY ACCOUNT DETAIL (.txt).
    Harapannya ada baris:
      UUID/Pass  : xxxxxxxx-xxxx-....
    """
    if not p.exists():
        raise FileNotFoundError(f"detail file not found: {p}")
    txt = p.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"UUID/Pass\s*:\s*([A-Za-z0-9-]{8,})", txt)
    if not m:
        raise ValueError("cannot parse UUID/Pass from detail txt")
    return m.group(1).strip()


def _calc_days_remaining(expired_at_iso: str) -> int:
    try:
        exp = date.fromisoformat(expired_at_iso)
        d = (exp - date.today()).days
        if d < 0:
            d = 0
        return d
    except Exception:
        return 0


def _blocked_dir() -> Path:
    return QUOTA_DIR / "_blocked"


def _blocked_path(final_u: str) -> Path:
    return _blocked_dir() / f"{final_u}.json"


def _blocked_get(final_u: str) -> Dict[str, Any]:
    p = _blocked_path(final_u)
    if not p.exists():
        return {"blocked": False}
    try:
        obj = _read_json_file(p)
        if not isinstance(obj, dict):
            return {"blocked": True}
        return {"blocked": True, "blocked_at": obj.get("blocked_at"), "protocol": obj.get("protocol")}
    except Exception:
        return {"blocked": True}


def _blocked_write(final_u: str, proto: str, secret: str) -> None:
    p = _blocked_path(final_u)
    obj = {
        "username": final_u,
        "protocol": proto,
        "secret": secret,
        "blocked_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    _write_json_atomic(p, obj)


def _blocked_read_secret(final_u: str) -> str:
    p = _blocked_path(final_u)
    if not p.exists():
        raise FileNotFoundError("blocked record not found")
    obj = _read_json_file(p)
    if not isinstance(obj, dict):
        raise ValueError("invalid blocked record")
    s = str(obj.get("secret") or "").strip()
    if not s:
        raise ValueError("blocked record missing secret")
    return s


def _blocked_remove(final_u: str) -> None:
    p = _blocked_path(final_u)
    try:
        if p.exists():
            p.unlink()
    except Exception:
        pass


def _find_secret_in_config(cfg: Dict[str, Any], proto: str, final_u: str) -> str:
    inbounds = cfg.get("inbounds", [])
    if not isinstance(inbounds, list):
        return ""
    protos = ("vless", "vmess", "trojan") if proto == "allproto" else (proto,)
    for ib in inbounds:
        if not isinstance(ib, dict):
            continue
        ibp = ib.get("protocol")
        if ibp not in protos:
            continue
        settings = ib.get("settings")
        if not isinstance(settings, dict):
            continue
        clients = settings.get("clients")
        if not isinstance(clients, list):
            continue
        for c in clients:
            if not isinstance(c, dict):
                continue
            if c.get("email") != final_u:
                continue
            if ibp in ("vless", "vmess"):
                s = c.get("id")
            else:
                s = c.get("password")
            s = str(s or "").strip()
            if s:
                return s
    return ""


def _find_blocked_rule(cfg: Dict[str, Any]) -> Dict[str, Any] | None:
    routing = cfg.get("routing")
    if not isinstance(routing, dict):
        return None
    rules = routing.get("rules")
    if not isinstance(rules, list):
        return None

    # prefer rule that already has "user": [...]
    for r in rules:
        if not isinstance(r, dict):
            continue
        if r.get("outboundTag") == "blocked" and isinstance(r.get("user"), list):
            return r

    # fallback: any blocked rule → ensure user list
    for r in rules:
        if not isinstance(r, dict):
            continue
        if r.get("outboundTag") == "blocked":
            if not isinstance(r.get("user"), list):
                r["user"] = []
            return r

    return None


def _blocked_rule_add(cfg: Dict[str, Any], final_u: str) -> bool:
    r = _find_blocked_rule(cfg)
    if not r:
        return False
    users = r.get("user")
    if not isinstance(users, list):
        users = []
        r["user"] = users
    if final_u not in users:
        users.append(final_u)
    return True


def _blocked_rule_remove(cfg: Dict[str, Any], final_u: str) -> bool:
    r = _find_blocked_rule(cfg)
    if not r:
        return False
    users = r.get("user")
    if not isinstance(users, list):
        return True
    r["user"] = [u for u in users if u != final_u]
    return True


def _journal_logs(unit: str, page: int, page_size: int) -> Dict[str, Any]:
    # pagination sederhana: page=0 paling baru, page=1 lebih lama, dst.
    if page < 0:
        page = 0
    if page_size < 5:
        page_size = 5
    if page_size > 80:
        page_size = 80

    n = (page + 1) * page_size

    cmd = [
        "journalctl",
        "-u",
        unit,
        "--no-pager",
        "--output=short-iso",
        "-n",
        str(n),
    ]
    try:
        out = subprocess.check_output(cmd, text=True, errors="replace")
    except subprocess.CalledProcessError as e:
        return {"status": "error", "error": f"journalctl failed: {e}"}
    except FileNotFoundError:
        return {"status": "error", "error": "journalctl not found"}

    lines = [ln for ln in out.splitlines() if ln.strip()]
    if len(lines) <= page_size:
        seg = lines
    else:
        seg = lines[:page_size]

    has_more = (len(lines) == n)
    text = "\n".join(seg)
    return {"status": "ok", "unit": unit, "page": page, "page_size": page_size, "has_more": has_more, "text": text}


def handle_action(req: Dict[str, Any]) -> Dict[str, Any]:
    action = (req.get("action") or "").strip().lower()

    if action not in (
        "add", "del", "ping", "status", "list",
        "logs",
        "renew",
        "quota_get", "quota_set",
        "block_get", "block",
        "detail", "get_detail",  # ✅ fix /accounts: ambil ulang detail
    ):
        return {"status": "error", "error": "unsupported action"}

    # --- lightweight actions ---
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

        if limit < 1:
            limit = 1
        if limit > 25:
            limit = 25
        if offset < 0:
            offset = 0

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

    if action == "logs":
        unit_in = str(req.get("unit") or req.get("service") or "xray").strip().lower()
        unit_map = {
            "xray": "xray",
            "nginx": "nginx",
            "backend": "xray-backend",
            "bot": "xray-discord-bot",
            "xray-backend": "xray-backend",
            "xray-discord-bot": "xray-discord-bot",
        }
        unit = unit_map.get(unit_in, unit_in)

        page = safe_int(req.get("page"), 0)
        page_size = safe_int(req.get("page_size"), 25)
        return _journal_logs(unit, page, page_size)

    # --- actions that need protocol/username ---
    proto = (req.get("protocol") or "").strip().lower()
    username = (req.get("username") or "").strip()

    if proto not in VALID_PROTO:
        return {"status": "error", "error": "invalid protocol"}
    if not USERNAME_RE.match(username):
        return {"status": "error", "error": "invalid username"}

    final_u = final_user(proto, username)

    if action == "block_get":
        st = _blocked_get(final_u)
        return {"status": "ok", "username": final_u, **st}

    # load config once for remaining actions
    cfg = load_config()

    # ✅ detail/get_detail: regen detail TXT pakai quota metadata + secret
    if action in ("detail", "get_detail"):
        meta_proto = "allproto" if proto == "allproto" else proto
        qp = _quota_path(meta_proto, final_u)
        if not qp.exists():
            return {"status": "error", "error": "quota metadata not found", "username": final_u}

        meta = _read_json_file(qp)
        exp = str(meta.get("expired_at") or "").strip()
        if not exp:
            return {"status": "error", "error": "expired_at missing in metadata", "username": final_u}

        quota_gb = _quota_gb_from_bytes(meta.get("quota_limit"))
        days_remaining = _calc_days_remaining(exp)

        # prefer parse from existing detail txt; fallback scan config
        try:
            secret = _extract_secret_from_detail_txt(_detail_txt_path(proto, final_u))
        except Exception:
            secret = _find_secret_in_config(cfg, proto, final_u)
            if not secret:
                return {"status": "error", "error": "cannot determine UUID/Pass", "username": final_u}

        from .detail import write_detail_txt
        detail_txt_path = write_detail_txt(cfg, proto, final_u, secret, days_remaining, quota_gb)

        return {"status": "ok", "username": final_u, "expired_at": exp, "detail_path": detail_txt_path}

    # --- add ---
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

        if proto == "allproto":
            write_quota("allproto", final_u, quota_gb, days, created_at, expired_at)
            for p in ("vless", "vmess", "trojan"):
                try:
                    lp = _quota_path(p, final_u)
                    if lp.exists():
                        lp.unlink()
                except Exception:
                    pass
        else:
            write_quota(proto, final_u, quota_gb, days, created_at, expired_at)

        from .detail import write_detail_txt
        detail_txt_path = write_detail_txt(cfg, proto, final_u, secret, days, quota_gb)

        return {
            "status": "ok",
            "username": final_u,
            "uuid": secret if proto != "trojan" else None,
            "password": secret if proto == "trojan" else None,
            "expired_at": expired_at,
            "detail_path": detail_txt_path,
            "backup_path": backup_path,
        }

    # --- del ---
    if action == "del":
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
            _rm(_quota_path("allproto", final_u))
            _rm(_detail_txt_path("allproto", final_u))
            for p in ("vless", "vmess", "trojan"):
                _rm(_quota_path(p, final_u))
                _rm(_detail_txt_path(p, final_u))
            _blocked_remove(final_u)
        else:
            _rm(_quota_path(proto, final_u))
            _rm(_detail_txt_path(proto, final_u))
            _blocked_remove(final_u)

        return {"status": "ok", "username": final_u, "removed": removed, "backup_path": backup_path}

    # --- renew ---
    if action == "renew":
        add_days = safe_int(req.get("add_days"), 0)
        if add_days <= 0 or add_days > 3650:
            return {"status": "error", "error": "add_days out of range (1..3650)"}

        qp = _quota_path(proto if proto != "allproto" else "allproto", final_u)
        if not qp.exists():
            return {"status": "error", "error": "quota metadata not found", "username": final_u}

        meta = _read_json_file(qp)
        old_exp = str(meta.get("expired_at") or "").strip()
        if not old_exp:
            return {"status": "error", "error": "expired_at missing in metadata"}

        try:
            old_dt = date.fromisoformat(old_exp)
        except Exception:
            return {"status": "error", "error": "expired_at invalid format"}

        new_dt = old_dt + timedelta(days=add_days)
        new_exp = new_dt.isoformat()
        meta["expired_at"] = new_exp

        _write_json_atomic(qp, meta)

        secret = _extract_secret_from_detail_txt(_detail_txt_path(proto, final_u))
        quota_gb = _quota_gb_from_bytes(meta.get("quota_limit"))
        days_remaining = _calc_days_remaining(new_exp)

        from .detail import write_detail_txt
        detail_txt_path = write_detail_txt(cfg, proto, final_u, secret, days_remaining, quota_gb)

        return {"status": "ok", "username": final_u, "expired_at": new_exp, "detail_path": detail_txt_path}

    # --- quota_get / quota_set ---
    if action == "quota_get":
        qp = _quota_path(proto if proto != "allproto" else "allproto", final_u)
        if not qp.exists():
            return {"status": "error", "error": "quota metadata not found", "username": final_u}
        meta = _read_json_file(qp)
        qb = meta.get("quota_limit", 0)
        return {
            "status": "ok",
            "username": final_u,
            "protocol": proto,
            "quota_limit": qb,
            "quota_gb": _quota_gb_from_bytes(qb),
            "expired_at": meta.get("expired_at"),
            "created_at": meta.get("created_at"),
        }

    if action == "quota_set":
        try:
            quota_gb = float(req.get("quota_gb", 0))
        except Exception:
            return {"status": "error", "error": "quota_gb must be number"}
        if quota_gb < 0:
            return {"status": "error", "error": "quota_gb must be >= 0"}

        qp = _quota_path(proto if proto != "allproto" else "allproto", final_u)
        if not qp.exists():
            return {"status": "error", "error": "quota metadata not found", "username": final_u}

        meta = _read_json_file(qp)
        meta["quota_limit"] = _quota_bytes_from_gb(quota_gb)
        _write_json_atomic(qp, meta)

        secret = _extract_secret_from_detail_txt(_detail_txt_path(proto, final_u))
        exp = str(meta.get("expired_at") or "").strip()
        days_remaining = _calc_days_remaining(exp)

        from .detail import write_detail_txt
        detail_txt_path = write_detail_txt(cfg, proto, final_u, secret, days_remaining, quota_gb)

        return {"status": "ok", "username": final_u, "quota_gb": quota_gb, "detail_path": detail_txt_path}

    # --- block/unblock ---
    if action == "block":
        op = str(req.get("op") or req.get("mode") or "").strip().lower()
        if op not in ("block", "unblock"):
            return {"status": "error", "error": "invalid op (block/unblock)"}

        if op == "block":
            if not email_exists(cfg, final_u):
                return {"status": "error", "error": "user not found in config", "username": final_u}

            secret = _extract_secret_from_detail_txt(_detail_txt_path(proto, final_u))

            removed = 0
            if proto == "allproto":
                removed += remove_client(cfg, "vless", final_u)
                removed += remove_client(cfg, "vmess", final_u)
                removed += remove_client(cfg, "trojan", final_u)
            else:
                removed = remove_client(cfg, proto, final_u)

            if removed == 0:
                return {"status": "error", "error": "user not found", "username": final_u}

            # ✅ add to routing blocked users (best-effort)
            note = None
            if not _blocked_rule_add(cfg, final_u):
                note = "blocked routing rule not found"

            backup_path = save_config_with_backup(cfg)
            restart_xray()

            _blocked_write(final_u, proto, secret)
            resp = {"status": "ok", "username": final_u, "blocked": True, "backup_path": backup_path}
            if note:
                resp["note"] = note
            return resp

        # unblock
        try:
            secret = _blocked_read_secret(final_u)
        except Exception as e:
            return {"status": "error", "error": f"blocked record missing: {e}", "username": final_u}

        if email_exists(cfg, final_u):
            _blocked_remove(final_u)
            return {"status": "ok", "username": final_u, "blocked": False, "note": "already present in config"}

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

        # ✅ remove from routing blocked users (best-effort)
        note = None
        if not _blocked_rule_remove(cfg, final_u):
            note = "blocked routing rule not found"

        backup_path = save_config_with_backup(cfg)
        restart_xray()
        _blocked_remove(final_u)

        resp = {"status": "ok", "username": final_u, "blocked": False, "backup_path": backup_path}
        if note:
            resp["note"] = note
        return resp

    return {"status": "error", "error": "unreachable"}