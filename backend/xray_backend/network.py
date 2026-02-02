import subprocess

def get_public_ip() -> str:
    # public IP from ifconfig.me
    try:
        out = subprocess.check_output(
            ["curl", "-s", "--max-time", "5", "ifconfig.me"],
            text=True
        ).strip()
        if out and len(out) <= 64:
            return out
    except Exception:
        pass

    # fallback
    try:
        out = subprocess.check_output(["bash", "-lc", "hostname -I | awk '{print $1}'"], text=True).strip()
        if out:
            return out
    except Exception:
        pass

    return "unknown"
