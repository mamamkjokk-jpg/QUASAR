
"use strict";

const MAX_LIST = 50;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 200;

const SWEAR_WORDS = [
  "كلب", "حمار", "غبي", "احمق", "أحمق", "ابن", "بنت", "عاهرة", "زبالة", "خنزير",
  "قحبة", "شرموطة", "متناك", "منيوك", "مجنون", "بليد", "تافه", "وسخ", "قذر", "لعين",
  "ملعون", "حقير", "كس", "زب", "طيز", "خول", "مخنث", "شاذ"
];

const DEVELOPER_ONLY_COMMANDS = new Set([
  "محرك", "بيس",
  "setbio", "بايو", "bio", "changebio", "botbio",
  "صورة", "avatar", "changeavatar", "botavatar",
  "command", "cmd"
]);

const controlStates = new Map();

function censorName(name) {
  if (name == null) return "";
  let result = String(name);
  for (const word of SWEAR_WORDS) {
    result = result.replace(
      new RegExp(escapeRegExp(word), "giu"),
      "*".repeat(word.length)
    );
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stateKey(senderID, originThreadID) {
  return `${String(senderID)}:${String(originThreadID)}`;
}

function saveState(key, value) {
  controlStates.delete(key);
  controlStates.set(key, { ...value, updatedAt: Date.now() });

  for (const [oldKey, oldValue] of controlStates) {
    if (Date.now() - oldValue.updatedAt > STATE_TTL_MS) {
      controlStates.delete(oldKey);
    }
  }

  while (controlStates.size > MAX_STATES) {
    controlStates.delete(controlStates.keys().next().value);
  }
}

function getState(key) {
  const state = controlStates.get(key);
  if (!state) return null;

  if (Date.now() - state.updatedAt > STATE_TTL_MS) {
    controlStates.delete(key);
    return null;
  }

  saveState(key, state);
  return controlStates.get(key);
}

function getThreadName(thread) {
  const fallback = thread.isGroup ? "مجموعة" : "محادثة خاصة";
  return censorName(thread.name || thread.threadName || fallback);
}

function getPrefix(loadData) {
  try {
    const data = loadData?.() || {};
    return String(data.prefix || "!");
  } catch {
    return "!";
  }
}

function parseRawText(args) {
  if (typeof args?.rawText === "string") {
    return args.rawText.trim();
  }
  return Array.isArray(args) ? args.slice(1).join(" ").trim() : "";
}

function makeThreadEntry(thread, section) {
  if (!thread || thread.threadID == null) return null;

  return {
    threadID: String(thread.threadID),
    name: getThreadName(thread),
    isGroup: Boolean(thread.isGroup),
    section
  };
}

function buildThreadListMessage(inboxThreads, pendingThreads) {
  const threads = [];
  const lines = ["━━━━━━ 📬 المحادثات والخاص ━━━━━━"];

  for (const [label, list, section] of [
    ["لا توجد محادثات.", inboxThreads, "inbox"],
    ["لا توجد طلبات.", pendingThreads, "pending"]
  ]) {
    if (section === "pending") {
      lines.push("", "━━━━━━ 📨 طلبات المراسلة ━━━━━━");
    }

    if (!list.length) {
      lines.push(`  ${label}`);
      continue;
    }

    for (const thread of list) {
      const entry = makeThreadEntry(thread, section);

      if (
        !entry ||
        threads.some(item => item.threadID === entry.threadID)
      ) continue;

      const icon = entry.isGroup ? "👥" : "👤";
      const number = threads.length + 1;

      lines.push(
        `${number}. ${icon} ${section === "pending" ? "[طلب] " : ""}${entry.name}`
      );
      lines.push(`    🆔 ${entry.threadID}`);

      threads.push(entry);
    }
  }

  lines.push("", "━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("اكتب رقم المحادثة بعد الأمر، مثال: !التحكم 2");
  lines.push("بعد الاختيار: !التحكم معلومات أو !التحكم ارسال مرحبًا");

  return { text: lines.join("\n"), threads };
}

function getCommandNames(commands) {
  if (!commands || typeof commands !== "object") return [];

  return Object.keys(commands).sort(
    (a, b) => a.localeCompare(b, "ar")
  );
}

function isDeveloper(senderID, config) {
  const ids = [
    ...(Array.isArray(config?.DEV_IDS) ? config.DEV_IDS : []),
    config?.DEV_ID
  ].filter(Boolean).map(String);

  return ids.includes(String(senderID));
}

async function send(api, message, threadID) {
  return api.sendMessage(
    String(message),
    String(threadID)
  );
}

module.exports = async function (
  api,
  event,
  args,
  startTime,
  loadData,
  saveData,
  automicTimers,
  config,
  hostingInfo,
  botSentMessages,
  BOT_ID,
  builtInCommandNames = [],
  customCommandNames = [],
  commands = {}
) {
  const originThreadID = String(event?.threadID || "");
  const senderID = String(event?.senderID || "");
  const messageID = event?.messageID == null
    ? undefined
    : String(event.messageID);

  const key = stateKey(senderID, originThreadID);
  const rawText = parseRawText(args);
  const prefix = getPrefix(loadData);

  if (!originThreadID || !senderID) {
    return send(
      api,
      "تعذر تحديد صاحب الأمر أو المحادثة الحالية.",
      originThreadID,
      messageID
    );
  }

  if (!rawText || /^(قائمة|list)$/i.test(rawText)) {
    let inboxThreads = [];
    let pendingThreads = [];

    const { getThreadListSafe } = require("../SHADOW/thread-info-guard");

    try {
      inboxThreads =
        (await getThreadListSafe(api, MAX_LIST, null, ["INBOX"])) || [];

      if (!Array.isArray(inboxThreads)) inboxThreads = [];
    } catch (error) {
      return send(
        api,
        `تعذر جلب المحادثات: ${error?.message || error}`,
        originThreadID,
        messageID
      );
    }

    try {
      pendingThreads =
        (await getThreadListSafe(
          api,
          MAX_LIST,
          null,
          ["PENDING", "OTHER"]
        )) || [];

      if (!Array.isArray(pendingThreads)) pendingThreads = [];
    } catch {
      pendingThreads = [];
    }

    const result = buildThreadListMessage(
      inboxThreads,
      pendingThreads
    );

    if (!result.threads.length) {
      controlStates.delete(key);

      return send(
        api,
        "❌ لا توجد محادثات أو طلبات مراسلة حالياً.",
        originThreadID,
        messageID
      );
    }

    saveState(key, {
      threads: result.threads,
      selected: null
    });

    return send(
      api,
      result.text,
      originThreadID,
      messageID
    );
  }

  const parts = rawText.split(/\s+/);
  const first = String(parts[0] || "").toLowerCase();
  const state = getState(key);

  if (
    /^\d+$/.test(first) ||
    ["اختيار", "select"].includes(first)
  ) {
    const numberText = /^\d+$/.test(first)
      ? first
      : parts[1];

    const number = Number.parseInt(numberText, 10);

    if (!state?.threads?.length) {
      return send(
        api,
        `انتهت صلاحية القائمة. افتحها أولاً بالأمر: ${prefix}التحكم`,
        originThreadID,
        messageID
      );
    }

    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > state.threads.length
    ) {
      return send(
        api,
        `رقم غير صحيح. اختر رقمًا من 1 إلى ${state.threads.length}.`,
        originThreadID,
        messageID
      );
    }

    const selected = state.threads[number - 1];

    saveState(key, {
      ...state,
      selected,
      threads: state.threads
    });

    const commandNames = getCommandNames(commands);

    const lines = [
      `📌 ${selected.name}`,
      `🆔 ${selected.threadID}`,
      selected.isGroup
        ? "👥 مجموعة"
        : "👤 محادثة خاصة / شخص"
    ];

    if (selected.section === "pending") {
      lines.push("⏳ طلب مراسلة");
    }

    lines.push(
      "",
      "━━━━━━ أوامر التحكم ━━━━━━",
      `• ${prefix}التحكم ارسال [رسالة]`,
      `• ${prefix}التحكم معلومات`,
      selected.section === "pending"
        ? `• ${prefix}التحكم قبول`
        : null,
      `• ${prefix}التحكم تنفيذ [اسم الأمر] [وسائط]`,
      "",
      "━━━━━━ أوامر البوت ━━━━━━",
      commandNames.length
        ? commandNames
            .map((name, index) => `${index + 1}. ${prefix}${name}`)
            .join("\n")
        : "لا توجد أوامر محملة.",
      "",
      `لإعادة عرض المحادثات: ${prefix}التحكم قائمة`
    );

    return send(
      api,
      lines.filter(Boolean).join("\n"),
      originThreadID,
      messageID
    );
  }

  if (!state?.selected) {
    return send(
      api,
      `اختر محادثة أولاً. افتح القائمة بالأمر: ${prefix}التحكم`,
      originThreadID,
      messageID
    );
  }

  const selected = state.selected;
  const rest = rawText.slice(parts[0].length).trim();

  if (["ارسال", "إرسال", "send"].includes(first)) {
    const message = rest
      .replace(/^(ارسال|إرسال|send)\s*/i, "")
      .trim();

    if (!message) {
      return send(
        api,
        `اكتب الرسالة بعد الأمر: ${prefix}التحكم ارسال مرحبًا`,
        originThreadID,
        messageID
      );
    }

    try {
      await send(api, message, selected.threadID);

      return send(
        api,
        `✅ أُرسلت الرسالة إلى: ${selected.name}`,
        originThreadID,
        messageID
      );
    } catch (error) {
      return send(
        api,
        `❌ فشل الإرسال: ${error?.message || error}`,
        originThreadID,
        messageID
      );
    }
  }

  if (
    ["قبول", "accept"].includes(first) &&
    selected.section === "pending"
  ) {
    const welcome = rest
      .replace(/^(قبول|accept)\s*/i, "")
      .trim() || "مرحباً! 👋 تم الرد على طلب مراسلتك.";

    try {
      await send(api, welcome, selected.threadID);

      return send(
        api,
        `✅ أُرسلت رسالة إلى طلب المراسلة: ${selected.name}`,
        originThreadID,
        messageID
      );
    } catch (error) {
      return send(
        api,
        `❌ تعذر إرسال الرسالة إلى الطلب: ${error?.message || error}`,
        originThreadID,
        messageID
      );
    }
  }

  if (["معلومات", "info"].includes(first)) {
    try {
      const { getThreadInfoSafe } =
        require("../SHADOW/thread-info-guard");

      const info = await getThreadInfoSafe(
        api,
        selected.threadID
      );

      const lines = [
        `📌 ${censorName(info.threadName || selected.name)}`,
        `🆔 ${selected.threadID}`
      ];

      if (Array.isArray(info.participantIDs)) {
        lines.push(`👥 الأعضاء: ${info.participantIDs.length}`);
      }

      if (Array.isArray(info.adminIDs)) {
        lines.push(`🔑 عدد الأدمن: ${info.adminIDs.length}`);
      }

      if (
        info.nicknames &&
        typeof info.nicknames === "object"
      ) {
        const nicknameCount = Object.keys(info.nicknames).length;

        if (nicknameCount) {
          lines.push(`📝 ألقاب: ${nicknameCount} عضو`);
        }
      }

      return send(
        api,
        lines.join("\n"),
        originThreadID,
        messageID
      );
    } catch (error) {
      return send(
        api,
        `❌ فشل جلب المعلومات: ${error?.message || error}`,
        originThreadID,
        messageID
      );
    }
  }

  if (["تنفيذ", "نفذ", "run"].includes(first)) {
    const commandLine = rest
      .replace(/^(تنفيذ|نفذ|run)\s*/i, "")
      .trim();

    if (!commandLine) {
      return send(
        api,
        `اكتب اسم الأمر ووسائطه، مثال: ${prefix}التحكم تنفيذ tag all`,
        originThreadID,
        messageID
      );
    }

    const commandParts = commandLine.split(/\s+/);

    const commandName = String(commandParts[0] || "")
      .replace(/^\//, "")
      .toLowerCase();

    const commandArgs = commandParts.slice();

    commandArgs.rawText = commandLine
      .slice(commandParts[0].length)
      .trim();

    const targetCommand = commands[commandName];

    if (
      !targetCommand ||
      typeof targetCommand !== "function"
    ) {
      return send(
        api,
        `❌ الأمر "${commandName}" غير موجود أو غير محمّل.`,
        originThreadID,
        messageID
      );
    }

    if (commandName === "التحكم") {
      return send(
        api,
        "❌ لا يمكن تشغيل لوحة التحكم داخل نفسها.",
        originThreadID,
        messageID
      );
    }

    if (
      DEVELOPER_ONLY_COMMANDS.has(commandName) &&
      !isDeveloper(senderID, config)
    ) {
      return send(
        api,
        "⛔ هذا الأمر مخصص للمطور ولا يمكن تشغيله عن بُعد من حساب أدمن.",
        originThreadID,
        messageID
      );
    }

    const targetBody = `${prefix}${commandLine}`;

    const fakeEvent = {
      ...event,
      threadID: selected.threadID,
      messageID: messageID || event.messageID,
      senderID,
      body: targetBody,
      isGroup: selected.isGroup,
      type: "message",
      attachments: [],
      mentions: {},
      messageReply: null
    };

    try {
      await Promise.resolve(
        targetCommand(
          api,
          fakeEvent,
          commandArgs,
          startTime,
          loadData,
          saveData,
          automicTimers,
          config,
          hostingInfo,
          botSentMessages,
          BOT_ID,
          builtInCommandNames,
          customCommandNames,
          commands
        )
      );

      return send(
        api,
        `✅ تم تمرير الأمر "${commandName}" إلى محادثة: ${selected.name}`,
        originThreadID,
        messageID
      );
    } catch (error) {
      return send(
        api,
        `❌ خطأ أثناء تنفيذ "${commandName}": ${error?.message || error}`,
        originThreadID,
        messageID
      );
    }
  }

  return send(
    api,
    `❌ خيار غير معروف. استخدم: ${prefix}التحكم ارسال أو معلومات أو تنفيذ.`,
    originThreadID,
    messageID
  );
};

module.exports.aliases = ["لوحة", "تحكم"];
