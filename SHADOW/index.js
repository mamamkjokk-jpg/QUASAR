const fcaLogin = require("@dongdev/fca-unofficial");
const { getThreadInfoSafe, getThreadListSafe, isCoolingDown, installThreadOperationGuard } = require("./thread-info-guard");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.SHADOW_DATA_DIR || ROOT);
fs.mkdirSync(DATA_DIR, { recursive: true });
const os = require("os");
const http = require("http");
const stats = require("./stats");
const { canExecuteCommand } = require("./command-access");
const autoDownload = require("./auto-download");
const { createMessageActivity } = require("./message-activity");

process.on("uncaughtException", (err) => console.log("خطأ:", err.message));
process.on("unhandledRejection", (reason) => console.log("خطأ:", reason));

const savedConfig = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")); }
  catch { return {}; }
})();
const SESSION_ID = String(process.env.SHADOW_SESSION_ID || "1");
if (!/^[123]$/.test(SESSION_ID)) throw new Error("رقم الجلسة غير صالح");
const SESSION_SUFFIX = SESSION_ID === "1" ? "" : SESSION_ID;
const SESSION_FILE = path.join(DATA_DIR, "appState" + SESSION_SUFFIX + ".json");
const DATA_FILE = path.join(DATA_DIR, "data" + SESSION_SUFFIX + ".json");
const STATUS_FILE = path.join(DATA_DIR, "bot-status" + SESSION_SUFFIX + ".json");
const CUSTOM_COMMANDS_FILE = path.join(DATA_DIR, "custom-commands" + SESSION_SUFFIX + ".json");
const GROUP_REFRESH_SIGNAL_FILE = path.join(DATA_DIR, ".groups-refresh" + SESSION_SUFFIX + ".json");
const PORT = Number(process.env.SHADOW_BOT_PORT || process.env.PORT || (SESSION_ID === "1" ? 3000 : SESSION_ID === "2" ? 3002 : 3003));
const sessionConfig = savedConfig.SESSIONS?.[SESSION_ID] || {};
const environmentDevIds = String(process.env.DEV_IDS || "")
  .split(",").map(value => value.trim()).filter(value => /^[0-9]{5,25}$/.test(value));
const DEV_ID = String(process.env.DEV_ID || savedConfig.DEV_ID || environmentDevIds[0] || "");
const configuredDevIds = Array.isArray(savedConfig.DEV_IDS)
  ? savedConfig.DEV_IDS.map(String).filter(x => /^[0-9]{5,25}$/.test(x)).slice(0, 10)
  : [];
const DEV_IDS = [...new Set([DEV_ID, ...configuredDevIds, ...environmentDevIds].filter(x => /^[0-9]{5,25}$/.test(x)))];
const config = {
  BOT_NAME: "QUASAR",
  BOT_NICK: String(sessionConfig.BOT_NICK || savedConfig.BOT_NICK || "𝚀𝚄𝙰𝚂𝙰𝚁 ⦓ ⚛️ ⦔"),
  NICK_GUARD_ENABLED: (sessionConfig.NICK_GUARD_ENABLED ?? savedConfig.NICK_GUARD_ENABLED) !== false,
  DEV_ID,
  DEV_IDS,
  DEV_NICK: String(savedConfig.DEV_NICK || "𝚂𝙷𝙰𝙳𝙾𝚆 ⦓ ⚛️ ⦔"),
  DEV_NAME: "SHADOW"
};


http.createServer((req, res) => res.end("ok")).listen(PORT, "127.0.0.1");

