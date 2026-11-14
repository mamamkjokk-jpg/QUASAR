"use strict";

const sections = [
  ["🛡️ إدارة المجموعة", [
    ["اسم", "اسم", "🏷️"],
    ["كنيات", "كنيات", "👥"],
    ["خروج", "خروج", "🚪"],
    ["حذف", "حذف", "🗑️"]
  ]],
  ["🔐 إدارة الوصول", [
    ["فتح", "فتح", "🔓"],
    ["قفل", "قفل", "🔒"],
    ["التحكم", "التحكم", "🎛️"]
  ]],
  ["🔁 أنظمة التكرار", [
    ["بيس", "بيس", "⚡"],
    ["محرك", "محرك", "🚀"]
  ]],
  ["👤 حساب البوت", [
    ["setbio", "بايو", "🪪"],
    ["صورة", "صورة", "🖼️"]
  ]],
  ["🧰 أدوات النظام", [
    ["command", "command", "🔧"],
    ["uptime", "uptime", "⏱️"],
    ["جلسة", "جلسة", "🖥️"],
    ["help", "help", "📜"]
  ]]
];

module.exports = (api, event, _args, _startTime, loadData,
  _saveData, _timers, _config, _hosting, _sent, _botID,
  builtInCommands = [], customCommandNames = []) => {
  const prefix = String((loadData() || {}).prefix || "!");
  const available = new Set([...builtInCommands, ...customCommandNames].map(String));
  const shown = new Set();

  const output = [
    "🌌✨━━━━━━━━━━ ⚛️ QUASAR ⚛️ ━━━━━━━━━━✨🌌",
    "             📜 قَائِمَةُ الأَوَامِر 📜",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ];

  for (const [title, commands] of sections) {
    const active = commands.filter(([name]) => available.has(name));
    if (!active.length) continue;

    output.push(`\n${title}`);
    output.push("✨━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━✨");

    for (const [name, displayName, icon] of active) {
      shown.add(name);
      output.push(`${icon} ${prefix}${displayName}`);
    }
  }

  const custom = [...new Set(customCommandNames.map(String))]
    .filter(name => !shown.has(name) && available.has(name))
    .sort((a, b) => a.localeCompare(b, "ar"));

  if (custom.length) {
    output.push("\n🧩 الأوامر المخصصة");
    output.push("✨━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━✨");
    for (const name of custom) output.push(`🔹 ${prefix}${name}`);
  }

  return api.sendMessage(output.join("\n"), event.threadID);
};
