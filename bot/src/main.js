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

const { buildPurgePanel, parsePurgeId, DEFAULT_COUNT: PURGE_DEFAULT_COUNT, DEFAULT_MODE: PURGE_DEFAULT_MODE } = require("./purge");
const { buildChannelPanel, buildChannelSelectRow } = require("./channel");
const { getAuditCfg, loadAuditCfg, saveAuditCfg, auditLog, buildAuditPanel, buildAuditChannelSelectRow } = require("./audit");
const { getWelcomeCfg, loadWelcomeCfg, saveWelcomeCfg, sendWelcomeForMember, buildWelcomePanel, buildWelcomeChannelSelectRow, buildWelcomeTemplateModal } = require("./welcome");

const { QUICK_REPLY_MS, PAGE_SIZE, ADD_PROTOCOLS, LIST_PROTOCOLS, GUILD_ID, ADMIN_ROLE_ID } = cfg;

// Helpers from original
function lightValidate(protocol, username, days, quota_gb) {
  protocol = String(protocol || "").toLowerCase().trim();
  username = String(username || "").trim();
  days = Number(days);
  quota_gb = Number(quota_gb);

  if (!ADD_PROTOCOLS.includes(protocol)) throw new Error("Invalid protocol");
  if (!/^[A-Za-z0-9_]+$/.test(username)) throw new Error("Invalid username");
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error("Invalid days");
  if (!Number.isFinite(quota_gb) || quota_gb < 0 || quota_gb > 100000) throw new Error("Invalid quota_gb");
  return { protocol, username, days, quota_gb };
}

function buildPingText(wsMs, ipcMs) {
  return (
    "🏓 PONG\n" +
    "```\n" +
    `Bot WS ping : ${wsMs} ms\n` +
    `Backend IPC : ${ipcMs} ms\n` +
    "```"
  );
}

function buildStatusText(xray, nginx, ipcMs) {
  const xs = xray ? `${badge(xray.active ? "active" : "inactive")} (${xray.state || "-"})` : "unknown";
  const ns = nginx ? `${badge(nginx.active ? "active" : "inactive")} (${nginx.state || "-"})` : "unknown";
  const xerr = xray && xray.error ? `\nXray error : ${String(xray.error).slice(0, 140)}` : "";
  const nerr = nginx && nginx.error ? `\nNginx error: ${String(nginx.error).slice(0, 140)}` : "";

  return (
    "🧩 STATUS\n" +
    "```\n" +
    `Xray  : ${xs}${xerr}\n` +
    `Nginx : ${ns}${nerr}\n` +
    `IPC   : ${ipcMs} ms\n` +
    "```"
  );
}

function readDomainFromNginxConf() {
  // best-effort, optional
  const p = "/etc/nginx/conf.d/xray.conf";
  try {
    const raw = fs.readFileSync(p, "utf8");
    const m = raw.match(/server_name\s+([^;]+);/);
    if (!m) return null;
    const dom = m[1].trim().split(/\s+/)[0];
    return dom || null;
  } catch (_) {
    return null;
  }
}

async function getPublicIp() {
  // best-effort, optional
  try {
    const { execFile } = require("child_process");
    return await new Promise((resolve) => {
      execFile("curl", ["-s", "ifconfig.me"], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null);
        const ip = String(stdout || "").trim();
        resolve(ip || null);
      });
    });
  } catch (_) {
    return null;
  }
}

// --- Discord Client ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadNotifyCfg();
  loadAuditCfg();
  loadWelcomeCfg();
  startNotifyScheduler(client);
});

client.on("guildMemberAdd", async (member) => {
  try {
    if (String(member.guild.id) !== String(GUILD_ID)) return;
    await sendWelcomeForMember(client, member);
  } catch (e) {
    // ignore
  }
});

