const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { PAGE_SIZE, LIST_PROTOCOLS } = require("./config");
const { callBackend } = require("./ipc");
const { clampInt } = require("./util");
const { formatAccountsTable } = require("./tables");

function buildProtocolFilterRow(prefix, active) {
  active = String(active || "all").toLowerCase().trim();
  if (!LIST_PROTOCOLS.includes(active)) active = "all";

  const mk = (proto, label, emoji) => {
    const isActive = active === proto;
    return new ButtonBuilder()
      .setCustomId(`filt:${prefix}:${proto}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(isActive ? ButtonStyle.Primary : ButtonStyle.Secondary);
  };

  return new ActionRowBuilder().addComponents(
    mk("all", "ALL", "📌"),
    mk("vless", "VLESS", "🟦"),
    mk("vmess", "VMESS", "🟩"),
    mk("trojan", "TROJAN", "🟥"),
    mk("allproto", "ALLPROTO", "🟪"),
  );
}

async function buildListMessage(kind, protoFilter, offset) {
  const prefix = kind === "del" ? "del" : "acct";
  protoFilter = String(protoFilter || "all").toLowerCase().trim();
  if (!LIST_PROTOCOLS.includes(protoFilter)) protoFilter = "all";

  offset = clampInt(Number(offset || 0), 0, 10_000_000);

  const resp = await callBackend({
    action: "list",
    protocol: protoFilter,
    offset,
    limit: PAGE_SIZE
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

  const title = kind === "del" ? "🗑️ Delete Accounts" : "📚 XRAY Accounts";
  const headerLine =
    kind === "del"
      ? "Pilih akun dari dropdown, lalu konfirmasi delete."
      : "Pilih akun dari dropdown untuk ambil ulang XRAY ACCOUNT DETAIL (.txt).";

  const tableBlock = items.length ? formatAccountsTable(items) : "_Tidak ada akun ditemukan._";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`${headerLine}\n\n${tableBlock}`)
    .setFooter({ text: `Filter: ${protoFilter} | Showing ${items.length} of ${total} | Offset ${offset}` });

  const filterRow = buildProtocolFilterRow(prefix, protoFilter);

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev:${protoFilter}:${offset}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(offset <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next:${protoFilter}:${offset}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(!hasMore),
  );

  const components = [filterRow, nav];

  if (items.length > 0) {
    const placeholder = kind === "del"
      ? "Pilih akun yang ingin dihapus..."
      : "Pilih akun untuk ambil ulang XRAY ACCOUNT DETAIL (.txt)";

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}:sel:${protoFilter}:${offset}`)
      .setPlaceholder(placeholder)
      .addOptions(
        items.slice(0, PAGE_SIZE).map((it, idx) => {
          const u = String(it.username || "-");
          const p = String(it.protocol || "-");
          const e = String(it.expired_at || "-");
          return {
            label: `${idx + 1}. ${u}`.slice(0, 100),
            description: `${p} | exp ${e}`.slice(0, 100),
            value: u.slice(0, 100)
          };
        })
      );

    components.splice(1, 0, new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components, ephemeral: true };
}

module.exports = { buildProtocolFilterRow, buildListMessage };
