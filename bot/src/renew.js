const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");

const { PAGE_SIZE, LIST_PROTOCOLS } = require("./config");
const { callBackend } = require("./ipc");
const { clampInt } = require("./util");
const { formatAccountsTable } = require("./tables");
const { buildProtocolFilterRow } = require("./accounts");

function _parseFinal(u) {
  const s = String(u || "");
  const i = s.lastIndexOf("@");
  if (i <= 0) return null;
  return { base: s.slice(0, i), proto: s.slice(i + 1), final: s };
}

async function buildRenewList(protoFilter, offset) {
  protoFilter = String(protoFilter || "all").toLowerCase().trim();
  if (!LIST_PROTOCOLS.includes(protoFilter)) protoFilter = "all";
  offset = clampInt(Number(offset || 0), 0, 10_000_000);

  const resp = await callBackend({
    action: "list",
    protocol: protoFilter,
    offset,
    limit: PAGE_SIZE,
  });

  if (!resp || resp.status !== "ok") {
    const embed = new EmbedBuilder()
      .setTitle("❌ Failed")
      .setDescription(resp && resp.error ? String(resp.error) : "unknown error");
    return { embeds: [embed], components: [], ephemeral: true };
  }

  const items = Array.isArray(resp.items) ? resp.items : [];
  const total = Number.isFinite(resp.total) ? resp.total : items.length;
  const hasMore = !!resp.has_more;

  const embed = new EmbedBuilder()
    .setTitle("♻️ Renew Accounts")
    .setDescription(
      "Pilih akun dari dropdown untuk extend masa aktif.\n\n" +
        (items.length ? formatAccountsTable(items) : "_Tidak ada akun ditemukan._")
    )
    .setFooter({ text: `Filter: ${protoFilter} | Showing ${items.length} of ${total} | Offset ${offset}` });

  const filterRow = buildProtocolFilterRow("renew", protoFilter);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`renew:prev:${protoFilter}:${offset}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(offset <= 0),
    new ButtonBuilder()
      .setCustomId(`renew:next:${protoFilter}:${offset}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(!hasMore)
  );

  const components = [filterRow, navRow];

  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`renew:sel:${protoFilter}:${offset}`)
      .setPlaceholder("Pilih akun untuk renew...")
      .addOptions(
        items.slice(0, PAGE_SIZE).map((it, idx) => {
          const u = String(it.username || "-");
          return {
            label: `${idx + 1}. ${u}`.slice(0, 100),
            value: u.slice(0, 100),
          };
        })
      );

    components.splice(1, 0, new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components, ephemeral: true };
}

