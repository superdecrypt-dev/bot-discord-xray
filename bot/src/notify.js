const fs = require("fs");
const path = require("path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

const {
  NOTIFY_STATE_PATH,
  NOTIFY_MIN_INTERVAL_MIN,
  NOTIFY_MAX_INTERVAL_MIN,
  NOTIFY_MAX_TIMEOUT_MS,
} = require("./config");

const { callBackend, mapBackendError } = require("./ipc");
const { safeMkdirp, clampInt, fmtDateTimeJakarta, badge } = require("./util");

let notifyCfg = {
  enabled: false,
  channel_id: null,
  interval_min: 60,
  last_run_at: null, // ISO
  last_error: null,
};

let notifyTimer = null;
let notifyNextRunAtMs = null;

function getNotifyCfg() {
  return notifyCfg;
}

function loadNotifyCfg() {
  try {
    if (!fs.existsSync(NOTIFY_STATE_PATH)) return;
    const raw = fs.readFileSync(NOTIFY_STATE_PATH, "utf8");
    const obj = JSON.parse(raw);

    notifyCfg.enabled = !!obj.enabled;
    notifyCfg.channel_id = obj.channel_id ? String(obj.channel_id) : null;

    const iv = Number(obj.interval_min);
    notifyCfg.interval_min = Number.isFinite(iv)
      ? clampInt(iv, NOTIFY_MIN_INTERVAL_MIN, NOTIFY_MAX_INTERVAL_MIN)
      : 60;

    notifyCfg.last_run_at = obj.last_run_at ? String(obj.last_run_at) : null;
    notifyCfg.last_error = obj.last_error ? String(obj.last_error) : null;
  } catch (_) {}
}

function saveNotifyCfg() {
  try {
    const dir = path.dirname(NOTIFY_STATE_PATH);
    if (!safeMkdirp(dir, 0o700)) return false;

    const tmp = `${NOTIFY_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notifyCfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, NOTIFY_STATE_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

function stopNotifyScheduler() {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = null;
  notifyNextRunAtMs = null;
}

function canRunNotify() {
  return notifyCfg.enabled && notifyCfg.channel_id && notifyCfg.interval_min >= NOTIFY_MIN_INTERVAL_MIN;
}

function scheduleNotifyLoop(client) {
  if (!canRunNotify()) return;

  if (!notifyNextRunAtMs) {
    notifyNextRunAtMs = Date.now() + (notifyCfg.interval_min * 60 * 1000);
  }

  const now = Date.now();
  const delayMs = Math.max(0, notifyNextRunAtMs - now);
  const waitMs = Math.min(delayMs, NOTIFY_MAX_TIMEOUT_MS);

  notifyTimer = setTimeout(async () => {
    if (!canRunNotify()) return;

    if (Date.now() >= notifyNextRunAtMs - 1000) {
      await sendNotifyTick(client).catch(() => {});
      notifyNextRunAtMs = Date.now() + (notifyCfg.interval_min * 60 * 1000);
    }

    scheduleNotifyLoop(client);
  }, waitMs);
}

function startNotifyScheduler(client) {
  stopNotifyScheduler();
  if (!canRunNotify()) return;
  scheduleNotifyLoop(client);
}

function buildNotifyMessageText({ wsMs, ipcMs, xrayState, nginxState, error }) {
  const ts = fmtDateTimeJakarta(new Date());

  const lines = [];
  lines.push("```");
  lines.push("🛎️ NOTIFIKASI XRAY (Berkala)");
  lines.push(`Waktu: ${ts}`);
  lines.push("");

  if (error) {
    lines.push("❌ ERROR");
    lines.push(String(error).slice(0, 900));
    lines.push("```");
    return lines.join("\n");
  }

  lines.push("🏓 Ping");
  lines.push(`Discord WS : ${wsMs} ms`);
  lines.push(`Backend IPC: ${ipcMs} ms`);
  lines.push("");
  lines.push("🧩 Status");
  lines.push(`Xray : ${badge(xrayState)}`);
  lines.push(`Nginx: ${badge(nginxState)}`);
  lines.push("```");
  return lines.join("\n");
}

async function sendNotifyTick(client, { force = false } = {}) {
  if (!force && !canRunNotify()) return;
  if (!notifyCfg.channel_id) return;

  const channelId = String(notifyCfg.channel_id);
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    notifyCfg.last_error = `Channel invalid / not text-based: ${channelId}`;
    saveNotifyCfg();
    return;
  }

  const wsMs = Math.round(client.ws.ping);
  const t0 = Date.now();

  try {
    const pingResp = await callBackend({ action: "ping" });
    const statusResp = await callBackend({ action: "status" });
    const ipcMs = Date.now() - t0;

    if (!pingResp || pingResp.status !== "ok") {
      const msg = pingResp && pingResp.error ? pingResp.error : "backend ping failed";
      notifyCfg.last_error = msg;
      notifyCfg.last_run_at = new Date().toISOString();
      saveNotifyCfg();
      await ch.send({ content: buildNotifyMessageText({ wsMs, ipcMs, error: msg }) });
      return;
    }

    if (!statusResp || statusResp.status !== "ok") {
      const msg = statusResp && statusResp.error ? statusResp.error : "backend status failed";
      notifyCfg.last_error = msg;
      notifyCfg.last_run_at = new Date().toISOString();
      saveNotifyCfg();
      await ch.send({ content: buildNotifyMessageText({ wsMs, ipcMs, error: msg }) });
      return;
    }

    notifyCfg.last_error = null;
    notifyCfg.last_run_at = new Date().toISOString();
    saveNotifyCfg();

    await ch.send({
      content: buildNotifyMessageText({
        wsMs,
        ipcMs,
        xrayState: statusResp.xray,
        nginxState: statusResp.nginx
      })
    });
  } catch (e) {
    const msg = mapBackendError(e);
    notifyCfg.last_error = msg;
    notifyCfg.last_run_at = new Date().toISOString();
    saveNotifyCfg();
    try {
      await ch.send({ content: buildNotifyMessageText({ wsMs: Math.round(client.ws.ping), ipcMs: 0, error: msg }) });
    } catch (_) {}
  }
}

function buildNotifyPanel({ extraRow } = {}) {
  const status = notifyCfg.enabled ? "🟢 ON" : "🔴 OFF";
  const ch = notifyCfg.channel_id ? `<#${notifyCfg.channel_id}>` : "`(belum diatur)`";
  const iv = `${notifyCfg.interval_min} menit`;
  const lastRun = notifyCfg.last_run_at ? `\`${fmtDateTimeJakarta(notifyCfg.last_run_at)}\`` : "`-`";
  const lastErr = notifyCfg.last_error ? `\`${String(notifyCfg.last_error).slice(0, 180)}\`` : "`-`";

  const embed = new EmbedBuilder()
    .setTitle("🛎️ Notify Panel")
    .setDescription(
      [
        "**Cara pakai:**",
        "1) Klik **Set Channel** → pilih channel notifikasi",
        `2) Klik **Set Interval** (menit) — bisa ${NOTIFY_MIN_INTERVAL_MIN} menit s/d unlimited`,
        "3) Klik **Enable/Disable** untuk toggle",
        "4) Klik **Test Now** untuk kirim 1x sekarang",
      ].join("\n")
    )
    .addFields(
      { name: "Status", value: status, inline: true },
      { name: "Channel", value: ch, inline: true },
      { name: "Interval", value: iv, inline: true },
      { name: "Last Run", value: lastRun, inline: false },
      { name: "Last Error", value: lastErr, inline: false },
    )
    .setFooter({ text: "Notifikasi berkala mengirim Ping + Status (text-only) ke channel target." });

  const toggleBtn = new ButtonBuilder()
    .setCustomId("notify:toggle")
    .setLabel(notifyCfg.enabled ? "Disable" : "Enable")
    .setStyle(notifyCfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
    .setEmoji(notifyCfg.enabled ? "🛑" : "✅");

  const testBtn = new ButtonBuilder()
    .setCustomId("notify:test")
    .setLabel("Test Now")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🧪");

  const refreshBtn = new ButtonBuilder()
    .setCustomId("notify:refresh")
    .setLabel("Refresh")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔄");

  const setChannelBtn = new ButtonBuilder()
    .setCustomId("notify:set_channel")
    .setLabel("Set Channel")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("📌");

  const setIntervalBtn = new ButtonBuilder()
    .setCustomId("notify:set_interval")
    .setLabel("Set Interval")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("⏱️");

  const row1 = new ActionRowBuilder().addComponents(toggleBtn, testBtn, refreshBtn);
  const row2 = new ActionRowBuilder().addComponents(setChannelBtn, setIntervalBtn);

  const components = [row1, row2];
  if (extraRow) components.splice(1, 0, extraRow);
  return { embeds: [embed], components };
}

function buildNotifyChannelSelectRow() {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId("notify:channel_select")
    .setPlaceholder("Pilih channel notifikasi…")
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

  return new ActionRowBuilder().addComponents(menu);
}

function buildNotifyIntervalModal() {
  const modal = new ModalBuilder()
    .setCustomId("notify:interval_modal")
    .setTitle("Set Interval Notifikasi (menit)");

  const minutesInput = new TextInputBuilder()
    .setCustomId("minutes")
    .setLabel(`Interval (menit) ${NOTIFY_MIN_INTERVAL_MIN}..${NOTIFY_MAX_INTERVAL_MIN}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("60");

  modal.addComponents(new ActionRowBuilder().addComponents(minutesInput));
  return modal;
}

module.exports = {
  getNotifyCfg,
  loadNotifyCfg,
  saveNotifyCfg,
  startNotifyScheduler,
  stopNotifyScheduler,
  sendNotifyTick,
  buildNotifyPanel,
  buildNotifyChannelSelectRow,
  buildNotifyIntervalModal,
};
