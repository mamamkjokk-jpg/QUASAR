"use strict";

module.exports = async (api, event, args, startTime, loadData, saveData, automicTimers, config, hostingInfo, botSentMessages, BOT_ID, builtInCommandNames, customCommandNames, commands, access = {}) => {
  const threadID = String(event?.threadID || "");
  if (access.isDeveloper !== true) {
    if (threadID) await api.sendMessage("⛔ هذا الأمر للمطور فقط.", threadID);
    return false;
  }

  const data = loadData() || {};
  data.publicMode = true;
  saveData(data);

  if (threadID) {
    await api.sendMessage("🔓 تم فتح استخدام QUASAR للجميع.", threadID);
  }
  return true;
};

module.exports.aliases = ["open", "فتح_عام"];
