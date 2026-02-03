const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType } = require("discord.js");
const { getNotifyCfg } = require("./notify");
const { getAuditCfg } = require("./audit");
const { getWelcomeCfg } = require("./welcome");

function buildChannelPanel({ extraRow } = {}) {
  const notify = getNotifyCfg();
  const audit = getAuditCfg();
  const welcome = getWelcomeCfg();

  const e = new EmbedBuilder()
    .setTitle("📌 Channel Settings")
    .setDescription("Atur channel untuk fitur bot (notify / audit / welcome).")
    .addFields(
      { name: "Notify Channel", value: notify.channel_id ? `<#${notify.channel_id}>` : "*(not set)*", inline: true },
      { name: "Audit Channel", value: audit.channel_id ? `<#${audit.channel_id}>` : "*(not set)*", inline: true },
      { name: "Welcome Channel", value: welcome.channel_id ? `<#${welcome.channel_id}>` : "*(not set)*", inline: true },
    )
    .setFooter({ text: "Klik tombol Set... lalu pilih channel." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("channel:set_notify").setLabel("Set Notify").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("channel:set_audit").setLabel("Set Audit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("channel:set_welcome").setLabel("Set Welcome").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("channel:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
  );

  const components = extraRow ? [row, extraRow] : [row];
  return { content: null, embeds: [e], components };
}

function buildChannelSelectRow(kind) {
  kind = String(kind || "").toLowerCase().trim();
  if (!["notify", "audit", "welcome"].includes(kind)) kind = "notify";

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`channel:select:${kind}`)
    .setPlaceholder(`Pilih channel untuk ${kind}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  return new ActionRowBuilder().addComponents(menu);
}

module.exports = {
  buildChannelPanel,
  buildChannelSelectRow,
};