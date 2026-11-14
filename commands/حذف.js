"use strict";

module.exports = async (
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
  BOT_ID
) => {
  const threadID = event && event.threadID;
  const reply = event && event.messageReply;

  const botID =
    BOT_ID ||
    (typeof api.getCurrentUserID === "function"
      ? api.getCurrentUserID()
      : null);

  if (!threadID || !reply || !reply.messageID) {
    console.log("[حذف] يجب الرد على رسالة البوت أولًا.");
    return false;
  }

  if (
    !botID ||
    !reply.senderID ||
    String(reply.senderID) !== String(botID)
  ) {
    console.log("[حذف] الرسالة ليست مرسلة من البوت.");
    return false;
  }

  const replyThreadID = reply.threadID || reply.thread_id;

  if (
    replyThreadID &&
    String(replyThreadID) !== String(threadID)
  ) {
    console.log("[حذف] الرسالة لا تتبع هذه المحادثة.");
    return false;
  }

  try {
    await api.unsendMessage(String(reply.messageID), String(threadID));

    if (Array.isArray(botSentMessages?.[threadID])) {
      botSentMessages[threadID] =
        botSentMessages[threadID].filter(
          id => String(id) !== String(reply.messageID)
        );
    }

    console.log("[حذف] تم حذف الرسالة المستهدفة:", reply.messageID);
    return true;
  } catch (error) {
    console.error("[حذف] فشل حذف الرسالة:", error);
    return false;
  }
};

module.exports.aliases = ["delete", "unsend", "سحب", "حذف_رسالة"];
