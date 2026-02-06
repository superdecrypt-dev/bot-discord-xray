import base64
import json
from typing import Any, Dict, List
from urllib.parse import quote


def _vmess_b64(obj: Dict[str, Any]) -> str:
    # Match common CLI behaviour: standard base64 with padding
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")

def collect_inbounds(cfg: Dict[str, Any], proto: str):
    res = []
    inbounds = cfg.get("inbounds", [])
    if not isinstance(inbounds, list):
        return res
    for ib in inbounds:
        if not isinstance(ib, dict) or ib.get("protocol") != proto:
            continue
        port = ib.get("port")
        stream = ib.get("streamSettings") if isinstance(ib.get("streamSettings"), dict) else {}
        network = stream.get("network", "tcp")
        security = stream.get("security", "tls") or "tls"
        res.append((port, network, security, stream))
    return res

def build_links_for_vless(domain: str, email: str, uuid: str, items, public_port: int):
    links: List[str] = []
    def add(label, link):
        links.append(f"{label:10}: {link}")

    # Use public endpoints (nginx) for stability/consistency
    port = public_port
    add("WebSocket", f"vless://{uuid}@{domain}:{port}?security=tls&encryption=none&type=ws&path=%2Fvless-ws#" + quote(email))
    add("HTTPUpgrade", f"vless://{uuid}@{domain}:{port}?security=tls&encryption=none&type=httpupgrade&path=%2Fvless-hu#" + quote(email))
    add("gRPC", f"vless://{uuid}@{domain}:{port}?security=tls&encryption=none&type=grpc&serviceName=vless-grpc&mode=gun#" + quote(email))
    return links

def build_links_for_trojan(domain: str, email: str, pwd: str, items, public_port: int):
    links: List[str] = []
    def add(label, link):
        links.append(f"{label:10}: {link}")
    port = public_port
    # Use public endpoints (nginx)
    add("WebSocket", f"trojan://{pwd}@{domain}:{port}?security=tls&type=ws&path=%2Ftrojan-ws#" + quote(email))
    add("HTTPUpgrade", f"trojan://{pwd}@{domain}:{port}?security=tls&type=httpupgrade&path=%2Ftrojan-hu#" + quote(email))
    add("gRPC", f"trojan://{pwd}@{domain}:{port}?security=tls&type=grpc&serviceName=trojan-grpc&mode=gun#" + quote(email))
    return links

def build_links_for_vmess(domain: str, email: str, uuid: str, items, public_port: int):
    links: List[str] = []
    def add(label, link):
        links.append(f"{label:10}: {link}")

    port = public_port

    ws_obj = {
        "v": "2",
        "ps": email,
        "add": domain,
        "port": str(port),
        "id": uuid,
        "aid": "0",
        "scy": "auto",
        "net": "ws",
        "type": "none",
        "host": domain,
        "path": "/vmess-ws",
        "tls": "tls",
        "sni": domain,
    }
    add("WebSocket", f"vmess://{_vmess_b64(ws_obj)}")

    hu_obj = {
        "v": "2",
        "ps": email,
        "add": domain,
        "port": str(port),
        "id": uuid,
        "aid": "0",
        "scy": "auto",
        "net": "httpupgrade",
        "type": "none",
        "host": domain,
        "path": "/vmess-hu",
        "tls": "tls",
        "sni": domain,
    }
    add("HTTPUpgrade", f"vmess://{_vmess_b64(hu_obj)}")

    grpc_obj = {
        "v": "2",
        "ps": email,
        "add": domain,
        "port": str(port),
        "id": uuid,
        "aid": "0",
        "scy": "auto",
        "net": "grpc",
        "type": "none",
        "host": domain,
        "path": "vmess-grpc",
        "tls": "tls",
        "sni": domain,
    }
    add("gRPC", f"vmess://{_vmess_b64(grpc_obj)}")

    return links
