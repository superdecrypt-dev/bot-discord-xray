const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const { TOKEN, GUILD_ID, CLIENT_ID } = require("./config");

async function registerCommands() {
  const commands = [
    // Public
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Cara pakai bot & penjelasan fungsi (UI interaktif)"),

    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Health check bot + backend latency (ms)"),

    // Admin-only (core)
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Status service Xray dan Nginx (admin only)"),

    new SlashCommandBuilder()
      .setName("notify")
      .setDescription("Panel notifikasi berkala Ping+Status (admin only)"),

    new SlashCommandBuilder()
      .setName("accounts")
      .setDescription("List akun + ambil ulang XRAY ACCOUNT DETAIL (.txt) (admin only)"),

    new SlashCommandBuilder()
      .setName("add")
      .setDescription("Create Xray user (interactive: pilih protocol via button) (admin only)"),

    new SlashCommandBuilder()
      .setName("del")
      .setDescription("Delete Xray user (list & confirm) (admin only)")
      .addStringOption((o) =>
        o
          .setName("protocol")
          .setDescription("Optional filter untuk list, atau protocol untuk delete langsung")
          .setRequired(false)
          .addChoices(
            { name: "all", value: "all" },
            { name: "vless", value: "vless" },
            { name: "vmess", value: "vmess" },
            { name: "trojan", value: "trojan" },
            { name: "allproto", value: "allproto" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("username")
          .setDescription("Jika diisi, bot akan minta confirm delete untuk user ini (tanpa suffix)")
          .setRequired(false)
      ),

    // Admin-only (Discord server interaction)
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Panel bersih-bersih pesan (admin only)"),

    new SlashCommandBuilder()
      .setName("channel")
      .setDescription("Panel setting channel bot (notify/audit/welcome) (admin only)"),

    new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Panel welcome message (admin only)"),

    new SlashCommandBuilder()
      .setName("audit")
      .setDescription("Panel audit log bot (admin only)"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  console.log(`[OK] Registered ${commands.length} guild commands`);
}

if (require.main === module) {
  registerCommands().catch((e) => {
    console.error("[ERROR] registerCommands failed:", e);
    process.exit(1);
  });
}

module.exports = { registerCommands };