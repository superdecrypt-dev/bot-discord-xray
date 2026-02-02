const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const cfg = require("./config");
cfg.assertEnv();

const { callBackend, mapBackendError } = require("./ipc");
const { isAdmin, badge, parseFinalEmail } = require("./util");
const { buildHelpPanel } = require("./help");
const { buildListMessage } = require("./accounts");
const { buildAddProtocolButtons, buildAddModal } = require("./add_ui");
const {
  getNotifyCfg,
  loadNotifyCfg,
  saveNotifyCfg,
  startNotifyScheduler,
  stopNotifyScheduler,
  sendNotifyTick,
  buildNotifyPanel,
  buildNotifyChannelSelectRow,
  buildNotifyIntervalModal,
} = require("./notify");

const { QUICK_REPLY_MS, PAGE_SIZE, ADD_PROTOCOLS, LIST_PROTOCOLS, GUILD_ID, ADMIN_ROLE_ID } = cfg;

// Helpers from original
function lightValidate(protocol, username, days, quota_gb) {
  protocol = String(protocol || "").toLowerCase().trim();
  const okProto = ADD_PROTOCOLS.includes(protocol);
  if (!okProto) return { ok: false, msg: "protocol invalid" };
  if (!/^[A-Za-z0-9_]+$/.test(username || "")) return { ok: false, msg: "username invalid" };
  if (days !== undefined) {
    if (!Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, msg: "days out of range (1..3650)" };
  }
  if (quota_gb !== undefined) {
    if (typeof quota_gb !== "number" || !Number.isFinite(quota_gb) || quota_gb < 0) return { ok: false, msg: "quota_gb must be >= 0" };
  }
  return { ok: true, protocol };
}

function buildDetailTxtPath(proto, finalEmail) {
  const p = parseFinalEmail(finalEmail);
  if (!p) return null;
  if (p.proto !== proto) return null;
  const baseDir = proto === "allproto" ? "/opt/allproto" : `/opt/${proto}`;
  return path.join(baseDir, `${finalEmail}.txt`);
}

function buildPingText(wsMs, ipcMs) {
  return (
    "```" +
    "\n🏓 Pong" +
    `\nDiscord WS : ${wsMs} ms` +
    `\nBackend IPC: ${ipcMs} ms` +
    "\n```"
  );
}

function buildStatusText(xrayState, nginxState, ipcMs) {
  const xray = badge(xrayState);
  const nginx = badge(nginxState);
  return (
    "```" +
    "\n🧩 Service Status" +
    `\nXray : ${xray}` +
    `\nNginx: ${nginx}` +
    `\nIPC  : ${ipcMs} ms` +
    "\n```"
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadNotifyCfg();
  startNotifyScheduler(client);
});