const appState = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { prefix: "!", freePrefix: false, protected: {}, savedMessages: [], admins: [], locked: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const commands = {};
fs.readdirSync(path.join(ROOT, "commands")).sort().forEach(file => {
  if (!file.endsWith(".js")) return;
  const commandName = file.slice(0, -3);
  const handler = require(path.join(ROOT, "commands", file));
  commands[commandName] = handler;
  for (const alias of Array.isArray(handler.aliases) ? handler.aliases : []) {
    const aliasName = String(alias || "").trim().toLowerCase();
    if (!aliasName || Object.prototype.hasOwnProperty.call(commands, aliasName)) continue;
    Object.defineProperty(commands, aliasName, {
      value: handler,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
});

const events = {};
fs.readdirSync(path.join(ROOT, "events")).forEach(file => {
  if (file.endsWith(".js")) {
    events[file.replace(".js", "")] = require(path.join(ROOT, "events", file));
  }
});

const automicTimers = {};
const botSentMessages = {};
const startTime = Date.now();

let currentBotId = null;

function writeBotStatus(online) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      online,
      botId: currentBotId,
      startedAt: new Date(startTime).toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.log("تعذر تحديث حالة البوت:", e.message);
  }
}

process.on("exit", () => writeBotStatus(false));

function trackMsg(threadID, msgID) {
  if (!threadID || !msgID) return;
  if (!botSentMessages[threadID]) botSentMessages[threadID] = [];
  botSentMessages[threadID].push(msgID);
  if (botSentMessages[threadID].length > 60) botSentMessages[threadID].shift();
}

function sendMessageAsync(api, message, threadID, replyToMessageID) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("انتهت مهلة إرسال الرسالة بعد 30 ثانية")),
      30000
    );

    function finish(error, info) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(info);
    }

    try {
      const result = api.sendMessage(
        message,
        String(threadID),
        replyToMessageID == null ? undefined : String(replyToMessageID)
      );
      Promise.resolve(result).then(
        info => finish(null, info),
        error => finish(error)
      );
    } catch (error) {
      finish(error);
    }
  });
}

