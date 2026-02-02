function formatAccountsTable(items) {
  const header = "No  Username";
  const lines = [header];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const no = String(i + 1).padEnd(3, " ");
    const user = String(it.username || "-").slice(0, 40);
    lines.push(`${no}${user}`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

module.exports = { formatAccountsTable };
