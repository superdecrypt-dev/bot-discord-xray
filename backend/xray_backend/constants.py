import re
from pathlib import Path

CONFIG = Path("/usr/local/etc/xray/config.json")
ROLLING_BACKUP = Path("/usr/local/etc/xray/config.json.backup")

QUOTA_DIR = Path("/opt/quota")
DETAIL_BASE = {
    "vless": Path("/opt/vless"),
    "vmess": Path("/opt/vmess"),
    "trojan": Path("/opt/trojan"),
    "allproto": Path("/opt/allproto"),
}

VALID_PROTO = {"vless","vmess","trojan","allproto"}
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]+$")
