const os = require("os");

const command = async (
  api, event, args, startTime,
  loadData, saveData, automicTimers,
  config, hostingInfo, botSentMessages, BOT_ID,
  builtInCommands, customCommandNames
) => {
  try {
    const data = typeof loadData === "function" ? loadData() || {} : {};

    const elapsed = Number(startTime) > 0
      ? Math.max(0, Date.now() - Number(startTime))
      : process.uptime() * 1000;

    function duration(ms) {
      let s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400);
      s %= 86400;
      const h = Math.floor(s / 3600);
      s %= 3600;
      const m = Math.floor(s / 60);
      s %= 60;
      return `${d} يوم، ${h} ساعة، ${m} دقيقة، ${s} ثانية`;
    }

    function bytes(value) {
      if (!Number.isFinite(value)) return "غير معروف";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let n = value;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
      }
      return `${n.toFixed(2)} ${units[i]}`;
    }

    function count(value) {
      if (Array.isArray(value)) return value.length;
      if (value && typeof value === "object")
        return Object.keys(value).length;
      return 0;
    }

    const mem = process.memoryUsage();
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    const botStart = new Date(Date.now() - elapsed)
      .toLocaleString("ar-EG");

    const load = os.loadavg().map(n => n.toFixed(2)).join(" / ");

    const msg = [
      "🌌✨━━━━━━━━━━ ⚛️ QUASAR ⚛️ ━━━━━━━━━━✨🌌",
      "                 📊 إحصائيات وحالة النظام",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "╭━━━ 🟢 حالة البوت ━━━╮",
      "│ الحالة: ONLINE",
      `│ الاسم: ${config?.BOT_NAME || "QUASAR"}`,
      "╰━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭━━━ ⏱️ مدة التشغيل ━━━╮",
      `│ مدة التشغيل: ${duration(elapsed)}`,
      `│ بدأ التشغيل: ${botStart}`,
      `│ مدة عملية Node: ${duration(process.uptime() * 1000)}`,
      "╰━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭━━━ 💻 معلومات النظام ━━━╮",
      `│ النظام: ${os.type()} ${os.release()}`,
      `│ المعمارية: ${os.arch()}`,
      `│ Node.js: ${process.version}`,
      `│ المعالج: ${cpus[0]?.model || "غير معروف"}`,
      `│ عدد الأنوية: ${cpus.length}`,
      `│ حمل النظام: ${load}`,
      "╰━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭━━━ 🧠 الذاكرة ━━━╮",
      `│ الرام المستخدمة: ${bytes(totalMem - freeMem)}`,
      `│ الرام المتاحة: ${bytes(freeMem)}`,
      `│ الرام الإجمالية: ${bytes(totalMem)}`,
      `│ ذاكرة البوت RSS: ${bytes(mem.rss)}`,
      `│ Heap Used: ${bytes(mem.heapUsed)}`,
      `│ Heap Total: ${bytes(mem.heapTotal)}`,
      "╰━━━━━━━━━━━━━━━━━━╯",
      "",
      "╭━━━ 📈 إحصائيات البوت ━━━╮",
      `│ المجموعات المحفوظة: ${count(data.savedGroupNames)}`,
      `│ الأوامر الأساسية: ${count(builtInCommands)}`,
      `│ الأوامر المخصصة: ${count(customCommandNames)}`,
      `│ أنظمة القفل: ${count(data.locked)}`,
      `│ أنظمة الحماية: ${count(data.protected)}`,
      `│ المؤقتات النشطة: ${count(automicTimers)}`,
      "╰━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "🌠 QUASAR",
      "             Powered by ⚛️"
    ].join("\n");

    return api.sendMessage(msg, event.threadID);
  } catch (err) {
    console.log("SHADOW UPTIME ERROR:", err.stack || err);
    return api.sendMessage("تعذر عرض معلومات حالة البوت.", event.threadID);
  }
};


command.aliases = ["ابتايم"];
module.exports = command;
