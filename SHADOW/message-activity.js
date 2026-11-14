"use strict";

function createMessageActivity({ developerIds, react, limit = 120 }) {
  const developers = new Set((developerIds || []).map(String));
  const groups = new Map();

  async function record(event, isGroup) {
    if (!event || !["message", "message_reply"].includes(event.type)) return false;

    const threadID = String(event.threadID || "");
    const senderID = String(event.senderID || "");
    const messageID = String(event.messageID || "");

    if (!threadID || !messageID || !isGroup(threadID, event)) return false;
    if (!senderID) return false;

    let state = groups.get(threadID);
    if (!state) {
      state = { count: 0, latestDeveloperMessageID: null };
      groups.set(threadID, state);
    }

    if (developers.has(senderID)) {
      state.latestDeveloperMessageID = messageID;
    }

    state.count++;

    if (state.count < limit) return false;

    state.count = 0;

    if (!state.latestDeveloperMessageID) return false;

    const targetID = state.latestDeveloperMessageID;

    try {
      await react(targetID, threadID);
      return true;
    } catch (error) {
      console.log("تعذر وضع قلب المطور:", error?.message || error);
      return false;
    }
  }

  return { record };
}

module.exports = { createMessageActivity };
