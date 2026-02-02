import subprocess

def restart_xray() -> None:
    subprocess.check_call(["systemctl", "restart", "xray"])

def svc_state(name: str) -> str:
    try:
        p = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True)
        out = (p.stdout or "").strip()
        err = (p.stderr or "").strip()
        return out or err or "unknown"
    except Exception:
        return "unknown"