fcaLogin({ appState }, { listenEvents: true, selfListen: false }, (err, api) => {
  if (err) {
    writeBotStatus(false);
    const loginErrorText = String(err?.message || err || "");
    if (/checkpoint|too many sessions|multiple sessions|session limit|login.?blocked|temporarily blocked|rate.?limit|http\s*429|\b429\b|\b368\b/i.test(loginErrorText)) {
      console.log("⛔ رفضت مكتبة FCA تسجيل الدخول أو طلب Facebook تحققًا/قيّد الجلسات. لم تتم أي محاولة دخول إضافية:", loginErrorText.slice(0, 240));
    } else {
      console.log("خطأ في تسجيل الدخول عبر @dongdev/fca-unofficial:", loginErrorText.slice(0, 240));
    }
    return;
  }

  const BOT_ID = api.getCurrentUserID();
  currentBotId = BOT_ID;

  const messageActivity = createMessageActivity({
    developerIds: config.DEV_IDS,
    react: async (messageID, threadID) => {
      if (typeof api.setMessageReactionMqtt !== "function") {
        throw new Error("دالة التفاعل غير متاحة");
      }
      await api.setMessageReactionMqtt("❤️", messageID, threadID);
    }
  });


  // Adapt the new FCA method names to the legacy SHADOW command surface.
  const fcaCompat = require("./fca-compat")(api);
  console.log("[FCA COMPAT] Installed:", fcaCompat.installed.join(", ") || "native methods");

  installThreadOperationGuard(api);

  // Restore saved nickname protections for this session
  const nicknameCommand = commands["كنيات"];
  if (nicknameCommand && typeof nicknameCommand.restoreProtection === "function") {
    const savedNicknameProtections = loadData().nicknameProtections || {};
    for (const [threadID, nickname] of Object.entries(savedNicknameProtections)) {
      if (typeof nickname === "string" && nickname.trim()) {
        nicknameCommand.restoreProtection(
          api, String(threadID), nickname, loadData, automicTimers, config, BOT_ID
        );
      }
    }
  }
  let reportedOnline = true;
  writeBotStatus(true);

  // The replacement library emits explicit account/session restriction events.
  // Never attempt an extra login when Facebook requests a checkpoint or blocks login.
  if (typeof api.on === "function") {
    const restrictedEvents = ["checkpoint", "checkpoint_282", "checkpoint_956", "loginBlocked", "sessionExpired", "account_inactive"];
    for (const eventName of restrictedEvents) {
      api.on(eventName, details => {
        reportedOnline = false;
        writeBotStatus(false);
        console.log(`[FCA SESSION] ${eventName}:`, String(details?.message || details?.reason || details || "requires account review").slice(0, 220));
        for (const [timerKey, timerValue] of Object.entries(automicTimers)) {
          if (["shadow-atomic", "shadow-engines"].includes(timerValue?.kind) && typeof timerValue.stop === "function") {
            timerValue.stop();
            delete automicTimers[timerKey];
          }
        }
      });
    }
    api.on("rateLimit", details => {
      console.log("[FCA SESSION] Rate limit reported; SHADOW request queue will apply cooldown.", String(details?.message || details || "").slice(0, 160));
    });
  }
  setInterval(() => writeBotStatus(reportedOnline), 5000);
  console.log("✅ يعمل | ID:", BOT_ID);

  const _origSend = api.sendMessage.bind(api);

  // Support legacy callbacks and Promise-returning FCA calls.
  api.sendMessage = (msg, threadID, third, fourth) => {
    const legacyCallback = typeof third === "function" ? third : null;
    const callback = legacyCallback ||
      (typeof fourth === "function" ? fourth : null);

    const rawReplyID = legacyCallback ? fourth : third;
    const replyID = rawReplyID == null ? undefined : String(rawReplyID);

    let result;
    try {
      result = _origSend(msg, String(threadID), replyID);
    } catch (error) {
      if (callback) {
        callback(error);
        return;
      }
      throw error;
    }

    return Promise.resolve(result).then(info => {
      if (info?.messageID) trackMsg(String(threadID), info.messageID);
      if (callback) callback(null, info);
      return info;
    }, error => {
      if (callback) {
        callback(error);
        return undefined;
      }
      throw error;
    });
  };

  const hostingInfo = { platform: os.platform(), arch: os.arch(), node: process.version };

  async function setNicknameCompat(nickname, threadID, userID) {
    const method = [api.nickname, api.changeNickname, api.setNickname]
      .find(fn => typeof fn === "function");
    if (!method) throw new Error("دالة تغيير الكنية غير متاحة في FCA");
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
        if (result && typeof result.then === "function") result.then(() => done(), done);
        else if (method.length < 4) done();
      } catch (error) {
        done(error);
      }
    });
  }

  // ===== SHADOW BOT NICKNAME GUARD =====
  let nicknameCheckRunning = false;

  let discoverGroupsRunning = false;
  async function discoverBotGroups() {
    if (discoverGroupsRunning) return false;
    discoverGroupsRunning = true;
    try {
      const data = loadData();
      data.botGroups = Array.isArray(data.botGroups) ? data.botGroups : [];
      const known = new Map(data.botGroups.map(g => [String(g.id), g]));
      let cursor = null;

      for (let page = 0; page < 25; page++) {
        const list = await getThreadListSafe(api, 100, cursor, ["INBOX", "ARCHIVED"]);
        if (!Array.isArray(list) || !list.length) break;

        for (const thread of list) {
          if (!thread || !thread.isGroup || !thread.threadID) continue;
          const id = String(thread.threadID);
          known.set(id, { id, name: thread.threadName || id });
        }

        if (list.length < 100) break;
        const next = Number(list[list.length - 1].timestamp);
        if (!Number.isSafeInteger(next) || next <= 0 || next === cursor) break;
        cursor = next;
      }

      data.botGroups = [...known.values()];
      data.groupsUpdatedAt = new Date().toISOString();
      saveData(data);
      console.log("تم تحديث قروبات البوت:", data.botGroups.length);
      return true;
    } catch (e) {
      console.log("تعذر اكتشاف القروبات:", e.message);
      return false;
    } finally {
      discoverGroupsRunning = false;
    }
  }

  async function checkBotNicknames() {
    if (nicknameCheckRunning) return;
    nicknameCheckRunning = true;

    try {
      let latest = {};
      try {
        latest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
      } catch {}

      const latestSession = latest.SESSIONS?.[SESSION_ID] || {};
      config.BOT_NICK = String(latestSession.BOT_NICK || latest.BOT_NICK || config.BOT_NICK);
      config.DEV_NICK = String(latest.DEV_NICK || config.DEV_NICK);
      config.NICK_GUARD_ENABLED = (latestSession.NICK_GUARD_ENABLED ?? latest.NICK_GUARD_ENABLED) !== false;

      const developerIds = (
        Array.isArray(latest.DEV_IDS) && latest.DEV_IDS.length
          ? latest.DEV_IDS
          : [latest.DEV_ID || config.DEV_ID]
      ).map(String).filter(id => /^[0-9]{5,25}$/.test(id));

      const targets = [
        { id: String(BOT_ID), nickname: config.BOT_NICK, label: "البوت" },
        ...developerIds
          .filter(id => id !== String(BOT_ID))
          .map(id => ({ id, nickname: config.DEV_NICK, label: "المطور" }))
      ].filter(target => target.nickname && target.nickname.trim());

      if (!config.NICK_GUARD_ENABLED || !targets.length) return;

      const data = loadData();
      const ids = [...new Set([
        ...(Array.isArray(data.botGroups)
          ? data.botGroups.map(g => g && g.id)
          : []),
        ...Object.keys(data.protected || {}),
        ...Object.keys(data.nicknameProtections || {})
      ].map(id => String(id || "")).filter(Boolean))];

      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);
        let infos;

        try {
          infos = await getThreadInfoSafe(api, batch);
        } catch (e) {
          console.log("تعذر فحص القروبات:", e.message);
          if (isCoolingDown(api)) break;
          continue;
        }

        for (const id of batch) {
          const info = infos && infos[id];
          if (!info) continue;

          const nicknames = info.nicknames || info.customNicknames || {};

          const groupNickname = loadData().nicknameProtections?.[id];
          for (const target of targets) {
            // A group-wide nickname command takes precedence over the developer's
            // normal nickname guard in that one group; it resumes after !كنيات off.
            if (target.label === "المطور" && typeof groupNickname === "string" && groupNickname.trim()) {
              continue;
            }

            const current = nicknames[target.id] || "";

            if (current !== target.nickname) {
              try {
                await setNicknameCompat(target.nickname, id, target.id);
                console.log("تم استرجاع كنية " + target.label + " في:", id);
                await new Promise(resolve => setTimeout(resolve, 250));
              } catch (e) {
                console.log("تعذر استرجاع كنية " + target.label + ":", e.message);
              }
            }
          }
        }
      }
    } finally {
      nicknameCheckRunning = false;
    }
  }

  // ===== SHADOW GROUP NAME GUARD =====
  let groupNameCheckRunning = false;
  const groupNameLastAttempt = new Map();

  async function checkSavedGroupNames() {
    if (groupNameCheckRunning) return;
    groupNameCheckRunning = true;

    try {
      const data = loadData();
      const saved = data.savedGroupNames || {};
      const ids = Object.keys(saved).filter(id =>
        typeof saved[id] === "string" && saved[id].trim()
      );

      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);
        let infos;

        try {
          infos = await getThreadInfoSafe(api, batch);
        } catch (e) {
          if (isCoolingDown(api)) {
            console.log("[GROUP NAME GUARD] Cooldown active; remaining batches skipped.");
            break;
          }
          continue;
        }

        for (const id of batch) {
          const latest = loadData().savedGroupNames || {};
          const wanted = latest[id];

          if (typeof wanted !== "string" || !wanted.trim()) continue;

          const info = infos && infos[id];
          if (!info) continue;

          const current = info.threadName || info.name || "";
          if (current === wanted) continue;

          const now = Date.now();
          const last = groupNameLastAttempt.get(id) || 0;

          if (now - last < 30000) continue;

          groupNameLastAttempt.set(id, now);

          try {
            await api.gcname(wanted, id);
          } catch {
            // استرجاع صامت؛ ستتم المحاولة مجددًا بعد المهلة.
          }
        }
      }
    } catch (e) {
      console.log("خطأ في مراقبة أسماء المجموعات:", e.message);
    } finally {
      groupNameCheckRunning = false;
    }
  }

  discoverBotGroups().then(checkBotNicknames);
  setInterval(checkBotNicknames, 60000);
  checkSavedGroupNames();
  setInterval(checkSavedGroupNames, 30000);

  // تحديث قائمة القروبات دورياً لاكتشاف القروبات الجديدة
  setInterval(discoverBotGroups, 300000);

  // استقبال طلب تحديث فوري من لوحة التحكم لهذه الجلسة فقط.
  let refreshSignalRunning = false;
  let refreshSignalRetryAt = 0;

  async function processGroupRefreshSignal() {
    if (
      refreshSignalRunning ||
      discoverGroupsRunning ||
      nicknameCheckRunning ||
      groupNameCheckRunning ||
      Date.now() < refreshSignalRetryAt ||
      !fs.existsSync(GROUP_REFRESH_SIGNAL_FILE)
    ) return;

    refreshSignalRunning = true;
    let signalClaimed = false;

    try {
      try {
        fs.unlinkSync(GROUP_REFRESH_SIGNAL_FILE);
        signalClaimed = true;
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }

      const updated = await discoverBotGroups();

      if (!updated) {
        fs.writeFileSync(GROUP_REFRESH_SIGNAL_FILE, "retry");
        signalClaimed = false;
        refreshSignalRetryAt = Date.now() + 30000;
        console.log("[GROUP REFRESH] Update failed; retry delayed for 30 seconds.");
        return;
      }

      console.log("اكتمل طلب تحديث المجموعات من لوحة التحكم");
    } catch (e) {
      if (signalClaimed) {
        try {
          fs.writeFileSync(GROUP_REFRESH_SIGNAL_FILE, "retry");
        } catch (restoreError) {
          console.log("[GROUP REFRESH] Could not restore signal:", restoreError.message);
        }
      }
      refreshSignalRetryAt = Date.now() + 30000;
      console.log("تعذر تنفيذ تحديث المجموعات المطلوب:", e.message);
    } finally {
      refreshSignalRunning = false;
    }
  }
  const refreshSignalTimer = setInterval(() => {
    processGroupRefreshSignal().catch(e => console.log("خطأ تحديث المجموعات:", e.message));
  }, 1200);
  if (typeof refreshSignalTimer.unref === "function") refreshSignalTimer.unref();

  let sessionErrorLogged = false;
  // Group-name and member-nickname protection events require listenEvents.
  try {
    if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true });
  } catch (eventOptionsError) {
    console.log("تعذر تفعيل أحداث المجموعة:", eventOptionsError?.message || eventOptionsError);
  }
  api.listenMqtt(async (err, event) => {
    if (err) {
      const errorText = String(err?.message || err || "");
      console.log("SHADOW MQTT ERROR:", errorText);
      if (/checkpoint|logged.?out|login required|invalid app.?state|session.{0,20}(expired|invalid)|authentication|not authenticated|too many sessions|multiple sessions|session limit|rate.?limit|temporarily blocked|http\s*429|\b429\b|\b368\b|\b1545012\b/i.test(errorText)) {
        reportedOnline = false;
        writeBotStatus(false);
        for (const [timerKey, timerValue] of Object.entries(automicTimers)) {
          if (["shadow-atomic", "shadow-engines"].includes(timerValue?.kind) && typeof timerValue.stop === "function") {
            timerValue.stop();
            delete automicTimers[timerKey];
          }
        }
        if (!sessionErrorLogged) {
          sessionErrorLogged = true;
          console.log("⚠️ يبدو أن جلسة الحساب انتهت أو رُفضت. لن أبدأ تسجيل دخول جديدًا تلقائيًا؛ افحص جلسة الحساب من تطبيق Facebook الرسمي قبل أي محاولة أخرى.");
        }
        const restrictionDetected = /checkpoint|too many sessions|multiple sessions|session limit|rate.?limit|temporarily blocked|http\s*429|\b429\b|\b368\b|\b1545012\b/i.test(errorText);
        if (restrictionDetected) {
          console.log("⛔ تم إيقاف إعادة تسجيل الدخول التلقائية احترامًا لتقييد الحساب. افحص حالة الحساب من تطبيق Facebook الرسمي قبل أي محاولة جديدة.");
          return;
        }
      }
      return;
    }
    if (!event) return;

    if (["account_inactive", "stop_listen"].includes(String(event.type || ""))) {
      reportedOnline = false;
      writeBotStatus(false);
      console.log("[FCA SESSION] Listener stopped or account inactive:", String(event.reason || event.error?.message || event.error || event.type).slice(0, 220));
      for (const [timerKey, timerValue] of Object.entries(automicTimers)) {
        if (["shadow-atomic", "shadow-engines"].includes(timerValue?.kind) && typeof timerValue.stop === "function") {
          timerValue.stop();
          delete automicTimers[timerKey];
        }
      }
      return;
    }

    reportedOnline = true;
    sessionErrorLogged = false;

    try { stats.recordMessage(event); }
    catch (e) { console.log("خطأ في تسجيل الإحصائيات:", e.message); }

    // إيقاف جميع أحداث القروبات المكتومة قبل تشغيل أي معالج
    const eventThreadID = String(event.threadID || "");
    if (eventThreadID) {
      const currentData = loadData();
      if (currentData.mutedGroups?.[eventThreadID] === true) return;
    }

    // لا تشغّل أحداث الترحيب/الدخول عندما يكون البوت نفسه هو العضو المضاف.
    // بقية أحداث المجموعة والأعضاء تستمر بشكل طبيعي.
    const addedParticipants = event.logMessageData?.addedParticipants;
    const botWasAdded = event.logMessageType === "log:subscribe" &&
      Array.isArray(addedParticipants) &&
      addedParticipants.some(person => String(
        person?.userFbId ?? person?.userID ?? person?.id ?? ""
      ) === String(BOT_ID));

    if (botWasAdded) {
      // شغّل معالج join فقط لتسجيل المجموعة وضبط الكنيات، بلا رسائل ترحيب.
      try {
        if (typeof events.join === "function") {
          events.join(api, event, config, loadData, saveData, automicTimers, BOT_ID, startTime);
        }
      } catch (eventError) {
        console.log("SHADOW JOIN HANDLER ERROR:", eventError?.message || eventError);
      }
    } else {
      for (const e in events) {
        try {
          events[e](api, event, config, loadData, saveData, automicTimers, BOT_ID, startTime);
        } catch (eventError) {
          console.log(
            `SHADOW EVENT HANDLER ERROR [${e}]:`,
            eventError?.message || eventError
          );
        }
      }
    }

    if (["message", "message_reply"].includes(event.type)) {
      try {
        await messageActivity.record(event, (threadID, messageEvent) => {
          const sender = String(messageEvent.senderID || "");
          if (!sender || sender === String(BOT_ID)) return false;
          if (messageEvent.isGroup === false) return false;
          return threadID !== sender;
        });
      } catch (activityError) {
        console.log("خطأ في عداد رسائل المجموعة:", activityError?.message || activityError);
      }
    }

    if (event.body && ["message", "message_reply"].includes(event.type)) {
      try {
        autoDownload(api, event, BOT_ID);
      } catch (downloadError) {
        console.log("QUASAR AUTO DOWNLOAD ERROR:", downloadError?.message || downloadError);
      }
    }

    if (!event.body || !["message", "message_reply"].includes(event.type)) return;

    const data = loadData() || {};
    const PREFIX = data.prefix || "!";
    const body = String(event.body).trim();
    const senderID = String(event.senderID || "");

    // Developer-only special messages
    const developerIdsForReactions = new Set(
      [...(Array.isArray(config.DEV_IDS) ? config.DEV_IDS : []), config.DEV_ID]
        .filter(Boolean)
        .map(String)
    );

    if (developerIdsForReactions.has(senderID)) {
      if (body === "._.") {
        try {
          await sendMessageAsync(
            api,
            "يا مطوري العظيم، أنت أكثر ما أحب ❤️",
            event.threadID
          );
        } catch (e) {
          console.log("تعذر إرسال رسالة المطور:", e.message);
        }
        return;
      }

      if (body === "مح") {
        try {
          if (!event.messageID) {
            console.log("تعذر التفاعل: معرّف الرسالة غير موجود.");
            return;
          }

          if (typeof api.setMessageReactionMqtt !== "function") {
            console.log("دالة التفاعل غير متاحة في API.");
            return;
          }

          await api.setMessageReactionMqtt(
            "❤️",
            String(event.messageID),
            String(event.threadID)
          );
        } catch (e) {
          console.log("تعذر وضع تفاعل المطور:", e.message);
        }
        return;
      }
    }

    let cmd = null, args = [];

    if (body.startsWith(PREFIX)) {
      args = body.slice(PREFIX.length).trim().split(/\s+/);
      cmd = args[0].toLowerCase();
    } else if (data.freePrefix) {
      args = body.trim().split(/\s+/);
      cmd = args[0].toLowerCase();
    }

    const rawCommandLine = body.startsWith(PREFIX)
      ? body.slice(PREFIX.length)
      : body;
    const rawCommandMatch = rawCommandLine.match(/^\s*\S+(?:\s+([\s\S]*))?$/);
    args.rawText = rawCommandMatch ? (rawCommandMatch[1] || "") : "";

    if (!cmd) return;

    let customCommands = {};
    try {
      customCommands = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, "utf8"));
      if (!customCommands || typeof customCommands !== "object" || Array.isArray(customCommands)) {
        customCommands = {};
      }
    } catch {}

    const customCommand = customCommands[cmd];
    const hasCustomCommand = !commands[cmd] &&
      customCommand &&
      customCommand.enabled === true &&
      (typeof customCommand.code === "string" ||
       typeof customCommand.reply === "string");

    if (!commands[cmd] && !hasCustomCommand) return;

    stats.recordCommand(cmd, senderID, event.threadID);
    let liveConfig = {};
    try {
      liveConfig = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")
      );
    } catch {
      liveConfig = config;
    }

    const developerIds = (
      Array.isArray(liveConfig.DEV_IDS) && liveConfig.DEV_IDS.length
        ? liveConfig.DEV_IDS
        : [liveConfig.DEV_ID || config.DEV_ID]
    ).map(String);
    const isDeveloper = developerIds.includes(senderID);

    const publicMode = data.publicMode === true;

    if (!canExecuteCommand({ cmd, isDeveloper, publicMode })) {
      stats.recordUnauthorized(cmd);
      return;
    }

    try {
      if (typeof api.sendTypingIndicator === "function") {
        await api.sendTypingIndicator(String(event.threadID), true, {
          duration: 3000,
          autoStop: true
        });
      } else {
        console.log("مؤشر الكتابة غير متاح في API.");
      }
    } catch (typingError) {
      console.log("تعذر إظهار مؤشر الكتابة:", typingError?.message || typingError);
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    if (hasCustomCommand) {
      try {
        if (typeof customCommand.code === "string" && customCommand.code.trim()) {
          const customFn = new Function("return (" + customCommand.code + ")")();

          if (typeof customFn !== "function") {
            throw new Error("كود الأمر يجب أن يكون دالة JavaScript");
          }

          const result = customFn(
            api, event, args, startTime,
            loadData, saveData, automicTimers,
            config, hostingInfo, botSentMessages, BOT_ID
          );

          if (result?.catch) {
            result.catch(e => {
              stats.recordCommandError(cmd);
              console.log("خطأ في الأمر المخصص:", e.message);
            });
          }
        } else if (typeof customCommand.reply === "string") {
          api.sendMessage(customCommand.reply, event.threadID);
        }
      } catch (e) {
        stats.recordCommandError(cmd);
        console.log("خطأ في الأمر المخصص:", e.message);
      }
      return;
    }

    try {
      const result = commands[cmd](
        api, event, args, startTime,
        loadData, saveData, automicTimers,
        config, hostingInfo, botSentMessages, BOT_ID,
        Object.keys(commands),
        Object.keys(customCommands).filter(name => {
          const c = customCommands[name];
          return !commands[name] && c && c.enabled === true &&
            (typeof c.code === "string" || typeof c.reply === "string");
        }),
        commands,
        { isDeveloper }
      );
      if (result?.catch) result.catch(e => {
        stats.recordCommandError(cmd);
        console.log("خطأ:", e.message);
      });
    } catch (e) {
      stats.recordCommandError(cmd);
      console.log("خطأ:", e.message);
    }
  });
});
