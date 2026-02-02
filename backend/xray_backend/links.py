import base64
import json
from typing import Any, Dict, List
from urllib.parse import quote

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

    if not items:
        add("WebSocket", f"vless://{uuid}@{domain}:{public_port}?security=tls&encryption=none&type=ws&path=%2F#" + quote(email))
        return links

    seen = set()
    for _port, network, security, stream in items:
        port = public_port
        ws = stream.get("wsSettings", {}) if isinstance(stream.get("wsSettings"), dict) else {}
        grpc = stream.get("grpcSettings", {}) if isinstance(stream.get("grpcSettings"), dict) else {}
        http = stream.get("httpSettings", {}) if isinstance(stream.get("httpSettings"), dict) else {}

        if network == "ws":
            path_ = ws.get("path", "/")
            key = ("ws", port, path_, security)
            if key in seen: continue
            seen.add(key)
            add("WebSocket", f"vless://{uuid}@{domain}:{port}?security={security}&encryption=none&type=ws&path={quote(path_)}#" + quote(email))

        elif network == "grpc":
            sn = grpc.get("serviceName", "grpc")
            key = ("grpc", port, sn, security)
            if key in seen: continue
            seen.add(key)
            add("gRPC", f"vless://{uuid}@{domain}:{port}?security={security}&encryption=none&type=grpc&serviceName={quote(sn)}&mode=gun#" + quote(email))

        elif network == "httpupgrade":
            path_ = http.get("path", "/")
            key = ("httpupgrade", port, path_, security)
            if key in seen: continue
            seen.add(key)
            add("HTTPUpgrade", f"vless://{uuid}@{domain}:{port}?security={security}&encryption=none&type=httpupgrade&path={quote(path_)}#" + quote(email))

        else:
            key = ("tcp", port, security)
            if key in seen: continue
            seen.add(key)
            add("TCP", f"vless://{uuid}@{domain}:{port}?security={security}&encryption=none&type=tcp#" + quote(email))

    return links

def build_links_for_trojan(domain: str, email: str, pwd: str, items, public_port: int):
    links: List[str] = []
    def add(label, link):
        links.append(f"{label:10}: {link}")
    add("TLS", f"trojan://{pwd}@{domain}:{public_port}?security=tls&type=tcp#" + quote(email))
    return links

def build_links_for_vmess(domain: str, email: str, uuid: str, items, public_port: int):
    links: List[str] = []
    def add(label, link):
        links.append(f"{label:10}: {link}")

    if not items:
        obj = {
            "v": "2",
            "ps": email,
            "add": domain,
            "port": str(public_port),
            "id": uuid,
            "aid": "0",
            "net": "ws",
            "type": "none",
            "host": domain,
            "path": "/",
            "tls": "tls",
        }
        b64 = base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")
        add("WebSocket", f"vmess://{b64}")
        return links

    seen = set()
    for _port, network, security, stream in items:
        port = public_port
        ws = stream.get("wsSettings", {}) if isinstance(stream.get("wsSettings"), dict) else {}
        grpc = stream.get("grpcSettings", {}) if isinstance(stream.get("grpcSettings"), dict) else {}
        http = stream.get("httpSettings", {}) if isinstance(stream.get("httpSettings"), dict) else {}

        if network == "ws":
            path_ = ws.get("path", "/")
            key = ("ws", port, path_, security)
            if key in seen: continue
            seen.add(key)
            obj = {
                "v": "2",
                "ps": email,
                "add": domain,
                "port": str(port),
                "id": uuid,
                "aid": "0",
                "net": "ws",
                "type": "none",
                "host": domain,
                "path": path_,
                "tls": security,
            }
            b64 = base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")
            add("WebSocket", f"vmess://{b64}")

        elif network == "grpc":
            sn = grpc.get("serviceName", "grpc")
            key = ("grpc", port, sn, security)
            if key in seen: continue
            seen.add(key)
            obj = {
                "v": "2",
                "ps": email,
                "add": domain,
                "port": str(port),
                "id": uuid,
                "aid": "0",
                "net": "grpc",
                "type": "gun",
                "host": domain,
                "path": sn,
                "tls": security,
            }
            b64 = base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")
            add("gRPC", f"vmess://{b64}")

        elif network == "httpupgrade":
            path_ = http.get("path", "/")
            key = ("httpupgrade", port, path_, security)
            if key in seen: continue
            seen.add(key)
            obj = {
                "v": "2",
                "ps": email,
                "add": domain,
                "port": str(port),
                "id": uuid,
                "aid": "0",
                "net": "httpupgrade",
                "type": "none",
                "host": domain,
                "path": path_,
                "tls": security,
            }
            b64 = base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")
            add("HTTPUpgrade", f"vmess://{b64}")

        else:
            key = ("tcp", port, security)
            if key in seen: continue
            seen.add(key)
            obj = {
                "v": "2",
                "ps": email,
                "add": domain,
                "port": str(port),
                "id": uuid,
                "aid": "0",
                "net": "tcp",
                "type": "none",
                "host": domain,
                "path": "",
                "tls": security,
            }
            b64 = base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).decode("ascii").rstrip("=")
            add(network.upper(), f"vmess://{b64}")

    return links
