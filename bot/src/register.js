const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const { TOKEN, GUILD_ID, CLIENT_ID } = require("./config");

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Cara pakai bot & penjelasan fungsi (UI interaktif)"),
    new SlashCommandBuilder().setName("ping").setDescription("Health check bot + backend latency (ms)"),
    new SlashCommandBuilder().setName("status").setDescription("Status service Xray dan Nginx (admin only)"),
    new SlashCommandBuilder().setName("notify").setDescription("Panel notifikasi berkala Ping+Status (admin only)"),
    new SlashCommandBuilder().setName("accounts").setDescription("List akun + ambil ulang XRAY ACCOUNT DETAIL (.txt) (admin only)"),
    new SlashCommandBuilder().setName("add").setDescription("Create Xray user (interactive: pilih protocol via button) (admin only)"),
    new SlashCommandBuilder()
      .setName("del")
      .setDescription("Delete Xray user (list & confirm) (admin only)")
      .addStringOption(o =>
        o.setName("protocol")
          .setDescription("Untuk delete langsung: isi protocol + username. Untuk list: optional sebagai initial filter.")
          .setRequired(false)
          .addChoices(
            { name: "all", value: "all" },
            { name: "vless", value: "vless" },
            { name: "vmess", value: "vmess" },
            { name: "trojan", value: "trojan" },
            { name: "allproto", value: "allproto" },
          )
      )
      .addStringOption(o =>
        o.setName("username")
          .setDescription("Jika diisi, bot akan minta confirm delete untuk user ini (tanpa suffix)")
          .setRequired(false)
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

module.exports = { registerCommands };
