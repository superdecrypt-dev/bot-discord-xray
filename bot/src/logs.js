const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { callBackend } = require("./ipc");

const SERVICES = [
  { label: "XRAY", value: "xray", emoji: "🧿" },
  { label: "NGINX", value: "nginx", emoji: "🌐" },
  { label: "BACKEND", value: "backend", emoji: "🐍" },
  { label: "BOT", value: "bot", emoji: "🤖" },
];

function _clipCode(s, max = 3800) {
  s = String(s || "");
  if (s.length <= max) return s;
  return s.slice(-max);
}

async function buildLogsPanel(service = "xray", page = 0) {
  const resp = await callBackend({
    action: "logs",
    unit: service,
    page,
    page_size: 25,
  });

  if (!resp || resp.status !== "ok") {
    const embed = new EmbedBuilder()
      .setTitle("❌ Failed")
      .setDescription(resp && resp.error ? String(resp.error) : "unknown error");
    return { embeds: [embed], components: [], ephemeral: true };
  }

  const text = _clipCode(resp.text || "(empty)");
  const embed = new EmbedBuilder()
    .setTitle(`📜 Logs: ${resp.unit}`)
    .setDescription("```text\n" + text + "\n```")
    .setFooter({ text: `Page: ${resp.page} | unit=${resp.unit}` });

  const svcRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`logs:svc:${resp.page}`)
      .setPlaceholder("Pilih service logs...")
      .addOptions(
        SERVICES.map((s) => ({
          label: s.label,
          value: s.value,
          emoji: s.emoji,
          default: s.value === service,
        }))
      )
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`logs:prev:${service}:${resp.page}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⬅️")
      .setDisabled(resp.page <= 0),
    new ButtonBuilder()
      .setCustomId(`logs:next:${service}:${resp.page}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➡️")
      .setDisabled(!resp.has_more),
    new ButtonBuilder()
      .setCustomId(`logs:refresh:${service}:${resp.page}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🔄")
  );

  return { embeds: [embed], components: [svcRow, navRow], ephemeral: true };
}

async function handleSlash(interaction) {
  const msg = await buildLogsPanel("xray", 0);
  return interaction.reply(msg);
}

async function handleSelect(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("logs:svc:")) return;

  const page = Number(String(cid.split(":")[2] || "0")) || 0;
  const service = (interaction.values && interaction.values[0]) || "xray";

  const msg = await buildLogsPanel(service, page);
  return interaction.update(msg);
}

async function handleButton(interaction) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("logs:")) return;

  const parts = cid.split(":");
  const kind = parts[1] || "";
  const service = parts[2] || "xray";
  const page = Number(parts[3] || "0") || 0;

  if (kind === "prev") {
    const msg = await buildLogsPanel(service, Math.max(0, page - 1));
    return interaction.update(msg);
  }
  if (kind === "next") {
    const msg = await buildLogsPanel(service, page + 1);
    return interaction.update(msg);
  }
  if (kind === "refresh") {
    const msg = await buildLogsPanel(service, page);
    return interaction.update(msg);
  }
}

module.exports = { handleSlash, handleSelect, handleButton };