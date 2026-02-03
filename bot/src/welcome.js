const fs = require("fs");
const path = require("path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const { safeMkdirp, fmtDateTimeJakarta } = require("./util");

const WELCOME_STATE_PATH = "/opt/xray-discord-bot/state/welcome.json";

let welcomeCfg = {
  enabled: false,
  channel_id: null,
  template: "Selamat datang {user} di **{server}**! 🎉",
  last_sent_at: null,
  last_error: null,
};

function getWelcomeCfg() {
  return welcomeCfg;
}

function loadWelcomeCfg() {
  try {
    if (!fs.existsSync(WELCOME_STATE_PATH)) return;
    const raw = fs.readFileSync(WELCOME_STATE_PATH, "utf8");
    const obj = JSON.parse(raw);

    welcomeCfg.enabled = !!obj.enabled;
    welcomeCfg.channel_id = obj.channel_id ? String(obj.channel_id) : null;
    welcomeCfg.template = obj.template ? String(obj.template) : welcomeCfg.template;
    welcomeCfg.last_sent_at = obj.last_sent_at ? String(obj.last_sent_at) : null;
    welcomeCfg.last_error = obj.last_error ? String(obj.last_error) : null;
  } catch (_) {}
}

function saveWelcomeCfg() {
  try {
    const dir = path.dirname(WELCOME_STATE_PATH);
    if (!safeMkdirp(dir, 0o700)) return false;

    const tmp = `${WELCOME_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(welcomeCfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, WELCOME_STATE_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

function renderWelcomeMessage(member) {
  const tpl = String(welcomeCfg.template || "").trim() || "Selamat datang {user}!";
  const server = member && member.guild ? member.guild.name : "server";
  const userMention = member ? `<@${member.id}>` : "{user}";
  const username = member && member.user ? member.user.username : "user";

  return tpl
    .replaceAll("{user}", userMention)
    .replaceAll("{username}", username)
    .replaceAll("{server}", server);
}

async function sendWelcomeForMember(client, member) {
  try {
    if (!welcomeCfg.enabled || !welcomeCfg.channel_id) return;

    const ch = await client.channels.fetch(welcomeCfg.channel_id).catch(() => null);
    if (!ch || !(ch.isTextBased && ch.isTextBased())) return;

    const msg = renderWelcomeMessage(member);
    await ch.send({ content: msg.slice(0, 1990) });

    welcomeCfg.last_sent_at = new Date().toISOString();
    welcomeCfg.last_error = null;
    saveWelcomeCfg();
  } catch (e) {
    welcomeCfg.last_error = String(e && e.message ? e.message : e);
    saveWelcomeCfg();
  }
}

function buildWelcomePanel({ extraRow } = {}) {
  const enabled = welcomeCfg.enabled;
  const ch = welcomeCfg.channel_id ? `<#${welcomeCfg.channel_id}>` : "*(not set)*";
  const last = welcomeCfg.last_sent_at ? fmtDateTimeJakarta(welcomeCfg.last_sent_at) : "-";

  const e = new EmbedBuilder()
    .setTitle("👋 Welcome Panel")
    .setDescription("Kirim welcome message saat member join.")
    .addFields(
      { name: "Enabled", value: enabled ? "✅ ON" : "❌ OFF", inline: true },
      { name: "Channel", value: ch, inline: true },
      { name: "Last Sent", value: `\`${last}\``, inline: true },
      { name: "Template", value: `\`${String(welcomeCfg.template || "").slice(0, 200)}\``, inline: false },
    )
    .setFooter({ text: "Token: {user} {username} {server}" });

  if (welcomeCfg.last_error) {
    e.addFields({ name: "Last Error", value: String(welcomeCfg.last_error).slice(0, 1024) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("welcome:toggle").setLabel(enabled ? "Disable" : "Enable").setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId("welcome:set_channel").setLabel("Set Channel").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("welcome:edit_template").setLabel("Edit Template").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("welcome:test").setLabel("Test").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("welcome:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
  );

  const components = extraRow ? [row, extraRow] : [row];
  return { content: null, embeds: [e], components };
}

function buildWelcomeChannelSelectRow() {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId("welcome:channel_select")
    .setPlaceholder("Pilih channel welcome")
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  return new ActionRowBuilder().addComponents(menu);
}

function buildWelcomeTemplateModal() {
  const m = new ModalBuilder()
    .setCustomId("welcome:template_modal")
    .setTitle("Welcome Template");

  const input = new TextInputBuilder()
    .setCustomId("template")
    .setLabel("Template (pakai {user} {username} {server})")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(400)
    .setValue(String(welcomeCfg.template || "").slice(0, 400));

  const row = new ActionRowBuilder().addComponents(input);
  m.addComponents(row);
  return m;
}

module.exports = {
  WELCOME_STATE_PATH,
  getWelcomeCfg,
  loadWelcomeCfg,
  saveWelcomeCfg,
  renderWelcomeMessage,
  sendWelcomeForMember,
  buildWelcomePanel,
  buildWelcomeChannelSelectRow,
  buildWelcomeTemplateModal,
};