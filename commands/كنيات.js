"use strict";
const { getThreadInfoSafe } = require("../SHADOW/thread-info-guard");


const { invoke } = require("../SHADOW/quasar-command-utils");

function deleteAfterSixSeconds(api, sent) {
  const messageID = sent && sent.messageID;
  if (!messageID) return;

  setTimeout(() => {
    invoke(api, "unsendMessage", [String(messageID)]).catch(error => {
      console.log("تعذر حذف رسالة التغيير تلقائيًا:", error.message || error);
    });
  }, 6000);
}

const DELAY = 1800;
const INTERVAL = 3000;
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

function setNicknameAsync(api, nickname, threadID, userID) {
  const method = [api.nickname, api.changeNickname, api.setNickname].find(fn => typeof fn === "function");
  if (!method) return Promise.reject(new Error("مكتبة @dongdev/fca-unofficial لا توفر دالة تغيير الكنية"));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const done = error => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    timeout = setTimeout(() => done(new Error("انتهت مهلة تغيير الكنية بعد 30 ثانية")), 30000);

    try {
      const result = method.call(api, nickname, String(threadID), String(userID), done);
      if (result && typeof result.then === "function") {
        result.then(() => done(), done);
      } else if (method.length < 4) {
        done();
      }
    } catch (error) {
      done(error);
    }
  });
}

function timerKey(threadID) {
  return "nik_" + threadID;
}

function getSkipped(config, BOT_ID) {
  // Keep the bot and every configured developer outside group-wide nickname changes.
  const developers = [
    ...(Array.isArray(config?.DEV_IDS) ? config.DEV_IDS : []),
    config?.DEV_ID
  ].map(value => String(value || "")).filter(Boolean);
  return new Set([String(BOT_ID || ""), ...developers].filter(Boolean));
}

function startProtection(api, threadID, nickname, loadData, automicTimers, config, BOT_ID) {
  const key = timerKey(threadID);

  if (automicTimers[key]) {
    clearInterval(automicTimers[key]);
    delete automicTimers[key];
  }

  let busy = false;
  const skip = getSkipped(config, BOT_ID);

  automicTimers[key] = setInterval(async () => {
    if (busy) return;
    busy = true;

    try {
      const info = await getThreadInfoSafe(api, threadID);
      const nicknames = info.nicknames || info.customNicknames || {};

      for (const uid of (info.participantIDs || [])) {
        if (skip.has(String(uid))) continue;

        if (String(nicknames[uid] || "") === nickname) continue;

        try {
          await setNicknameAsync(api, nickname, threadID, uid);
        } catch {}
      }
    } catch (e) {
      console.log("خطأ حماية الكنيات:", e.message);
    } finally {
      busy = false;
    }
  }, INTERVAL);
}

