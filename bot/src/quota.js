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

async function buildQuotaList(protoFilter, offset) {
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
    .setTitle("📦 Quota Manager")
    .setDescription(
      "Pilih akun dari dropdown untuk set quota.\n\n" +
        (items.length ? formatAccountsTable(items) : "_Tidak ada akun ditemukan._")
    )
    .setFooter({ text: `Filter: ${protoFilter} | Showing ${items.length} of ${total} | Offset ${offset}` });

  const filterRow = buildProtocolFilterRow("quota", protoFilter);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`quota:prev:${protoFilter}:${offset}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(offset <= 0),
    new ButtonBuilder()
      .setCustomId(`quota:next:${protoFilter}:${offset}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(!hasMore)
  );

  const components = [filterRow, navRow];

  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`quota:sel:${protoFilter}:${offset}`)
      .setPlaceholder("Pilih akun untuk set quota...")
      .addOptions(
        items.slice(0, PAGE_SIZE).map((it, idx) => {
          const u = String(it.username || "-");
          return { label: `${idx + 1}. ${u}`.slice(0, 100), value: u.slice(0, 100) };
        })
      );

    components.splice(1, 0, new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components, ephemeral: true };
}

async function buildQuotaPanel(finalU, protoFilter, offset) {
  const p = _parseFinal(finalU);
  if (!p) {
    const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription("invalid username selection");
    return { embeds: [embed], components: [], ephemeral: true };
  }

  const q = await callBackend({ action: "quota_get", protocol: p.proto, username: p.base });
  const exp = q && q.status === "ok" ? (q.expired_at || "-") : "-";
  const quotaGb = q && q.status === "ok" ? (q.quota_gb || 0) : 0;

  const embed = new EmbedBuilder()
    .setTitle("📦 Quota")
    .setDescription(
      `**Username**: \`${p.final}\`\n` +
      `**Protocol**: \`${p.proto}\`\n` +
      `**Expired**: \`${exp}\`\n` +
      `**Quota**: \`${quotaGb} GB\`\n\n` +
      "Pilih quota preset atau custom:"
    )
    .setFooter({ text: `Filter=${protoFilter} | Offset=${offset}` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`quota:set:0:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("Unlimited").setStyle(ButtonStyle.Primary).setEmoji("♾️"),
    new ButtonBuilder().setCustomId(`quota:set:1:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("1 GB").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`quota:set:5:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("5 GB").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`quota:set:10:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("10 GB").setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`quota:custom:${protoFilter}:${offset}:${p.proto}:${p.base}`).setLabel("Custom").setStyle(ButtonStyle.Secondary).setEmoji("✍️"),
    new ButtonBuilder().setCustomId(`quota:back:${protoFilter}:${offset}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setEmoji("↩️")
  );

  return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

async function handleSlash(interaction) {
  const msg = await buildQuotaList("all", 0);
  return interaction.reply(msg);
}

async function handleSelect(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("quota:sel:")) return;

  const parts = cid.split(":");
  const protoFilter = parts[2] || "all";
  const offset = Number(parts[3] || "0") || 0;

  const finalU = interaction.values && interaction.values[0];
  const panel = await buildQuotaPanel(finalU, protoFilter, offset);
  return interaction.update(panel);
}

async function handleModal(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("quota:modal:")) return;

  const parts = cid.split(":");
  const protoFilter = parts[2] || "all";
  const offset = Number(parts[3] || "0") || 0;
  const proto = parts[4] || "";
  const base = parts[5] || "";

  const gbStr = interaction.fields.getTextInputValue("quota_gb");
  const quotaGb = Number(gbStr);

  if (!Number.isFinite(quotaGb) || quotaGb < 0 || quotaGb > 10_000) {
    const embed = new EmbedBuilder().setTitle("❌ Invalid").setDescription("quota_gb harus >= 0 dan masuk akal");
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const resp = await callBackend({ action: "quota_set", protocol: proto, username: base, quota_gb: quotaGb });
  if (!resp || resp.status !== "ok") {
    const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp && resp.error ? String(resp.error) : "unknown error");
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const okEmbed = new EmbedBuilder()
    .setTitle("✅ Quota Updated")
    .setDescription(`**User**: \`${resp.username}\`\n**Quota**: \`${resp.quota_gb} GB\``);

  const files = [];
  try {
    if (resp.detail_path) files.push(new AttachmentBuilder(resp.detail_path));
  } catch (_) {}

  await interaction.reply({ embeds: [okEmbed], files, ephemeral: true });

  const panel = await buildQuotaPanel(resp.username, protoFilter, offset);
  return interaction.message.edit(panel);
}

async function handleButton(interaction) {
  const cid = interaction.customId || "";

  if (cid.startsWith("filt:quota:")) {
    const protoFilter = cid.split(":")[2] || "all";
    const msg = await buildQuotaList(protoFilter, 0);
    return interaction.update(msg);
  }

  if (!cid.startsWith("quota:")) return;

  const parts = cid.split(":");
  const kind = parts[1] || "";

  if (kind === "prev" || kind === "next") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const nextOffset = kind === "prev" ? Math.max(0, offset - PAGE_SIZE) : offset + PAGE_SIZE;
    const msg = await buildQuotaList(protoFilter, nextOffset);
    return interaction.update(msg);
  }

  if (kind === "back") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const msg = await buildQuotaList(protoFilter, offset);
    return interaction.update(msg);
  }

  if (kind === "custom") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const proto = parts[4] || "";
    const base = parts[5] || "";

    const modal = new ModalBuilder()
      .setCustomId(`quota:modal:${protoFilter}:${offset}:${proto}:${base}`)
      .setTitle("Quota (Custom GB)");

    const quota = new TextInputBuilder()
      .setCustomId("quota_gb")
      .setLabel("Quota GB (0 = unlimited)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(quota));
    return interaction.showModal(modal);
  }

  if (kind === "set") {
    const quotaGb = Number(parts[2] || "0") || 0;
    const protoFilter = parts[3] || "all";
    const offset = Number(parts[4] || "0") || 0;
    const proto = parts[5] || "";
    const base = parts[6] || "";

    await interaction.deferReply({ ephemeral: true });

    const resp = await callBackend({ action: "quota_set", protocol: proto, username: base, quota_gb: quotaGb });
    if (!resp || resp.status !== "ok") {
      const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp && resp.error ? String(resp.error) : "unknown error");
      return interaction.editReply({ embeds: [embed] });
    }

    const okEmbed = new EmbedBuilder()
      .setTitle("✅ Quota Updated")
      .setDescription(`**User**: \`${resp.username}\`\n**Quota**: \`${resp.quota_gb} GB\``);

    const files = [];
    try {
      if (resp.detail_path) files.push(new AttachmentBuilder(resp.detail_path));
    } catch (_) {}

    await interaction.editReply({ embeds: [okEmbed], files });

    try {
      const panel = await buildQuotaPanel(resp.username, protoFilter, offset);
      await interaction.message.edit(panel);
    } catch (_) {}

    return;
  }
}

module.exports = { handleSlash, handleSelect, handleButton, handleModal, buildQuotaList };