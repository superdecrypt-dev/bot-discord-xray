const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const SOCK_PATH = "/run/xray-backend.sock";
const BACKEND_TIMEOUT_MS = 8000;
const QUICK_REPLY_MS = 1200;

const PAGE_SIZE = 25;
const ADD_PROTOCOLS = ["vless", "vmess", "trojan", "allproto"];
const LIST_PROTOCOLS = ["all", "vless", "vmess", "trojan", "allproto"];

const HELP_TABS = [
  "overview",
  "accounts",
  "add",
  "del",
  "notify",
  "ping",
  "status",
  // Discord server interaction modules
  "purge",
  "channel",
  "welcome",
  "audit",
];

const NOTIFY_STATE_PATH = "/opt/xray-discord-bot/state/notify.json";
const NOTIFY_MIN_INTERVAL_MIN = 1;
const NOTIFY_MAX_INTERVAL_MIN = 52560000; // 100 years
const NOTIFY_MAX_TIMEOUT_MS = 2_000_000_000;

function assertEnv() {
  if (!TOKEN || !GUILD_ID || !ADMIN_ROLE_ID || !CLIENT_ID) {
    console.error("Missing env vars: DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_ADMIN_ROLE_ID / DISCORD_CLIENT_ID");
    process.exit(1);
  }
}

module.exports = {
  TOKEN,
  GUILD_ID,
  ADMIN_ROLE_ID,
  CLIENT_ID,

  SOCK_PATH,
  BACKEND_TIMEOUT_MS,
  QUICK_REPLY_MS,

  PAGE_SIZE,
  ADD_PROTOCOLS,
  LIST_PROTOCOLS,
  HELP_TABS,

  NOTIFY_STATE_PATH,
  NOTIFY_MIN_INTERVAL_MIN,
  NOTIFY_MAX_INTERVAL_MIN,
  NOTIFY_MAX_TIMEOUT_MS,

  assertEnv,
};
