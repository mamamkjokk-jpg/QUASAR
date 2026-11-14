"use strict";

module.exports = async (api, event, args, startTime, loadData, saveData, automicTimers, config, hostingInfo, botSentMessages, BOT_ID, builtInCommandNames, customCommandNames, commands, access = {}) => {
  const threadID = String(event?.threadID || "");
  if (access.isDeveloper !== true) {
    if (threadID) await api.sendMessage("⛔ هذا الأمر للمطور فقط.", threadID);
    return false;
  }

  const data = loadData() || {};
  data.publicMode = false;
  saveData(data);

  if (threadID) {
    await api.sendMessage("🔒 تم قفل استخدام QUASAR. المطور فقط يستطيع استخدام الأوامر.", threadID);
  }
  return true;
};

module.exports.aliases = ["close", "قفل_عام"];
