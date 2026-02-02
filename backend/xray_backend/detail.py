import json
import subprocess
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Any, Dict, List

from .constants import DETAIL_BASE
from .nginx_conf import read_domain_from_nginx_conf, read_public_port_from_nginx_conf
from .network import get_public_ip
from .links import collect_inbounds, build_links_for_vless, build_links_for_vmess, build_links_for_trojan

def fmt_quota_gb(quota_gb: float) -> str:
    if quota_gb <= 0:
        return "Unlimited"
    if abs(quota_gb - int(quota_gb)) < 1e-9:
        return f"{int(quota_gb)} GB"
    return f"{quota_gb:g} GB"

def write_detail_json(proto: str, final_u: str, secret: str, days: int, quota_gb: float) -> str:
    base = DETAIL_BASE["allproto"] if proto == "allproto" else DETAIL_BASE[proto]
    base.mkdir(parents=True, exist_ok=True)

    domain = read_domain_from_nginx_conf()
    ip = get_public_ip()

    expired_at = (date.today() + timedelta(days=days)).isoformat()
    created_at = datetime.now().strftime("%a %b %e %H:%M:%S %Z %Y")
    quota = fmt_quota_gb(quota_gb)

    detail = {
        "domain": domain,
        "ip": ip,
        "username": final_u,
        "protocol": proto,
        "uuid": secret if proto in ("vless", "vmess", "allproto") else None,
        "password": secret if proto == "trojan" else None,
        "quota_limit": quota,
        "expired_days": days,
        "valid_until": expired_at,
        "created": created_at,
    }

    p = base / f"{final_u}.json"
    p.write_text(json.dumps(detail, indent=2) + "\n", encoding="utf-8")
    return str(p)

def write_detail_txt(cfg: Dict[str, Any], proto: str, final_user: str, secret: str, days: int, quota_gb: float) -> str:
    domain = read_domain_from_nginx_conf()
    ipaddr = get_public_ip()
    public_port = read_public_port_from_nginx_conf(443)

    valid_until = (date.today() + timedelta(days=days)).isoformat()

    try:
        created = datetime.now().strftime("%a %b %d %H:%M:%S %Z %Y").strip()
        if not created:
            created = datetime.now().strftime("%a %b %d %H:%M:%S %Y")
    except Exception:
        created = datetime.now().strftime("%a %b %d %H:%M:%S %Y")

    quota_str = fmt_quota_gb(quota_gb)

    vless_items = collect_inbounds(cfg, "vless")
    vmess_items = collect_inbounds(cfg, "vmess")
    trojan_items = collect_inbounds(cfg, "trojan")

    lines: List[str] = []
    lines.append("=" * 50)
    lines.append(f"{('XRAY ACCOUNT DETAIL (' + proto + ')'):^50}")
    lines.append("=" * 50)
    lines.append(f"Domain     : {domain}")
    lines.append(f"IP         : {ipaddr}")
    lines.append(f"Username   : {final_user}")
    lines.append(f"UUID/Pass  : {secret}")
    lines.append(f"QuotaLimit : {quota_str}")
    lines.append(f"Expired    : {days} Hari")
    lines.append(f"ValidUntil : {valid_until}")
    lines.append(f"Created    : {created}")
    lines.append("=" * 50)

    if proto == "vless":
        lines.append("[VLESS]")
        lines.extend(build_links_for_vless(domain, final_user, secret, vless_items, public_port))
    elif proto == "vmess":
        lines.append("[VMESS]")
        lines.extend(build_links_for_vmess(domain, final_user, secret, vmess_items, public_port))
    elif proto == "trojan":
        lines.append("[TROJAN]")
        lines.extend(build_links_for_trojan(domain, final_user, secret, trojan_items, public_port))
    else:
        lines.append("[VLESS]")
        lines.extend(build_links_for_vless(domain, final_user, secret, vless_items, public_port))
        lines.append("-" * 50)
        lines.append("[VMESS]")
        lines.extend(build_links_for_vmess(domain, final_user, secret, vmess_items, public_port))
        lines.append("-" * 50)
        lines.append("[TROJAN]")
        lines.extend(build_links_for_trojan(domain, final_user, secret, trojan_items, public_port))

    lines.append("-" * 50)
    lines.append("=" * 50)

    content = "\n".join(lines) + "\n"

    base = DETAIL_BASE["allproto"] if proto == "allproto" else DETAIL_BASE[proto]
    base.mkdir(parents=True, exist_ok=True)
    out = base / f"{final_user}.txt"
    out.write_text(content, encoding="utf-8")
    return str(out)
