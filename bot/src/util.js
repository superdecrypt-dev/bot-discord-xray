const fs = require("fs");

const JAKARTA_TZ = "Asia/Jakarta";

function badge(state) {
  state = String(state || "").trim().toLowerCase();
  if (state === "active") return "🟢 active";
  if (state === "inactive") return "🔴 inactive";
  if (state === "failed") return "🔴 failed";
  return `⚪ ${state || "unknown"}`;
}

function clampInt(n, min, max) {
  n = Number.isFinite(n) ? Math.trunc(n) : min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function safeMkdirp(dir, mode = 0o700) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Format date/time to: YYYY-MM-DD HH:mm:ss (Asia/Jakarta)
 */
function fmtDateTimeJakarta(dateOrIso) {
  try {
    const d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
    if (isNaN(d.getTime())) return "-";

    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: JAKARTA_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);

    const get = (type) => parts.find(p => p.type === type)?.value || "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  } catch (_) {
    try {
      const d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
      if (isNaN(d.getTime())) return "-";
      const j = new Date(d.getTime() + 7 * 60 * 60 * 1000);
      return j.toISOString().slice(0, 19).replace("T", " ");
    } catch {
      return "-";
    }
  }
}

function isAdmin(member, adminRoleId) {
  try {
    return member && member.roles && member.roles.cache && member.roles.cache.has(String(adminRoleId));
  } catch (_) {
    return false;
  }
}

function parseFinalEmail(finalEmail) {
  const m = /^([A-Za-z0-9_]+)@(vless|vmess|trojan|allproto)$/.exec(String(finalEmail || "").trim());
  if (!m) return null;
  return { base: m[1], proto: m[2], final: `${m[1]}@${m[2]}` };
}

module.exports = {
  badge,
  clampInt,
  safeMkdirp,
  fmtDateTimeJakarta,
  isAdmin,
  parseFinalEmail,
};