client.on("interactionCreate", async (interaction) => {
  // MODALS
  if (interaction.isModalSubmit()) {
    const cid = String(interaction.customId || "");
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }

      if (cid === "notify:interval_modal") {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        const v = String(interaction.fields.getTextInputValue("minutes") || "").trim();
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1 || n > 52560000) {
          return interaction.reply({ content: "❌ Interval invalid. Range: 1..52560000 menit.", ephemeral: true });
        }

        const st = getNotifyCfg();
        st.interval_min = n;
        st.last_error = null;
        saveNotifyCfg();
        startNotifyScheduler(client);

        const panel = buildNotifyPanel();
        await interaction.reply({ ...panel, ephemeral: true });

        return interaction.followUp({
          content: `✅ Interval notifikasi diset ke **${n} menit**.`,
          ephemeral: true
        });
      }

      if (cid === "welcome:template_modal") {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        const raw = String(interaction.fields.getTextInputValue("template") || "").trim();
        if (!raw || raw.length < 3) {
          return interaction.reply({ content: "❌ Template terlalu pendek.", ephemeral: true });
        }

        const st = getWelcomeCfg();
        st.template = raw.slice(0, 400);
        st.last_error = null;
        saveWelcomeCfg();

        const panel = buildWelcomePanel();
        await interaction.reply({ ...panel, ephemeral: true });

        return interaction.followUp({ content: "✅ Template welcome berhasil disimpan.", ephemeral: true });
      }

      if (!cid.startsWith("addmodal:")) return;

      if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
        return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
      }

      const protocol = cid.split(":")[1] || "";
      const username = String(interaction.fields.getTextInputValue("username") || "").trim();
      const days = String(interaction.fields.getTextInputValue("days") || "").trim();
      const quota = String(interaction.fields.getTextInputValue("quota") || "").trim();

      const v = lightValidate(protocol, username, Number(days), Number(quota));
      await interaction.deferReply({ ephemeral: true });

      const resp = await callBackend({
        action: "add",
        protocol: v.protocol,
        username: v.username,
        days: v.days,
        quota_gb: v.quota_gb,
      });

      if (resp.status !== "ok") {
        return interaction.editReply(`❌ Failed: ${resp.error || "unknown error"}`);
      }

      // Attachment: XRAY ACCOUNT DETAIL .txt (from backend)
      const txtPath = resp && resp.detail_txt ? String(resp.detail_txt) : null;
      if (!txtPath || !fs.existsSync(txtPath)) {
        return interaction.editReply(`✅ Created: ${resp.username} (UUID/Pass: ${resp.uuid || "-"})\n⚠️ Detail file not found: ${txtPath || "-"}`);
      }

      const file = new AttachmentBuilder(txtPath, { name: path.basename(txtPath) });

      const embed = new EmbedBuilder()
        .setTitle("✅ Account Created")
        .addFields(
          { name: "Username", value: String(resp.username || "-"), inline: true },
          { name: "Protocol", value: String(resp.protocol || "-"), inline: true },
          { name: "Expired", value: String(resp.expired_at || "-"), inline: true },
        )
        .setFooter({ text: "Attached: XRAY ACCOUNT DETAIL (.txt)" });

      return interaction.editReply({ content: null, embeds: [embed], files: [file] });
    } catch (e) {
      console.error(e);
      return interaction.reply({ content: `❌ ${mapBackendError(e)}`, ephemeral: true });
    }
  }

  // Channel select menus
  if (interaction.isChannelSelectMenu && interaction.isChannelSelectMenu()) {
    try {
      if (String(interaction.guildId) !== String(GUILD_ID)) {
        return interaction.reply({ content: "❌ Wrong guild", ephemeral: true });
      }
      if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
        return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
      }

      const cid = String(interaction.customId || "");
      const selected = interaction.values && interaction.values[0] ? String(interaction.values[0]) : null;
      if (!selected) {
        return interaction.reply({ content: "❌ Tidak ada channel dipilih.", ephemeral: true });
      }

      // /notify panel
      if (cid === "notify:channel_select") {
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
      }

      // /audit panel
      if (cid === "audit:channel_select") {
        const st = getAuditCfg();
        st.channel_id = selected;
        st.last_error = null;
        saveAuditCfg();

        const panel = buildAuditPanel();
        await interaction.update({ ...panel });

        return interaction.followUp({
          content: `✅ Audit channel berhasil disetel ke <#${selected}>.`,
          ephemeral: true
        });
      }

      // /welcome panel
      if (cid === "welcome:channel_select") {
        const st = getWelcomeCfg();
        st.channel_id = selected;
        st.last_error = null;
        saveWelcomeCfg();

        const panel = buildWelcomePanel();
        await interaction.update({ ...panel });

        return interaction.followUp({
          content: `✅ Welcome channel berhasil disetel ke <#${selected}>.`,
          ephemeral: true
        });
      }

      // /channel panel selections
      if (cid.startsWith("channel:select:")) {
        const kind = cid.split(":")[2] || "notify";

        if (kind === "notify") {
          const st = getNotifyCfg();
          st.channel_id = selected;
          st.last_error = null;
          saveNotifyCfg();
          startNotifyScheduler(client);
        } else if (kind === "audit") {
          const st = getAuditCfg();
          st.channel_id = selected;
          st.last_error = null;
          saveAuditCfg();
        } else if (kind === "welcome") {
          const st = getWelcomeCfg();
          st.channel_id = selected;
          st.last_error = null;
          saveWelcomeCfg();
        }

        const panel = buildChannelPanel();
        await interaction.update({ ...panel });

        return interaction.followUp({
          content: `✅ Channel **${kind}** berhasil disetel ke <#${selected}>.`,
          ephemeral: true
        });
      }

      return interaction.reply({ content: "❌ Unknown menu", ephemeral: true });
    } catch (e) {
      console.error(e);
      return interaction.reply({ content: `❌ ${mapBackendError(e)}`, ephemeral: true });
    }
  }

  // STRING SELECT MENUS (accounts + delete list)
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
        if (!parsed) return interaction.reply({ content: "❌ Invalid selection", ephemeral: true });

        // Ask backend to get detail file path again
        await interaction.deferUpdate();
        const resp = await callBackend({ action: "get_detail", protocol: parsed.proto, username: parsed.base });

        if (resp.status !== "ok") {
          return interaction.followUp({ content: `❌ Failed: ${resp.error || "unknown error"}`, ephemeral: true });
        }

        const txtPath = resp && resp.detail_txt ? String(resp.detail_txt) : null;
        if (!txtPath || !fs.existsSync(txtPath)) {
          return interaction.followUp({ content: `❌ File not found: ${txtPath}`, ephemeral: true });
        }

        const file = new AttachmentBuilder(txtPath, { name: path.basename(txtPath) });
        const embed = new EmbedBuilder()
          .setTitle("📄 XRAY ACCOUNT DETAIL")
          .addFields(
            { name: "Protocol", value: parsed.proto, inline: true },
            { name: "Username", value: parsed.final, inline: true }
          )
          .setFooter({ text: "Attached: XRAY ACCOUNT DETAIL (.txt)" });

        return interaction.followUp({ content: null, embeds: [embed], files: [file], ephemeral: true });
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

      // purge buttons
      if (customId.startsWith("purge:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        const p = parsePurgeId(customId);
        if (!p) return interaction.reply({ content: "❌ Invalid purge action", ephemeral: true });

        // Always target the channel where the command was used
        const channelId = interaction.channelId;

        if (p.action === "cancel") {
          return interaction.update({ content: "✅ Purge dibatalkan.", embeds: [], components: [] });
        }

        if (p.action === "count" || p.action === "mode" || p.action === "refresh") {
          const mode = (p.action === "mode") ? (p.mode === "bot" ? "all" : "bot") : p.mode;
          const panel = buildPurgePanel({ channelId, count: p.count, mode });
          return interaction.update({ ...panel });
        }

        if (p.action === "confirm") {
          await interaction.deferUpdate();

          const ch = interaction.channel;
          if (!ch || !(ch.isTextBased && ch.isTextBased()) || typeof ch.bulkDelete !== "function") {
            const panel = buildPurgePanel({ channelId, count: p.count, mode: p.mode, note: "Channel tidak mendukung purge." });
            return interaction.editReply({ ...panel });
          }

          // fetch a window; for BOT_ONLY we may need more to find enough bot messages
          const fetchLimit = 100;
          const fetched = await ch.messages.fetch({ limit: fetchLimit }).catch(() => null);
          if (!fetched) {
            const panel = buildPurgePanel({ channelId, count: p.count, mode: p.mode, note: "Gagal fetch messages. Pastikan bot punya izin View Channel + Read Message History." });
            return interaction.editReply({ ...panel });
          }

          let targets;
          if (p.mode === "bot") {
            const onlyBot = fetched.filter(m => m && m.author && m.author.id === client.user.id && !m.pinned);
            targets = onlyBot.first(p.count);
          } else {
            const noPinned = fetched.filter(m => m && !m.pinned);
            targets = noPinned.first(p.count);
          }

          if (!targets || (Array.isArray(targets) && targets.length === 0)) {
            const panel = buildPurgePanel({ channelId, count: p.count, mode: p.mode, note: "Tidak ada pesan yang cocok untuk dihapus." });
            return interaction.editReply({ ...panel });
          }

          const del = await ch.bulkDelete(targets, true).catch((e) => e);
          if (del instanceof Error) {
            const panel = buildPurgePanel({ channelId, count: p.count, mode: p.mode, note: `Gagal purge: ${del.message || del}` });
            return interaction.editReply({ ...panel });
          }

          const n = del && del.size ? del.size : 0;
          const note = `Berhasil menghapus **${n}** pesan. (pesan >14 hari otomatis di-skip)`;

          // audit (best-effort)
          await auditLog(client, { actor: interaction.user, action: "discord:purge", detail: `channel=${channelId} mode=${p.mode} count=${p.count} deleted=${n}`, guildId: interaction.guildId });

          const panel = buildPurgePanel({ channelId, count: p.count, mode: p.mode, note });
          return interaction.editReply({ ...panel });
        }

        return interaction.reply({ content: "❌ Unknown purge action", ephemeral: true });
      }

      // channel settings panel buttons
      if (customId.startsWith("channel:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        if (customId === "channel:refresh") {
          const panel = buildChannelPanel();
          return interaction.update({ ...panel });
        }

        if (customId === "channel:set_notify") {
          const extraRow = buildChannelSelectRow("notify");
          const panel = buildChannelPanel({ extraRow });
          return interaction.update({ ...panel });
        }

        if (customId === "channel:set_audit") {
          const extraRow = buildChannelSelectRow("audit");
          const panel = buildChannelPanel({ extraRow });
          return interaction.update({ ...panel });
        }

        if (customId === "channel:set_welcome") {
          const extraRow = buildChannelSelectRow("welcome");
          const panel = buildChannelPanel({ extraRow });
          return interaction.update({ ...panel });
        }

        return interaction.reply({ content: "❌ Unknown channel action", ephemeral: true });
      }

      // welcome panel buttons
      if (customId.startsWith("welcome:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        if (customId === "welcome:refresh") {
          const panel = buildWelcomePanel();
          return interaction.update({ ...panel });
        }

        if (customId === "welcome:set_channel") {
          const extraRow = buildWelcomeChannelSelectRow();
          const panel = buildWelcomePanel({ extraRow });
          return interaction.update({ ...panel });
        }

        if (customId === "welcome:edit_template") {
          const modal = buildWelcomeTemplateModal();
          return interaction.showModal(modal);
        }

        if (customId === "welcome:toggle") {
          await interaction.deferUpdate();
          const st = getWelcomeCfg();
          st.enabled = !st.enabled;
          st.last_error = null;
          saveWelcomeCfg();

          await auditLog(client, { actor: interaction.user, action: "discord:welcome_toggle", detail: `enabled=${st.enabled}`, guildId: interaction.guildId });

          const panel = buildWelcomePanel();
          return interaction.editReply({ ...panel });
        }

        if (customId === "welcome:test") {
          await interaction.deferUpdate();

          const st = getWelcomeCfg();
          if (!st.channel_id) {
            return interaction.followUp({ content: "❌ Channel welcome belum diatur. Klik **Set Channel** dulu.", ephemeral: true });
          }

          await sendWelcomeForMember(client, interaction.member);
          await auditLog(client, { actor: interaction.user, action: "discord:welcome_test", detail: `channel=${st.channel_id}`, guildId: interaction.guildId });

          const panel = buildWelcomePanel();
          return interaction.editReply({ ...panel });
        }

        return interaction.reply({ content: "❌ Unknown welcome action", ephemeral: true });
      }

      // audit panel buttons
      if (customId.startsWith("audit:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }

        if (customId === "audit:refresh") {
          const panel = buildAuditPanel();
          return interaction.update({ ...panel });
        }

        if (customId === "audit:set_channel") {
          const extraRow = buildAuditChannelSelectRow();
          const panel = buildAuditPanel({ extraRow });
          return interaction.update({ ...panel });
        }

        if (customId === "audit:toggle") {
          await interaction.deferUpdate();
          const st = getAuditCfg();
          st.enabled = !st.enabled;
          st.last_error = null;
          saveAuditCfg();

          await auditLog(client, { actor: interaction.user, action: "discord:audit_toggle", detail: `enabled=${st.enabled}`, guildId: interaction.guildId });

          const panel = buildAuditPanel();
          return interaction.editReply({ ...panel });
        }

        if (customId === "audit:test") {
          await interaction.deferUpdate();
          await auditLog(client, { actor: interaction.user, action: "discord:audit_test", detail: "test message", guildId: interaction.guildId });
          const panel = buildAuditPanel();
          return interaction.editReply({ ...panel });
        }

        return interaction.reply({ content: "❌ Unknown audit action", ephemeral: true });
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
          return interaction.followUp({ content: "🛑 Notify dimatikan.", ephemeral: true });
        }

        if (customId === "notify:test") {
          await interaction.deferUpdate();
          await sendNotifyTick(client).catch(() => {});
          const panel = buildNotifyPanel();
          await interaction.editReply({ ...panel });
          return interaction.followUp({ content: "✅ Test sent (atau dicek di panel jika error).", ephemeral: true });
        }

        return interaction.reply({ content: "❌ Unknown notify action", ephemeral: true });
      }

      // Accounts paging/filter buttons
      if (customId.startsWith("acct:")) {
        await interaction.deferUpdate();
        const [_, action, proto, pageStr] = customId.split(":");
        let page = parseInt(pageStr || "0", 10);
        if (!Number.isFinite(page) || page < 0) page = 0;

        const nextProto = (proto && LIST_PROTOCOLS.includes(proto)) ? proto : "all";

        if (action === "page") {
          const payload = await buildListMessage("acct", nextProto, page);
          return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components });
        }

        if (action === "filter") {
          const payload = await buildListMessage("acct", nextProto, 0);
          return interaction.editReply({ content: null, embeds: payload.embeds, components: payload.components });
        }

        return interaction.reply({ content: "❌ Unknown accounts action", ephemeral: true });
      }

      // Add protocol buttons
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

      // Delete confirm/cancel
      if (customId.startsWith("delcancel:")) {
        return interaction.update({ content: "✅ Delete dibatalkan.", embeds: [], components: [] });
      }

      if (customId.startsWith("delconfirm:")) {
        if (!isAdmin(interaction.member, ADMIN_ROLE_ID)) {
          return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });
        }
        const parts = customId.split(":");
        const protocol = parts[1] || "";
        const base = parts[2] || "";
        await interaction.deferUpdate();

        const resp = await callBackend({ action: "del", protocol, username: base });
        if (resp.status !== "ok") {
          return interaction.followUp({ content: `❌ Failed: ${resp.error || "unknown error"}`, ephemeral: true });
        }

        return interaction.editReply({ content: `✅ Deleted: ${resp.username}`, embeds: [], components: [] });
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

  if (cmd === "channel") {
    const panel = buildChannelPanel();
    return interaction.reply({ ...panel, ephemeral: true });
  }

  if (cmd === "audit") {
    const panel = buildAuditPanel();
    return interaction.reply({ ...panel, ephemeral: true });
  }

  if (cmd === "welcome" || cmd === "wellcome") {
    const panel = buildWelcomePanel();
    return interaction.reply({ ...panel, ephemeral: true });
  }

  if (cmd === "purge") {
    const panel = buildPurgePanel({ channelId: interaction.channelId, count: PURGE_DEFAULT_COUNT, mode: PURGE_DEFAULT_MODE });
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
    try {
      const proto = interaction.options.getString("protocol") || "all";
      const user = interaction.options.getString("username");

      // If both provided, do direct confirm for that user
      if (user) {
        const p = String(proto || "").toLowerCase().trim();
        if (!LIST_PROTOCOLS.includes(p)) {
          return interaction.reply({ content: "❌ Invalid protocol", ephemeral: true });
        }
        const base = String(user || "").trim();
        if (!/^[A-Za-z0-9_]+$/.test(base)) {
          return interaction.reply({ content: "❌ Invalid username (no suffix).", ephemeral: true });
        }

        const final = (p === "all") ? null : `${base}@${p}`;
        if (!final) {
          return interaction.reply({ content: "❌ Untuk delete langsung, protocol tidak boleh 'all'.", ephemeral: true });
        }

        const parsed = parseFinalEmail(final);
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

        return interaction.reply({ content: null, embeds: [embed], components: [row], ephemeral: true });
      }

      // else: list mode (reuse accounts list builder but del list logic from accounts module)
      await interaction.deferReply({ ephemeral: true });
      const payload = await buildListMessage("del", proto, 0);
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

client.login(cfg.TOKEN);