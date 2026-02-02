import re
from pathlib import Path
from typing import List, Optional

def read_domain_from_nginx_conf() -> str:
    conf = Path("/etc/nginx/conf.d/xray.conf")
    if not conf.exists():
        return "unknown"
    try:
        txt = conf.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r"^\s*server_name\s+([^;]+);", txt, flags=re.M)
        if m:
            return m.group(1).strip().split()[0]
    except Exception:
        pass
    return "unknown"

def read_public_port_from_nginx_conf(default: int = 443) -> int:
    conf = Path("/etc/nginx/conf.d/xray.conf")
    if not conf.exists():
        return default

    def extract_port(listen_value: str) -> Optional[int]:
        s = listen_value.strip()
        m = re.search(r":(\d{2,5})\b", s)
        if m:
            p = int(m.group(1))
            if 1 <= p <= 65535:
                return p
        m2 = re.search(r"\b(\d{2,5})\b", s)
        if m2:
            p = int(m2.group(1))
            if 1 <= p <= 65535:
                return p
        return None

    try:
        txt = conf.read_text(encoding="utf-8", errors="ignore")
        listens = re.findall(r"^\s*listen\s+([^;]+);", txt, flags=re.M)

        ssl_ports: List[int] = []
        nonssl_ports: List[int] = []

        for lv in listens:
            port = extract_port(lv)
            if port is None:
                continue
            is_ssl = re.search(r"\bssl\b", lv) is not None
            if is_ssl:
                ssl_ports.append(port)
            else:
                nonssl_ports.append(port)

        if ssl_ports:
            return ssl_ports[0]
        if nonssl_ports:
            return nonssl_ports[0]
    except Exception:
        pass

    return default
