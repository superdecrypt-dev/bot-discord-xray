const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const PURGE_COUNTS = [10, 25, 50, 100];
const DEFAULT_COUNT = 25;
const DEFAULT_MODE = "bot"; // "bot" | "all"

function _normMode(mode) {
  mode = String(mode || "").toLowerCase().trim();
  return mode === "all" ? "all" : "bot";
}

function _normCount(count) {
  const n = parseInt(String(count || DEFAULT_COUNT), 10);
  return PURGE_COUNTS.includes(n) ? n : DEFAULT_COUNT;
}

function buildPurgePanel({ channelId, count, mode, note } = {}) {
  count = _normCount(count);
  mode = _normMode(mode);

  const modeLabel = mode === "bot" ? "BOT_ONLY" : "ALL (excluding pinned)";
  const target = channelId ? `<#${channelId}>` : "(unknown)";

  const e = new EmbedBuilder()
    .setTitle("🧹 Purge Messages")
    .setDescription(
      [
        `Target channel: ${target}`,
        `Mode: **${modeLabel}**`,
        `Jumlah: **${count}**`,
        "",
        "⚠️ Catatan:",
        "- Bot akan mengabaikan pesan **pinned**.",
        "- Discord tidak bisa bulk delete pesan **lebih dari 14 hari** (akan di-skip otomatis).",
      ].join("\n")
    );

  if (note) e.addFields({ name: "Info", value: String(note).slice(0, 1024) });

  // Row counts
  const row1 = new ActionRowBuilder().addComponents(
    ...PURGE_COUNTS.map((n) =>
      new ButtonBuilder()
        .setCustomId(`purge:count:${n}:${mode}`)
        .setLabel(String(n))
        .setStyle(n === count ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  // Row actions
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`purge:mode:${count}:${mode}`)
      .setLabel(mode === "bot" ? "Mode: BOT_ONLY" : "Mode: ALL")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`purge:confirm:${count}:${mode}`)
      .setLabel("✅ Confirm")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("purge:cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`purge:refresh:${count}:${mode}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
  );

  return { content: null, embeds: [e], components: [row1, row2] };
}

function parsePurgeId(customId) {
  const parts = String(customId || "").split(":");
  // purge:<action>:<count>:<mode>
  if (parts.length < 2 || parts[0] !== "purge") return null;
  const action = parts[1];
  const count = _normCount(parts[2]);
  const mode = _normMode(parts[3]);
  return { action, count, mode };
}

module.exports = {
  DEFAULT_COUNT,
  DEFAULT_MODE,
  buildPurgePanel,
  parsePurgeId,
};