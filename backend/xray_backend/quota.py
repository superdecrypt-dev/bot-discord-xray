import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .constants import QUOTA_DIR, DETAIL_BASE, VALID_PROTO

def quota_bytes_from_gb(quota_gb: float) -> int:
    if quota_gb <= 0:
        return 0
    return int(round(quota_gb * 1073741824))

def write_quota(proto: str, final_u: str, quota_gb: float, days: int, created_at: str, expired_at: str) -> str:
    d = QUOTA_DIR / proto
    d.mkdir(parents=True, exist_ok=True)

    obj = {
        "username": final_u,
        "protocol": proto,
        "quota_limit": quota_bytes_from_gb(quota_gb),
        "created_at": created_at,
        "expired_at": expired_at,
    }
    p = d / f"{final_u}.json"
    p.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    return str(p)

def safe_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default

def quota_scan_protos(proto_filter: str) -> List[str]:
    pf = (proto_filter or "").strip().lower()
    if pf in ("", "all", "*"):
        return ["vless", "vmess", "trojan", "allproto"]
    if pf in VALID_PROTO:
        return [pf]
    return []

def scan_quota_items(proto_filter: str) -> List[Dict[str, Any]]:
    protos = quota_scan_protos(proto_filter)
    if not protos:
        return []

    by_user: Dict[str, Tuple[float, Dict[str, Any]]] = {}

    for proto in protos:
        d = QUOTA_DIR / proto
        if not d.exists() or not d.is_dir():
            continue

        for p in d.glob("*.json"):
            try:
                obj = json.loads(p.read_text(encoding="utf-8"))
                if not isinstance(obj, dict):
                    continue

                username = str(obj.get("username") or "").strip()
                pproto = str(obj.get("protocol") or proto).strip().lower()
                expired_at = str(obj.get("expired_at") or "").strip()
                created_at = str(obj.get("created_at") or "").strip()
                quota_limit = obj.get("quota_limit")

                if pproto not in VALID_PROTO:
                    continue
                if not username or not username.endswith(f"@{pproto}"):
                    continue

                base = DETAIL_BASE["allproto"] if pproto == "allproto" else DETAIL_BASE[pproto]
                detail_path = str(base / f"{username}.txt")

                item = {
                    "username": username,
                    "protocol": pproto,
                    "expired_at": expired_at,
                    "created_at": created_at,
                    "quota_limit": quota_limit,
                    "detail_path": detail_path,
                }

                mtime = p.stat().st_mtime
                prev = by_user.get(username)
                if prev is None or mtime >= prev[0]:
                    by_user[username] = (mtime, item)
            except Exception:
                continue

    items = [v[1] for v in by_user.values()]

    def sort_key(it: Dict[str, Any]):
        exp = str(it.get("expired_at") or "").strip() or "9999-12-31"
        return (exp, str(it.get("username") or ""))

    items.sort(key=sort_key)
    return items