client.on("interactionCreate", async (interaction) => {
  // MODALS
  if (interaction.isModalSubmit()) {
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }

      const cid = String(interaction.customId || "");

      if (cid === "notify:interval_modal") {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        const raw = String(interaction.fields.getTextInputValue("minutes") || "").trim();
        const minutes = parseInt(raw, 10);
        if (!Number.isInteger(minutes) || minutes < cfg.NOTIFY_MIN_INTERVAL_MIN || minutes > cfg.NOTIFY_MAX_INTERVAL_MIN) {
          return interaction.reply({
            content: `❌ Interval tidak valid. Masukkan angka ${cfg.NOTIFY_MIN_INTERVAL_MIN}..${cfg.NOTIFY_MAX_INTERVAL_MIN}.`,
            ephemeral: true
          });
        }

        const st = getNotifyCfg();
        st.interval_min = minutes;
        st.last_error = null;
        saveNotifyCfg();
        startNotifyScheduler(client);

        const panel = buildNotifyPanel();
        await interaction.reply({ ...panel, ephemeral: true });

        return interaction.followUp({
          content: `✅ Interval notifikasi berhasil disetel ke **${minutes} menit**.`,
          ephemeral: true
        });
      }

      if (!cid.startsWith("addmodal:")) {
        return interaction.reply({ content: "❌ Unknown modal", ephemeral: true });
      }

      if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
        return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
      }

      const protocol = cid.split(":")[1] || "";
      if (!ADD_PROTOCOLS.includes(protocol)) {
        return interaction.reply({ content: "❌ Invalid protocol", ephemeral: true });
      }

      const usernameRaw = String(interaction.fields.getTextInputValue("username") || "").trim();
      const daysRaw = String(interaction.fields.getTextInputValue("days") || "").trim();
      const quotaRaw = String(interaction.fields.getTextInputValue("quota_gb") || "").trim();

      const days = parseInt(daysRaw, 10);
      const quota_gb = Number(quotaRaw);

      const v = lightValidate(protocol, usernameRaw, days, quota_gb);
      if (!v.ok) {
        return interaction.reply({ content: `❌ ${v.msg}`, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const resp = await callBackend({ action: "add", protocol: v.protocol, username: usernameRaw, days, quota_gb });
      if (resp.status !== "ok") {
        return interaction.editReply(`❌ Failed: ${resp.error || "unknown error"}`);
      }

      const finalEmail = resp.username;
      const secret = resp.password || resp.uuid || "(hidden)";
      const detailPath = resp.detail_path;

      const embed = new EmbedBuilder()
        .setTitle("✅ Created")
        .setDescription("Akun berhasil dibuat. Detail terlampir sebagai file .txt.")
        .addFields(
          { name: "Protocol", value: v.protocol, inline: true },
          { name: "Username", value: finalEmail, inline: true },
          { name: "UUID/Pass", value: `\`${secret}\``, inline: false },
          { name: "Valid Until", value: resp.expired_at || "-", inline: true },
          { name: "Quota", value: `${quota_gb} GB`, inline: true },
        )
        .setFooter({ text: "Klik tombol untuk ambil ulang file .txt" });

      const files = [];
      if (detailPath && fs.existsSync(detailPath)) {
        files.push(new AttachmentBuilder(detailPath, { name: path.basename(detailPath) }));
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`detail:${v.protocol}:${finalEmail}`)
          .setLabel("Resend Detail TXT")
          .setStyle(ButtonStyle.Secondary)
      );

      return interaction.editReply({ content: null, embeds: [embed], components: [row], files });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  // Channel select menu (notify)
  if (interaction.isChannelSelectMenu && interaction.isChannelSelectMenu()) {
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }
      if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
        return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
      }

      const cid = String(interaction.customId || "");
      if (cid !== "notify:channel_select") {
        return interaction.reply({ content: "❌ Unknown menu", ephemeral: true });
      }

      const selected = interaction.values && interaction.values[0] ? String(interaction.values[0]) : null;
      if (!selected) {
        return interaction.reply({ content: "❌ Tidak ada channel dipilih.", ephemeral: true });
      }

      const st = getNotifyCfg();
      st.channel_id = selected;
      st.last_error = null;
      saveNotifyCfg();
      startNotifyScheduler(client);

      const panel = buildNotifyPanel();
      await interaction.update({ ...panel });

      return interaction.followUp({
        content: `✅ Notifikasi berhasil disetel ke <#${selected}>.`,
        ephemeral: true
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({ content: `❌ ${mapBackendError(e)}`, ephemeral: true });
    }
  }

  // String select menus
  if (interaction.isStringSelectMenu()) {
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }
      if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
        return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
      }

      const customId = String(interaction.customId || "");

      if (customId.startsWith("acct:sel:")) {
        const selected = (interaction.values && interaction.values[0]) ? String(interaction.values[0]) : "";
        const parsed = parseFinalEmail(selected);
        if (!parsed) return interaction.reply({ content: "❌ Invalid target", ephemeral: true });

        const txtPath = buildDetailTxtPath(parsed.proto, parsed.final);
        if (!txtPath) return interaction.reply({ content: "❌ Invalid target", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        if (!fs.existsSync(txtPath)) {
          return interaction.editReply(`❌ File not found: ${txtPath}`);
        }

        const file = new AttachmentBuilder(txtPath, { name: path.basename(txtPath) });
        const embed = new EmbedBuilder()
          .setTitle("📄 XRAY ACCOUNT DETAIL")
          .addFields(
            { name: "Protocol", value: parsed.proto, inline: true },
            { name: "Username", value: parsed.final, inline: true }
          )
          .setFooter({ text: "Attached: XRAY ACCOUNT DETAIL (.txt)" });

        return interaction.editReply({ content: null, embeds: [embed], files: [file] });
      }

      if (customId.startsWith("del:sel:")) {
        const selected = (interaction.values && interaction.values[0]) ? String(interaction.values[0]) : "";
        const parsed = parseFinalEmail(selected);
        if (!parsed) return interaction.reply({ content: "❌ Invalid target", ephemeral: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`delconfirm:${parsed.proto}:${parsed.base}`)
            .setLabel("Confirm Delete")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`delcancel:${parsed.proto}:${parsed.base}`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary),
        );

        const embed = new EmbedBuilder()
          .setTitle("⚠️ Confirm Delete")
          .setDescription("Klik **Confirm Delete** untuk menghapus akun ini.")
          .addFields(
            { name: "Protocol", value: parsed.proto, inline: true },
            { name: "Username", value: parsed.final, inline: true },
          )
          .setFooter({ text: "Ini akan menghapus user dari config + metadata files." });

        return interaction.update({ content: null, embeds: [embed], components: [row] });
      }

      return interaction.reply({ content: "❌ Unknown menu", ephemeral: true });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  // BUTTONS
  if (interaction.isButton()) {
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }

      const customId = String(interaction.customId || "");

      if (customId.startsWith("help:tab:")) {
        const tab = customId.split(":")[2] || "overview";
        const panel = buildHelpPanel(tab);
        return interaction.update({ ...panel });
      }

      // notify buttons
      if (customId.startsWith("notify:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        if (customId === "notify:refresh") {
          await interaction.deferUpdate();
          const panel = buildNotifyPanel();
          return interaction.editReply({ ...panel });
        }

        if (customId === "notify:set_channel") {
          const extraRow = buildNotifyChannelSelectRow();
          const panel = buildNotifyPanel({ extraRow });
          return interaction.update({ ...panel });
        }

        if (customId === "notify:set_interval") {
          const modal = buildNotifyIntervalModal();
          return interaction.showModal(modal);
        }

        if (customId === "notify:toggle") {
          await interaction.deferUpdate();
          const st = getNotifyCfg();

          if (!st.enabled) {
            if (!st.channel_id) {
              st.last_error = "Channel belum diatur. Klik Set Channel terlebih dahulu.";
              saveNotifyCfg();
              const panel = buildNotifyPanel();
              await interaction.editReply({ ...panel });
              return interaction.followUp({ content: "❌ Channel belum diatur. Klik **Set Channel** dulu.", ephemeral: true });
            }

            st.enabled = true;
            st.last_error = null;
            saveNotifyCfg();
            startNotifyScheduler(client);

            const panel = buildNotifyPanel();
            await interaction.editReply({ ...panel });
            return interaction.followUp({ content: "✅ Notify diaktifkan. Gunakan **Test Now** untuk kirim 1x sekarang.", ephemeral: true });
          }

          st.enabled = false;
          saveNotifyCfg();
          stopNotifyScheduler();

          const panel = buildNotifyPanel();
          await interaction.editReply({ ...panel });
          return interaction.followUp({ content: "✅ Notify dimatikan.", ephemeral: true });
        }

        if (customId === "notify:test") {
          await interaction.deferUpdate();
          const st = getNotifyCfg();

          if (!st.channel_id) {
            st.last_error = "Channel belum diatur. Klik Set Channel terlebih dahulu.";
            saveNotifyCfg();
            const panel = buildNotifyPanel();
            await interaction.editReply({ ...panel });
            return interaction.followUp({ content: "❌ Channel belum diatur. Klik **Set Channel** dulu.", ephemeral: true });
          }

          await sendNotifyTick(client, { force: true }).catch((e) => {
            st.last_error = mapBackendError(e);
            saveNotifyCfg();
          });

          const panel = buildNotifyPanel();
          await interaction.editReply({ ...panel });
          return interaction.followUp({ content: "✅ Test dikirim (cek channel target).", ephemeral: true });
        }

        return interaction.reply({ content: "❌ Unknown notify action", ephemeral: true });
      }

      if (customId.startsWith("addproto:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }
        const protocol = customId.split(":")[1] || "";
        if (!ADD_PROTOCOLS.includes(protocol)) {
          return interaction.reply({ content: "❌ Invalid protocol", ephemeral: true });
        }
        const modal = buildAddModal(protocol);
        return interaction.showModal(modal);
      }

      if (customId.startsWith("filt:") || customId.startsWith("acct:") || customId.startsWith("del:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        // protocol filter buttons
        if (customId.startsWith("filt:")) {
          const parts = customId.split(":");
          if (parts.length !== 3) return interaction.reply({ content: "❌ Invalid filter button", ephemeral: true });

          const prefix = String(parts[1] || "").trim();
          const proto = String(parts[2] || "all").toLowerCase().trim();

          if (!["acct", "del"].includes(prefix)) return interaction.reply({ content: "❌ Invalid filter target", ephemeral: true });
          if (!LIST_PROTOCOLS.includes(proto)) return interaction.reply({ content: "❌ Invalid filter protocol", ephemeral: true });

          await interaction.deferUpdate();
          const payload = await buildListMessage(prefix === "del" ? "del" : "acct", proto, 0);

          return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components, files: [] });
        }

        // paging (acct:prev/... del:next/...)
        const parts = customId.split(":");
        if (parts.length === 4 && (parts[0] === "acct" || parts[0] === "del")) {
          const prefix = parts[0];
          const kind = String(parts[1] || "").trim();
          const protoFilter = String(parts[2] || "all").toLowerCase().trim();
          const offset = Math.max(0, parseInt(parts[3], 10) || 0);

          if (!LIST_PROTOCOLS.includes(protoFilter)) {
            return interaction.reply({ content: "❌ Invalid filter state", ephemeral: true });
          }

          let nextOffset = offset;
          if (kind === "next") nextOffset = offset + PAGE_SIZE;
          else if (kind === "prev") nextOffset = Math.max(0, offset - PAGE_SIZE);
          else return interaction.reply({ content: "❌ Invalid navigation button", ephemeral: true });

          await interaction.deferUpdate();
          const payload = await buildListMessage(prefix === "del" ? "del" : "acct", protoFilter, nextOffset);

          return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components, files: [] });
        }
      }

      if (customId.startsWith("detail:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }
        const parts = customId.split(":");
        if (parts.length !== 3) return interaction.reply({ content: "❌ Invalid button", ephemeral: true });

        const proto = String(parts[1] || "").toLowerCase().trim();
        const finalEmail = String(parts[2] || "").trim();
        if (!ADD_PROTOCOLS.includes(proto)) {
          return interaction.reply({ content: "❌ Invalid protocol", ephemeral: true });
        }

        const p = buildDetailTxtPath(proto, finalEmail);
        if (!p) return interaction.reply({ content: "❌ Invalid target", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        if (!fs.existsSync(p)) return interaction.editReply(`❌ File not found: ${p}`);

        const file = new AttachmentBuilder(p, { name: path.basename(p) });
        const embed = new EmbedBuilder()
          .setTitle("📄 XRAY ACCOUNT DETAIL")
          .addFields(
            { name: "Protocol", value: proto, inline: true },
            { name: "Username", value: finalEmail, inline: true }
          )
          .setFooter({ text: "Resent detail file (.txt)" });

        return interaction.editReply({ content: null, embeds: [embed], files: [file] });
      }

      if (customId.startsWith("delconfirm:") || customId.startsWith("delcancel:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }
        const parts = customId.split(":");
        if (parts.length !== 3) return interaction.reply({ content: "❌ Invalid button", ephemeral: true });

        const action = parts[0];
        const proto = String(parts[1] || "").toLowerCase().trim();
        const username = String(parts[2] || "").trim();

        const v = lightValidate(proto, username);
        if (!v.ok) return interaction.reply({ content: `❌ ${v.msg}`, ephemeral: true });

        if (action === "delcancel") {
          return interaction.update({ content: "✅ Delete cancelled.", embeds: [], components: [] });
        }

        await interaction.deferUpdate();

        const resp = await callBackend({ action: "del", protocol: proto, username });
        if (resp.status !== "ok") {
          const embed = new EmbedBuilder().setTitle("❌ Failed").setDescription(resp.error || "unknown error");
          return interaction.editReply({ content: null, embeds: [embed], components: [] });
        }

        const embed = new EmbedBuilder()
          .setTitle("🗑️ Deleted")
          .setDescription("Akun berhasil dihapus.")
          .addFields(
            { name: "Protocol", value: proto, inline: true },
            { name: "Username", value: resp.username || `${username}@${proto}`, inline: true },
          )
          .setFooter({ text: "User removed from config and metadata cleaned." });

        return interaction.editReply({ content: null, embeds: [embed], components: [] });
      }

      return interaction.reply({ content: "❌ Unknown button", ephemeral: true });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  // SLASH COMMANDS
  if (!interaction.isChatInputCommand()) return;

  if (String(interaction.guildId) !== String(GUILD_ID)) {
    return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
  }

  const cmd = interaction.commandName;

  if (cmd === "help") {
    const panel = buildHelpPanel("overview");
    return interaction.reply({ ...panel, ephemeral: true });
  }

  if (cmd === "ping") {
    try {
      const wsMs = Math.round(client.ws.ping);
      const t0 = Date.now();
      const work = callBackend({ action: "ping" });

      const quick = await Promise.race([
        work.then((r) => ({ ok: true, r })),
        new Promise((res) => setTimeout(() => res(null), QUICK_REPLY_MS)),
      ]);

      if (quick) {
        if (!quick.ok || quick.r.status !== "ok") {
          const msg = quick.r && quick.r.error ? quick.r.error : "unknown error";
          return interaction.reply({ content: `❌ Backend ping failed: ${msg}`, ephemeral: true });
        }
        const ipcMs = Date.now() - t0;
        return interaction.reply({ content: buildPingText(wsMs, ipcMs), ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resp = await work;
      if (resp.status !== "ok") {
        return interaction.editReply(`❌ Backend ping failed: ${resp.error || "unknown error"}`);
      }
      const ipcMs = Date.now() - t0;
      return interaction.editReply({ content: buildPingText(wsMs, ipcMs) });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  // Admin-only
  if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
    return interaction.reply({ content: "❌ Unauthorized (admin role required).", ephemeral: true });
  }

  if (cmd === "status") {
    try {
      const t0 = Date.now();
      const work = callBackend({ action: "status" });

      const quick = await Promise.race([
        work.then((r) => ({ ok: true, r })),
        new Promise((res) => setTimeout(() => res(null), QUICK_REPLY_MS)),
      ]);

      if (quick) {
        if (!quick.ok || quick.r.status !== "ok") {
          const msg = quick.r && quick.r.error ? quick.r.error : "unknown error";
          return interaction.reply({ content: `❌ Failed: ${msg}`, ephemeral: true });
        }
        const ipcMs = Date.now() - t0;
        return interaction.reply({ content: buildStatusText(quick.r.xray, quick.r.nginx, ipcMs), ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const resp = await work;
      if (resp.status !== "ok") {
        return interaction.editReply(`❌ Failed: ${resp.error || "unknown error"}`);
      }
      const ipcMs = Date.now() - t0;
      return interaction.editReply({ content: buildStatusText(resp.xray, resp.nginx, ipcMs) });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  if (cmd === "notify") {
    const panel = buildNotifyPanel();
    return interaction.reply({ ...panel, ephemeral: true });
  }

  if (cmd === "accounts") {
    try {
      await interaction.deferReply({ ephemeral: true });
      const payload = await buildListMessage("acct", "all", 0);
      return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  if (cmd === "add") {
    const row = buildAddProtocolButtons();
    const msg =
      "🧩 **Create Account**\n" +
      "1) Pilih protocol via button\n" +
      "2) Isi form (username/days/quota)\n\n" +
      "Catatan: username tanpa suffix, hanya `[A-Za-z0-9_]`";
    return interaction.reply({ content: msg, components: [row], ephemeral: true });
  }

  if (cmd === "del") {
    const protocolOpt = interaction.options.getString("protocol");
    const usernameOpt = interaction.options.getString("username");

    if (protocolOpt && usernameOpt) {
      const protocol = String(protocolOpt).toLowerCase().trim();
      const username = String(usernameOpt).trim();

      const v = lightValidate(protocol, username);
      if (!v.ok) return interaction.reply({ content: `❌ ${v.msg}`, ephemeral: true });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`delconfirm:${v.protocol}:${username}`)
          .setLabel("Confirm Delete")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`delcancel:${v.protocol}:${username}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      );

      const embed = new EmbedBuilder()
        .setTitle("⚠️ Confirm Delete")
        .setDescription("Klik **Confirm Delete** untuk menghapus akun ini.")
        .addFields(
          { name: "Protocol", value: v.protocol, inline: true },
          { name: "Username", value: `${username}@${v.protocol}`, inline: true },
        )
        .setFooter({ text: "Ini akan menghapus user dari config + metadata files." });

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (!protocolOpt && usernameOpt) {
      return interaction.reply({
        content: "❌ Jika ingin delete langsung, isi juga option protocol. Atau jalankan /del tanpa username untuk mode list.",
        ephemeral: true
      });
    }

    try {
      const initialFilter = protocolOpt ? String(protocolOpt).toLowerCase().trim() : "all";
      const protoFilter = LIST_PROTOCOLS.includes(initialFilter) ? initialFilter : "all";

      await interaction.deferReply({ ephemeral: true });
      const payload = await buildListMessage("del", protoFilter, 0);

      return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components });
    } catch (e) {
      console.error(e);
      const msg = mapBackendError(e);
      if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
      return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
    }
  }

  return interaction.reply({ content: "❌ Unknown command", ephemeral: true });
});

(async () => {
  try {
    const { registerCommands } = require("./register");
    await registerCommands();
    await client.login(cfg.TOKEN);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
