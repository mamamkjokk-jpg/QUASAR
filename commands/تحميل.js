"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "config.json");

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(config) {
  const temp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(config, null, 2));
  fs.renameSync(temp, CONFIG_FILE);
}

module.exports = async function (api, event, args, ...rest) {
  const access = rest[rest.length - 1];

  if (access?.isDeveloper !== true) {
    return api.sendMessage("هذا الأمر للمطور فقط.", event.threadID);
  }

  const action = String(args[1] || "").trim();

  if (!["تفعيل", "ايقاف", "إيقاف"].includes(action)) {
    return api.sendMessage(
      "الاستخدام:\n!تحميل تفعيل\n!تحميل ايقاف",
      event.threadID
    );
  }

  try {
    const config = readConfig();

    if (action === "تفعيل" &&
        !String(config.FASTSAVER_API_KEY || "").trim()) {
      return api.sendMessage(
        "⚠️ أضف FASTSAVER_API_KEY إلى config.json أولاً.",
        event.threadID
      );
    }

    config.AUTO_DOWNLOAD_ENABLED = action === "تفعيل";
    saveConfig(config);

    return api.sendMessage(
      config.AUTO_DOWNLOAD_ENABLED
        ? "✅ تم تفعيل التحميل التلقائي."
        : "⏸️ تم إيقاف التحميل التلقائي.",
      event.threadID
    );
  } catch (error) {
    console.log("[QUASAR DOWNLOAD COMMAND]", error.message);
    return api.sendMessage(
      "❌ تعذر تحديث إعدادات التحميل.",
      event.threadID
    );
  }
};

module.exports.aliases = ["autodownload", "download"];