async function buildRenewPanel(finalU, protoFilter, offset) {
  const p = _parseFinal(finalU);
  if (!p) {
    const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription("invalid username selection");
    return { embeds: [embed], components: [], ephemeral: true };
  }

  const q = await callBackend({ action: "quota_get", protocol: p.proto, username: p.base });
  const exp = q && q.status === "ok" ? (q.expired_at || "-") : "-";
  const quotaGb = q && q.status === "ok" ? (q.quota_gb || 0) : 0;

  const embed = new EmbedBuilder()
    .setTitle("♻️ Renew")
    .setDescription(
      `**Username**: \`${p.final}\`\n` +
      `**Protocol**: \`${p.proto}\`\n` +
      `**Expired**: \`${exp}\`\n` +
      `**Quota**: \`${quotaGb} GB\`\n\n` +
      "Pilih durasi extend:"
    )
    .setFooter({ text: `Filter=${protoFilter} | Offset=${offset}` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`renew:set:7:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("+7 hari").setStyle(ButtonStyle.Primary).setEmoji("➕"),
    new ButtonBuilder().setCustomId(`renew:set:30:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("+30 hari").setStyle(ButtonStyle.Primary).setEmoji("➕"),
    new ButtonBuilder().setCustomId(`renew:set:90:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("+90 hari").setStyle(ButtonStyle.Primary).setEmoji("➕")
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`renew:custom:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("Custom").setStyle(ButtonStyle.Secondary).setEmoji("✍️"),
    new ButtonBuilder().setCustomId(`renew:back:${protoFilter}:${offset}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setEmoji("↩️")
  );

  return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

async function handleSlash(interaction) {
  const msg = await buildRenewList("all", 0);
  return interaction.reply(msg);
}

async function handleSelect(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("renew:sel:")) return;

  const parts = cid.split(":");
  const protoFilter = parts[2] || "all";
  const offset = Number(parts[3] || "0") || 0;

  const finalU = interaction.values && interaction.values[0];
  const panel = await buildRenewPanel(finalU, protoFilter, offset);
  return interaction.update(panel);
}

async function handleModal(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("renew:modal:")) return;

  const parts = cid.split(":");
  const protoFilter = parts[2] || "all";
  const offset = Number(parts[3] || "0") || 0;
  const proto = parts[4] || "";
  const base = parts[5] || "";

  const daysStr = interaction.fields.getTextInputValue("days");
  const addDays = Number(daysStr);
  if (!Number.isFinite(addDays) || addDays < 1 || addDays > 3650) {
    const embed = new EmbedBuilder().setTitle("❌ Invalid").setDescription("days harus 1..3650");
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const resp = await callBackend({ action: "renew", protocol: proto, username: base, add_days: addDays });
  if (!resp || resp.status !== "ok") {
    const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp && resp.error ? String(resp.error) : "unknown error");
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const okEmbed = new EmbedBuilder()
    .setTitle("✅ Renew Success")
    .setDescription(`**User**: \`${resp.username}\`\n**Expired**: \`${resp.expired_at}\``);

  // attach detail txt (kalau ada)
  const files = [];
  try {
    if (resp.detail_path) files.push(new AttachmentBuilder(resp.detail_path));
  } catch (_) {}

  await interaction.reply({ embeds: [okEmbed], files, ephemeral: true });

  // refresh panel
  const panel = await buildRenewPanel(resp.username, protoFilter, offset);
  return interaction.message.edit(panel);
}

async function handleButton(interaction) {
  const cid = interaction.customId || "";

  // filter buttons
  if (cid.startsWith("filt:renew:")) {
    const protoFilter = cid.split(":")[2] || "all";
    const msg = await buildRenewList(protoFilter, 0);
    return interaction.update(msg);
  }

  if (!cid.startsWith("renew:")) return;

  const parts = cid.split(":");
  const kind = parts[1] || "";

  if (kind === "prev" || kind === "next") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const nextOffset = kind === "prev" ? Math.max(0, offset - PAGE_SIZE) : offset + PAGE_SIZE;
    const msg = await buildRenewList(protoFilter, nextOffset);
    return interaction.update(msg);
  }

  if (kind === "back") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const msg = await buildRenewList(protoFilter, offset);
    return interaction.update(msg);
  }

  if (kind === "custom") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const proto = parts[4] || "";
    const base = parts[5] || "";

    const modal = new ModalBuilder()
      .setCustomId(`renew:modal:${protoFilter}:${offset}:${proto}:${base}`)
      .setTitle("Renew (Custom days)");

    const days = new TextInputBuilder()
      .setCustomId("days")
      .setLabel("Tambah hari (1..3650)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(days));
    return interaction.showModal(modal);
  }

  if (kind === "set") {
    const addDays = Number(parts[2] || "0") || 0;
    const protoFilter = parts[3] || "all";
    const offset = Number(parts[4] || "0") || 0;
    const proto = parts[5] || "";
    const base = parts[6] || "";

    await interaction.deferReply({ ephemeral: true });

    const resp = await callBackend({ action: "renew", protocol: proto, username: base, add_days: addDays });
    if (!resp || resp.status !== "ok") {
      const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp && resp.error ? String(resp.error) : "unknown error");
      return interaction.editReply({ embeds: [embed] });
    }

    const okEmbed = new EmbedBuilder()
      .setTitle("✅ Renew Success")
      .setDescription(`**User**: \`${resp.username}\`\n**Expired**: \`${resp.expired_at}\``);

    const files = [];
    try {
      if (resp.detail_path) files.push(new AttachmentBuilder(resp.detail_path));
    } catch (_) {}

    await interaction.editReply({ embeds: [okEmbed], files });

    // refresh original panel silently
    try {
      const panel = await buildRenewPanel(resp.username, protoFilter, offset);
      await interaction.message.edit(panel);
    } catch (_) {}

    return;
  }
}

module.exports = { handleSlash, handleSelect, handleButton, handleModal, buildRenewList };