module.exports = async (api, event, args, startTime, loadData, saveData, automicTimers, config, hostingInfo, botSentMessages, BOT_ID) => {
  const threadID = String(event.threadID || "");
  if (!threadID) return;

  const data = loadData() || {};
  const prefix = String(data.prefix || "!");
  if (!data.nicknameProtections || typeof data.nicknameProtections !== "object" || Array.isArray(data.nicknameProtections)) {
    data.nicknameProtections = {};
  }
  if (!data.nicknameMemberCache || typeof data.nicknameMemberCache !== "object" || Array.isArray(data.nicknameMemberCache)) {
    data.nicknameMemberCache = {};
  }

  const action = String(args[1] || "").trim().toLowerCase();
  const key = timerKey(threadID);

  if (["off", "stop", "إيقاف", "ايقاف"].includes(action)) {
    if (automicTimers[key]) {
      clearInterval(automicTimers[key]);
      delete automicTimers[key];
    }

    delete data.nicknameProtections[threadID];
    saveData(data);

    return api.sendMessage(
      "🛑 تم إيقاف حماية الكنيات.\n🗑️ تم حذف الكنية المحفوظة.\n👥 الكنيات الحالية لم يتم تغييرها.",
      threadID
    );
  }

  const nickname = args.slice(1).join(" ").trim();

  if (!nickname) {
    return api.sendMessage(
      "👥 🛡️ حماية الكنيات\n\n" +
      "لتغيير كنيات جميع الأعضاء وتفعيل الحماية:\n" +
      `${prefix}nik [الكنية الجديدة]\n\n` +
      "لإيقاف الحماية:\n" +
      `${prefix}nik إيقاف\n\n` +
      `🔤 الاسم الآخر: ${prefix}كنيات\n` +
      "يُستثنى المطورون وحساب البوت من التغيير والحماية الجماعية.",
      threadID
    );
  }

  if (data.protected?.[threadID]?.active) {
    return api.sendMessage(
      "⚠️ حماية الكنيات القديمة مفعّلة في هذه المجموعة.\nأوقفها أولًا لتجنب تعارض الحمايتين.",
      threadID
    );
  }

  let members;
  try {
    const info = await getThreadInfoSafe(api, threadID);
    const participantIDs = Array.isArray(info?.participantIDs)
      ? [...new Set(info.participantIDs.map(uid => String(uid || "")).filter(Boolean))]
      : [];

    if (!participantIDs.length) {
      throw new Error("قائمة أعضاء المجموعة فارغة أو غير صالحة");
    }

    data.nicknameMemberCache[threadID] = {
      participantIDs,
      savedAt: Date.now()
    };
    saveData(data);

    const skip = getSkipped(config, BOT_ID);
    members = participantIDs.filter(uid => !skip.has(uid));

    console.log(`[NICKNAME CACHE] Fresh member list saved for ${threadID}: ${participantIDs.length}`);
  } catch (e) {
    console.error("NIK_GET_THREAD_INFO_ERROR:", e && (e.stack || e.message || e));

    const cached = data.nicknameMemberCache[threadID];
    const age = Date.now() - Number(cached?.savedAt);
    const cachedIDs = Array.isArray(cached?.participantIDs)
      ? [...new Set(cached.participantIDs.map(uid => String(uid || "")).filter(Boolean))]
      : [];

    if (
      cachedIDs.length > 0 &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= CACHE_MAX_AGE_MS
    ) {
      const skip = getSkipped(config, BOT_ID);
      members = cachedIDs.filter(uid => !skip.has(uid));

      console.log(
        `[NICKNAME CACHE] Using saved member list for ${threadID}; age: ${Math.round(age / 1000)} seconds`
      );
    } else {
      return api.sendMessage(
        "❌ تعذرت قراءة أعضاء المجموعة، ولا توجد قائمة احتياطية حديثة وموثوقة (آخر 10 دقائق).\nانتظر حتى تنتهي مهلة Facebook ثم أعد المحاولة.",
        threadID
      );
    }
  }

  data.nicknameProtections[threadID] = nickname;
  saveData(data);

  const startMessage = await api.sendMessage(
    "🌷 بدء تغيير الكنيات...\n" +
    "👥 عدد الأعضاء: " + members.length + "\n" +
    "⚡ مهلة تغيير كل عضو: 1.8 ثانية\n" +
    "🔄 فحص الحماية كل 3 ثوانٍ\n" +
    "🛡️ سيتم تفعيل الحماية فور اكتمال تغيير الكنيات",
    threadID
  );
  deleteAfterSixSeconds(api, startMessage);

  let changedCount = 0;
  const failedMembers = [];
  for (let i = 0; i < members.length; i++) {
    try {
      await setNicknameAsync(api, nickname, threadID, members[i]);
      changedCount++;
    } catch (e) {
      failedMembers.push(String(members[i]));
      console.log("تعذر تغيير كنية عضو:", e?.message || e);
    }

    if (i < members.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY));
    }
  }

  startProtection(api, threadID, nickname, loadData, automicTimers, config, BOT_ID);

  const completion = members.length === 0
    ? "⚠️ لم يتم العثور على أعضاء متاحين لتغيير كنياتهم."
    : changedCount === members.length
      ? "✅ تم الانتهاء؛ تم تغيير جميع الكنيات بنجاح."
      : `⚠️ انتهى التنفيذ: تم تغيير ${changedCount} من ${members.length} كنية.`;
  const failedText = failedMembers.length
    ? `\n❌ تعذر تغيير ${failedMembers.length} عضو.\nالمعرّفات: ${failedMembers.slice(0, 15).join(", ")}${failedMembers.length > 15 ? " ..." : ""}`
    : "";

  await api.sendMessage(
    `${completion}\n👥 عدد الأعضاء المستهدفين: ${members.length}` +
    `\n🔁 فحص واسترجاع الكنية المحفوظة كل 3 ثوانٍ.` +
    `\n📝 الكنيات المحفوظة: [${nickname}]` + failedText,
    threadID
  );
};

module.exports.restoreProtection = startProtection;

module.exports.getSkipped = getSkipped;

module.exports.aliases = ["nik"];
