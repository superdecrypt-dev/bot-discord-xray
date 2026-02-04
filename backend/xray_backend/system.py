import subprocess

def restart_xray() -> None:
    subprocess.check_call(["systemctl", "restart", "xray"])

def svc_state(name: str) -> dict:
    try:
        p = subprocess.run(
            ["systemctl", "is-active", name],
            capture_output=True,
            text=True
        )
        state = (p.stdout or "").strip()
        err = (p.stderr or "").strip()

        # systemctl is-active: returncode 0 only when active
        active = (state == "active")

        out = {
            "name": name,
            "active": bool(active),
            "state": state or "unknown",
        }
        if err:
            out["error"] = err[:300]
        return out
    except Exception as e:
        return {"name": name, "active": False, "state": "unknown", "error": str(e)[:300]}