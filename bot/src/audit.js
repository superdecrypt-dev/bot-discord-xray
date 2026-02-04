const fs = require("fs");
const path = require("path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType } = require("discord.js");
const { safeMkdirp, fmtDateTimeJakarta } = require("./util");

const AUDIT_STATE_PATH = "/opt/xray-discord-bot/state/audit.json";
const MAX_EVENTS = 25;

let auditCfg = {
  enabled: false,
  channel_id: null,
  last_error: null,
  last_events: [], // newest first
};

function getAuditCfg() {
  return auditCfg;
}

function loadAuditCfg() {
  try {
    if (!fs.existsSync(AUDIT_STATE_PATH)) return;
    const raw = fs.readFileSync(AUDIT_STATE_PATH, "utf8");
    const obj = JSON.parse(raw);

    auditCfg.enabled = !!obj.enabled;
    auditCfg.channel_id = obj.channel_id ? String(obj.channel_id) : null;
    auditCfg.last_error = obj.last_error ? String(obj.last_error) : null;
    auditCfg.last_events = Array.isArray(obj.last_events) ? obj.last_events.slice(0, MAX_EVENTS) : [];
  } catch (_) {}
}

function saveAuditCfg() {
  try {
    const dir = path.dirname(AUDIT_STATE_PATH);
    if (!safeMkdirp(dir, 0o700)) return false;

    const tmp = `${AUDIT_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(auditCfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AUDIT_STATE_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

function _pushEvent(ev) {
  auditCfg.last_events.unshift(ev);
  if (auditCfg.last_events.length > MAX_EVENTS) {
    auditCfg.last_events.length = MAX_EVENTS;
  }
}

function _userTag(user) {
  if (!user) return "-";
  return user.tag || `${user.username}${user.discriminator ? "#" + user.discriminator : ""}`;
}

async function auditLog(client, { actor, action, detail, guildId } = {}) {
  try {
    const ev = {
      at: new Date().toISOString(),
      actor_tag: _userTag(actor),
      actor_id: actor && actor.id ? String(actor.id) : "-",
      action: String(action || "-").slice(0, 64),
      detail: detail ? String(detail).slice(0, 512) : "",
    };

    _pushEvent(ev);
    auditCfg.last_error = null;
    saveAuditCfg();

    if (!auditCfg.enabled || !auditCfg.channel_id) return;

    // Best-effort send to audit channel
    const ch = await client.channels.fetch(auditCfg.channel_id).catch(() => null);
    if (!ch || !(ch.isTextBased && ch.isTextBased())) return;

    if (guildId && ch.guildId && String(ch.guildId) !== String(guildId)) return;

    const ts = fmtDateTimeJakarta(ev.at);
    const lines = [
      `🧾 **AUDIT** \`${ts}\``,
      `User: <@${ev.actor_id}> \`(${ev.actor_id})\``,
      `Action: \`${ev.action}\``,
      ev.detail ? `Detail: ${ev.detail}` : null,
    ].filter(Boolean);

    await ch.send({ content: lines.join("\n").slice(0, 1990) });
  } catch (e) {
    auditCfg.last_error = String(e && e.message ? e.message : e);
    saveAuditCfg();
  }
}

function buildAuditPanel({ extraRow, page } = {}) {
  const enabled = auditCfg.enabled;
  const ch = auditCfg.channel_id ? `<#${auditCfg.channel_id}>` : "*(not set)*";

  const events = Array.isArray(auditCfg.last_events) ? auditCfg.last_events : [];
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(events.length / pageSize));
  page = Number.isFinite(Number(page)) ? parseInt(String(page), 10) : 0;
  if (page < 0) page = 0;
  if (page > totalPages - 1) page = totalPages - 1;

  const slice = events.slice(page * pageSize, page * pageSize + pageSize);
  const preview = slice
    .map((ev, i) => {
      const ts = fmtDateTimeJakarta(ev.at || "-");
      const who = ev.actor_tag || "-";
      const act = ev.action || "-";
      const idx = page * pageSize + i + 1;
      return `${idx}. \`${ts}\` **${who}** → \`${act}\``;
    })
    // ✅ FIX: sebelumnya string literal pecah jadi newline (SyntaxError)
    .join("\n") || "*(no events)*";

  const e = new EmbedBuilder()
    .setTitle("🧾 Audit Panel")
    .setDescription("Mencatat aktivitas admin pada bot (opsional).")
    .addFields(
      { name: "Enabled", value: enabled ? "✅ ON" : "❌ OFF", inline: true },
      { name: "Audit Channel", value: ch, inline: true },
      { name: "Last Events", value: preview.slice(0, 1024), inline: false }
    )
    .setFooter({ text: `Page ${page + 1}/${totalPages} | Total ${events.length}` });

  if (auditCfg.last_error) {
    e.addFields({ name: "Last Error", value: String(auditCfg.last_error).slice(0, 1024) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("audit:toggle")
      .setLabel(enabled ? "Disable" : "Enable")
      .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("audit:set_channel").setLabel("Set Channel").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("audit:test").setLabel("Test").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("audit:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
  );

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`audit:prev:${page}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`audit:next:${page}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(page >= totalPages - 1)
  );

  const components = [row, nav];
  if (extraRow) components.push(extraRow);
  return { content: null, embeds: [e], components };
}

function buildAuditChannelSelectRow() {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId("audit:channel_select")
    .setPlaceholder("Pilih channel untuk audit log")
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  return new ActionRowBuilder().addComponents(menu);
}

module.exports = {
  AUDIT_STATE_PATH,
  getAuditCfg,
  loadAuditCfg,
  saveAuditCfg,
  auditLog,
  buildAuditPanel,
  buildAuditChannelSelectRow,
};