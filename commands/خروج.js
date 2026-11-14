"use strict";
function invoke(api, methodName, args, timeoutMs = 30000) {
  const method = api && api[methodName];
  if (typeof method !== "function") return Promise.reject(new Error(`واجهة ${methodName} غير متاحة`));
  if (method.length <= args.length) {
    try { return Promise.resolve(method.apply(api, args)); }
    catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`انتهت مهلة ${methodName}`)), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    try {
      const result = method.apply(api, [...args, (error, value) => finish(error, value)]);
      if (result && typeof result.then === "function") result.then(value => finish(null, value), finish);
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = async (api, event, args, startTime, loadData, saveData, automicTimers, config, hostingInfo, botSentMessages, BOT_ID) => {
  const threadID = String(event?.threadID || "");
  if (!threadID) return;

  // أوقف جميع المؤقتات التابعة لهذه المجموعة، وليس مفاتيح الأوامر القديمة فقط.
  for (const [key, value] of Object.entries(automicTimers || {})) {
    const belongsToGroup = String(value?.threadID || "") === threadID ||
      key === threadID || key === `nik_${threadID}`;
    if (!belongsToGroup) continue;

    try {
      if (value && typeof value.stop === "function") value.stop();
      else {
        if (value) clearTimeout(value);
        if (value) clearInterval(value);
      }
    } catch (error) {
      console.log("تعذر إيقاف مؤقت المجموعة:", error?.message || error);
    }
    delete automicTimers[key];
  }

  const botID = String(BOT_ID || (typeof api.getCurrentUserID === "function" ? api.getCurrentUserID() : ""));
  if (!botID) return api.sendMessage("تعذر تحديد حساب البوت لمغادرة المجموعة.", threadID);

  try {
    await api.sendMessage("🚪 يغادر QUASAR هذه المجموعة الآن.", threadID);
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 900));

  try {
    if (typeof api.removeUserFromGroup === "function") {
      await invoke(api, "removeUserFromGroup", [botID, threadID]);
    } else if (typeof api.gcmember === "function") {
      await invoke(api, "gcmember", ["remove", botID, threadID]);
    } else {
      throw new Error("لا تتوفر دالة مغادرة المجموعة في مكتبة @dongdev/fca-unofficial");
    }
  } catch (error) {
    console.log("SHADOW LEAVE GROUP ERROR:", error?.message || error);
    return api.sendMessage(`❌ تعذر إخراج البوت من المجموعة: ${String(error?.message || error).slice(0, 180)}`, threadID);
  }
};

module.exports.aliases = ["leave"];
