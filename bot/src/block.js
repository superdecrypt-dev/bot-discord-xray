const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
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

async function buildBlockList(protoFilter, offset) {
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
    .setTitle("⛔ Block / Unblock Accounts")
    .setDescription(
      "Pilih akun dari dropdown untuk block/unblock.\n\n" +
        (items.length ? formatAccountsTable(items) : "_Tidak ada akun ditemukan._")
    )
    .setFooter({ text: `Filter: ${protoFilter} | Showing ${items.length} of ${total} | Offset ${offset}` });

  const filterRow = buildProtocolFilterRow("block", protoFilter);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`block:prev:${protoFilter}:${offset}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(offset <= 0),
    new ButtonBuilder()
      .setCustomId(`block:next:${protoFilter}:${offset}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(!hasMore)
  );

  const components = [filterRow, navRow];

  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`block:sel:${protoFilter}:${offset}`)
      .setPlaceholder("Pilih akun untuk block/unblock...")
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

async function buildBlockPanel(finalU, protoFilter, offset) {
  const p = _parseFinal(finalU);
  if (!p) {
    const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription("invalid username selection");
    return { embeds: [embed], components: [], ephemeral: true };
  }

  const st = await callBackend({ action: "block_get", protocol: p.proto, username: p.base });
  const blocked = !!(st && st.status === "ok" && st.blocked);

  const embed = new EmbedBuilder()
    .setTitle("⛔ Block / Unblock")
    .setDescription(
      `**Username**: \`${p.final}\`\n` +
      `**Protocol**: \`${p.proto}\`\n` +
      `**State**: ${blocked ? "⛔ BLOCKED" : "✅ ACTIVE"}\n\n` +
      "Pilih aksi:"
    )
    .setFooter({ text: `Filter=${protoFilter} | Offset=${offset}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`block:confirm:${blocked ? "unblock" : "block"}:${protoFilter}:${offset}:${p.proto}:${p.base}`)
      .setLabel(blocked ? "Unblock" : "Block")
      .setStyle(blocked ? ButtonStyle.Success : ButtonStyle.Danger)
      .setEmoji(blocked ? "✅" : "⛔"),
    new ButtonBuilder()
      .setCustomId(`block:back:${protoFilter}:${offset}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("↩️"),
    new ButtonBuilder()
      .setCustomId(`block:refresh:${protoFilter}:${offset}:${p.proto}:${p.base}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔄")
  );

  return { embeds: [embed], components: [row], ephemeral: true };
}

async function buildConfirmPanel(op, protoFilter, offset, proto, base) {
  const finalU = `${base}@${proto}`;
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Confirm")
    .setDescription(`Yakin mau **${op.toUpperCase()}** user:\n\`${finalU}\` ?`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`block:do:${op}:${protoFilter}:${offset}:${proto}:${base}`)
      .setLabel("YES")
      .setStyle(op === "block" ? ButtonStyle.Danger : ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`block:cancel:${protoFilter}:${offset}:${proto}:${base}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("❎")
  );

  return { embeds: [embed], components: [row], ephemeral: true };
}

async function handleSlash(interaction) {
  const msg = await buildBlockList("all", 0);
  return interaction.reply(msg);
}

async function handleSelect(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("block:sel:")) return;

  const parts = cid.split(":");
  const protoFilter = parts[2] || "all";
  const offset = Number(parts[3] || "0") || 0;

  const finalU = interaction.values && interaction.values[0];
  const panel = await buildBlockPanel(finalU, protoFilter, offset);
  return interaction.update(panel);
}

async function handleButton(interaction) {
  const cid = interaction.customId || "";

  if (cid.startsWith("filt:block:")) {
    const protoFilter = cid.split(":")[2] || "all";
    const msg = await buildBlockList(protoFilter, 0);
    return interaction.update(msg);
  }

  if (!cid.startsWith("block:")) return;

  const parts = cid.split(":");
  const kind = parts[1] || "";

  if (kind === "prev" || kind === "next") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const nextOffset = kind === "prev" ? Math.max(0, offset - PAGE_SIZE) : offset + PAGE_SIZE;
    const msg = await buildBlockList(protoFilter, nextOffset);
    return interaction.update(msg);
  }

  if (kind === "back") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const msg = await buildBlockList(protoFilter, offset);
    return interaction.update(msg);
  }

  if (kind === "refresh") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const proto = parts[4] || "";
    const base = parts[5] || "";
    const panel = await buildBlockPanel(`${base}@${proto}`, protoFilter, offset);
    return interaction.update(panel);
  }

  if (kind === "confirm") {
    const op = parts[2] || "block";
    const protoFilter = parts[3] || "all";
    const offset = Number(parts[4] || "0") || 0;
    const proto = parts[5] || "";
    const base = parts[6] || "";

    const c = await buildConfirmPanel(op, protoFilter, offset, proto, base);
    return interaction.update(c);
  }

  if (kind === "cancel") {
    const protoFilter = parts[2] || "all";
    const offset = Number(parts[3] || "0") || 0;
    const proto = parts[4] || "";
    const base = parts[5] || "";
    const panel = await buildBlockPanel(`${base}@${proto}`, protoFilter, offset);
    return interaction.update(panel);
  }

  if (kind === "do") {
    const op = parts[2] || "block";
    const protoFilter = parts[3] || "all";
    const offset = Number(parts[4] || "0") || 0;
    const proto = parts[5] || "";
    const base = parts[6] || "";

    await interaction.deferReply({ ephemeral: true });

    const resp = await callBackend({ action: "block", op, protocol: proto, username: base });
    if (!resp || resp.status !== "ok") {
      const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp && resp.error ? String(resp.error) : "unknown error");
      return interaction.editReply({ embeds: [embed] });
    }

    const okEmbed = new EmbedBuilder()
      .setTitle("✅ Success")
      .setDescription(`**User**: \`${resp.username}\`\n**State**: ${op === "block" ? "⛔ BLOCKED" : "✅ ACTIVE"}`);

    await interaction.editReply({ embeds: [okEmbed] });

    try {
      const panel = await buildBlockPanel(`${base}@${proto}`, protoFilter, offset);
      await interaction.message.edit(panel);
    } catch (_) {}

    return;
  }
}

module.exports = { handleSlash, handleSelect, handleButton, buildBlockList };