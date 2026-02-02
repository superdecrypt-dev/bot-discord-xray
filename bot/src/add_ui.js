const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

function buildAddProtocolButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("addproto:vless").setLabel("VLESS").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("addproto:vmess").setLabel("VMESS").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("addproto:trojan").setLabel("TROJAN").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("addproto:allproto").setLabel("ALLPROTO").setStyle(ButtonStyle.Success),
  );
}

function buildAddModal(protocol) {
  const modal = new ModalBuilder()
    .setCustomId(`addmodal:${protocol}`)
    .setTitle(`Create Account (${protocol})`);

  const usernameInput = new TextInputBuilder()
    .setCustomId("username")
    .setLabel("Username (tanpa suffix) [A-Za-z0-9_]")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(32);

  const daysInput = new TextInputBuilder()
    .setCustomId("days")
    .setLabel("Masa aktif (hari) 1..3650")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("30");

  const quotaInput = new TextInputBuilder()
    .setCustomId("quota_gb")
    .setLabel("Quota (GB) 0=unlimited")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("0");

  modal.addComponents(
    new ActionRowBuilder().addComponents(usernameInput),
    new ActionRowBuilder().addComponents(daysInput),
    new ActionRowBuilder().addComponents(quotaInput),
  );

  return modal;
}

module.exports = { buildAddProtocolButtons, buildAddModal };
