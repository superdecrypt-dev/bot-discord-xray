const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { HELP_TABS } = require("./config");

function buildHelpButtons(activeTab) {
  activeTab = String(activeTab || "overview").toLowerCase().trim();
  if (!HELP_TABS.includes(activeTab)) activeTab = "overview";

  const mk = (tab, label, emoji) => {
    const active = activeTab === tab;
    return new ButtonBuilder()
      .setCustomId(`help:tab:${tab}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary);
  };

  const row1 = new ActionRowBuilder().addComponents(
    mk("overview", "Overview", "📘"),
    mk("accounts", "Accounts", "📚"),
    mk("add", "Add", "➕"),
    mk("del", "Delete", "🗑️"),
    mk("notify", "Notify", "🛎️"),
  );

  const row2 = new ActionRowBuilder().addComponents(
    mk("ping", "Ping", "🏓"),
    mk("status", "Status", "🧩"),
  );

  const row3 = new ActionRowBuilder().addComponents(
    mk("purge", "Purge", "🧹"),
    mk("channel", "Channel", "📌"),
    mk("welcome", "Welcome", "👋"),
    mk("audit", "Audit", "🧾"),
  );

  return [row1, row2, row3];
}

function buildHelpEmbed(tab) {
  tab = String(tab || "overview").toLowerCase().trim();
  if (!HELP_TABS.includes(tab)) tab = "overview";

  const e = new EmbedBuilder().setTitle("📘 XRAY Discord Bot Help");

  if (tab === "overview") {
    e.setDescription(
      [
        "**Ringkasan**",
        "- Bot UI (Node.js) hanya mengirim perintah ke backend via IPC (UNIX socket).",
        "- Backend yang melakukan perubahan Xray & filesystem yang sensitif.",
        "",
        "**Hak akses**",
        "- Admin only: `/accounts`, `/add`, `/del`, `/notify`, `/status`, `/purge`, `/channel`, `/welcome`, `/audit`",
        "- Publik: `/ping`, `/help`",
        "",
        "**Aturan username**",
        "- Username hanya: `[A-Za-z0-9_]` (tanpa suffix)",
        "- Bot akan menambahkan suffix: `@vless/@vmess/@trojan/@allproto`",
      ].join("\n")
    );
    e.setFooter({ text: "Gunakan tombol tab di bawah untuk melihat cara pakai tiap command." });
    return e;
  }

  if (tab === "accounts") {
    e.setDescription(
      [
        "**/accounts (Admin only)**",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/accounts` untuk melihat daftar akun",
        "2) Gunakan **filter buttons** untuk memilih protocol (ALL/VLESS/VMESS/TROJAN/ALLPROTO)",
        "3) Pilih user dari dropdown → bot mengirim ulang file **XRAY ACCOUNT DETAIL (.txt)**",
        "",
        "**Catatan:**",
        "- Table hanya menampilkan **No & Username** untuk tampilan yang bersih",
        "- Paging pakai tombol Prev/Next",
      ].join("\n")
    );
    return e;
  }

  if (tab === "add") {
    e.setDescription(
      [
        "**/add (Admin only)**",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/add` → muncul tombol protocol",
        "2) Klik protocol (VLESS/VMESS/TROJAN/ALLPROTO)",
        "3) Isi form: `username`, `days`, `quota_gb`",
        "4) Jika sukses: bot attach file **.txt** detail akun + tombol resend",
        "",
        "**Validasi:**",
        "- Username wajib `[A-Za-z0-9_]`",
        "- Days: 1..3650",
        "- Quota: 0 = unlimited",
      ].join("\n")
    );
    return e;
  }

  if (tab === "del") {
    e.setDescription(
      [
        "**/del (Admin only)**",
        "",
        "**Mode 1 (List UI):**",
        "1) Jalankan `/del` → tampil table + filter buttons",
        "2) Pilih user dari dropdown → muncul confirm/cancel",
        "3) Klik **Confirm Delete** untuk menghapus",
        "",
        "**Mode 2 (Direct confirm):**",
        "- `/del protocol:<proto> username:<user>` → langsung tampil confirm/cancel",
      ].join("\n")
    );
    return e;
  }

  if (tab === "notify") {
    e.setDescription(
      [
        "**/notify (Admin only)**",
        "",
        "**Panel notifikasi berkala (Ping + Status):**",
        "1) Jalankan `/notify` → panel + tombol",
        "2) Klik **Set Channel** → pilih channel notifikasi (mis. `#notifikasi`)",
        "3) Klik **Set Interval** → isi menit (min 1, bisa sangat besar/unlimited)",
        "4) Klik **Enable/Disable** untuk toggle",
        "5) Klik **Test Now** untuk kirim 1x sekarang",
        "",
        "**Catatan:**",
        "- Notifikasi dikirim dalam format **text-only** agar stabil di dark/light mode",
      ].join("\n")
    );
    return e;
  }

  if (tab === "ping") {
    e.setDescription(
      [
        "**/ping (Publik)**",
        "",
        "**Fungsi:**",
        "- Health check bot + latency backend IPC (ms)",
        "",
        "**Output:** text-only (codeblock) untuk menghindari dual rendering.",
      ].join("\n")
    );
    return e;
  }

  if (tab === "status") {
    e.setDescription(
      [
        "**/status (Admin only)**",
        "",
        "**Fungsi:**",
        "- Menampilkan status service `xray` dan `nginx` (hasil dari backend)",
        "",
        "**Output:** text-only (codeblock) agar jelas di dark/light mode.",
      ].join("\n")
    );
    return e;
  }

  if (tab === "purge") {
    e.setDescription(
      [
        "**/purge (Admin only)**",
        "",
        "**Fungsi:**",
        "- Membersihkan pesan di channel saat ini dengan UI button.",
        "- Mendukung mode: **BOT_ONLY** (default) atau **ALL** (kecuali pinned).",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/purge`",
        "2) Pilih jumlah pesan (10/25/50/100)",
        "3) Toggle mode bila perlu",
        "4) Klik **Confirm** untuk eksekusi",
        "",
        "**Catatan:**",
        "- Pesan pinned tidak dihapus.",
        "- Discord tidak bisa bulk delete pesan >14 hari (akan di-skip otomatis).",
      ].join("\n")
    );
    return e;
  }

  if (tab === "channel") {
    e.setDescription(
      [
        "**/channel (Admin only)**",
        "",
        "**Fungsi:**",
        "- Mengatur channel untuk fitur bot: **notify / audit / welcome**.",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/channel`",
        "2) Klik `Set Notify` / `Set Audit` / `Set Welcome`",
        "3) Pilih channel dari dropdown",
        "",
        "**Catatan:**",
        "- Ini hanya mengatur target channel (tidak mengaktifkan fitur).",
      ].join("\n")
    );
    return e;
  }

  if (tab === "welcome") {
    e.setDescription(
      [
        "**/welcome (Admin only)**",
        "",
        "**Fungsi:**",
        "- Mengirim welcome message saat member join.",
        "- Bisa set channel dan edit template via modal.",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/welcome`",
        "2) Klik `Set Channel` lalu pilih channel",
        "3) Klik `Edit Template` untuk ubah pesan (token: `{user}` `{username}` `{server}`)",
        "4) Klik `Enable` untuk aktifkan",
        "5) Klik `Test` untuk kirim contoh",
      ].join("\n")
    );
    return e;
  }

  if (tab === "audit") {
    e.setDescription(
      [
        "**/audit (Admin only)**",
        "",
        "**Fungsi:**",
        "- Mencatat aktivitas admin pada bot (opsional).",
        "- Bisa kirim log ke channel audit (text-only).",
        "",
        "**Cara pakai:**",
        "1) Jalankan `/audit`",
        "2) Klik `Set Channel` lalu pilih channel",
        "3) Klik `Enable` untuk aktifkan",
        "4) Klik `Test` untuk kirim 1 event contoh",
        "",
        "**Catatan:**",
        "- Panel menampilkan ringkasan event terbaru (preview).",
      ].join("\n")
    );
    return e;
  }

  e.setDescription("Help tab not found.");
  return e;
}

function buildHelpPanel(activeTab) {
  const embed = buildHelpEmbed(activeTab);
  const components = buildHelpButtons(activeTab);
  return { embeds: [embed], components };
}

module.exports = { buildHelpPanel };
